import { deflateSync } from 'zlib';

/**
 * A small, dependency-free PDF writer for the trust pack (F2.5): headings,
 * paragraphs, bullet lists and wrapped tables on US Letter pages, set in the
 * standard Helvetica fonts (no embedded fonts, WinAnsi encoding). Text outside
 * WinAnsi is replaced with "?", so generated documents never carry hidden bytes.
 *
 * Output is deterministic for the same blocks and date, so a document's SHA-256
 * identifies its content (deletion certificates rely on that).
 */

export type Block =
  | { kind: 'title'; text: string }
  | { kind: 'subtitle'; text: string }
  | { kind: 'h2'; text: string }
  | { kind: 'h3'; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'note'; text: string }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'table'; columns: { label: string; width: number }[]; rows: string[][] }
  | { kind: 'fields'; rows: [string, string][] };

export interface PdfDocument {
  title: string;
  /** Left part of every page footer; "Page n of N" is added on the right. */
  footer: string;
  /** Recorded as the document's creation date. */
  createdAt: Date;
  blocks: Block[];
}

// Advance widths (1/1000 em) for characters 32-126, from the Adobe Helvetica and Helvetica-Bold AFM files.
const REGULAR =
  '278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500 334 260 334 584';
const BOLD =
  '278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 333 333 584 584 584 611 975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 667 778 722 667 611 722 667 944 667 667 611 333 278 333 584 556 333 556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 611 611 389 556 333 611 556 778 556 556 500 389 280 389 584';

type Font = 'regular' | 'bold';
const WIDTHS: Record<Font, number[]> = { regular: REGULAR.split(' ').map(Number), bold: BOLD.split(' ').map(Number) };

// Typographic characters mapped to their WinAnsi byte, with widths [regular, bold].
const WINANSI: Record<number, [number, number, number]> = {
  0x2018: [0x91, 222, 278],
  0x2019: [0x92, 222, 278],
  0x201c: [0x93, 333, 500],
  0x201d: [0x94, 333, 500],
  0x2022: [0x95, 350, 350],
  0x2013: [0x96, 556, 556],
  0x2014: [0x97, 1000, 1000],
  0x2026: [0x85, 1000, 1000],
  0x00a0: [0x20, 278, 278],
  0x00a7: [0xa7, 556, 556],
  0x00b0: [0xb0, 400, 400],
  0x00b1: [0xb1, 584, 584],
  0x00b5: [0xb5, 556, 611],
  0x00d7: [0xd7, 584, 584],
  0x2265: [0x3e, 584, 584],
  0x2264: [0x3c, 584, 584],
};

/** Map text to WinAnsi bytes (as a latin1 string); anything unmapped becomes "?". */
export function toWinAnsi(text: string): string {
  let out = '';
  for (const ch of text.replace(/[\t\r\n]+/g, ' ')) {
    const code = ch.codePointAt(0) ?? 63;
    if (code >= 32 && code <= 126) out += ch;
    else if (WINANSI[code]) out += String.fromCharCode(WINANSI[code][0]);
    else out += '?';
  }
  return out;
}

function charWidth(byte: number, font: Font): number {
  if (byte >= 32 && byte <= 126) return WIDTHS[font][byte - 32];
  const entry = Object.values(WINANSI).find((e) => e[0] === byte);
  return entry ? entry[font === 'regular' ? 1 : 2] : 556;
}

export function textWidth(encoded: string, font: Font, size: number): number {
  let w = 0;
  for (let i = 0; i < encoded.length; i++) w += charWidth(encoded.charCodeAt(i), font);
  return (w * size) / 1000;
}

/** Greedy word wrap of WinAnsi text; words longer than a line are broken. */
export function wrap(encoded: string, font: Font, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of encoded.split(' ').filter((w) => w.length > 0)) {
    const candidate = line ? `${line} ${word}` : word;
    if (textWidth(candidate, font, size) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = '';
    let rest = word;
    while (textWidth(rest, font, size) > maxWidth) {
      let cut = rest.length - 1;
      while (cut > 1 && textWidth(rest.slice(0, cut), font, size) > maxWidth) cut--;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function pdfString(encoded: string): string {
  return `(${encoded.replace(/[\\()]/g, (c) => '\\' + c)})`;
}

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN_X = 54;
const TOP = PAGE_H - 60;
const BOTTOM = 64;
const CONTENT_W = PAGE_W - 2 * MARGIN_X;
const n = (v: number) => (Math.round(v * 100) / 100).toString();

class Layout {
  pages: string[][] = [[]];
  y = TOP;

  private get ops(): string[] {
    return this.pages[this.pages.length - 1];
  }

  newPage(): void {
    this.pages.push([]);
    this.y = TOP;
  }

  ensure(height: number): void {
    if (this.y - height < BOTTOM && this.y < TOP) this.newPage();
  }

  text(x: number, y: number, encoded: string, font: Font, size: number, gray = 0): void {
    this.ops.push(`BT /${font === 'bold' ? 'F2' : 'F1'} ${n(size)} Tf ${n(gray)} g ${n(x)} ${n(y)} Td ${pdfString(encoded)} Tj ET`);
  }

  rule(x1: number, y1: number, x2: number, y2: number, gray = 0.8, width = 0.5): void {
    this.ops.push(`${n(gray)} G ${n(width)} w ${n(x1)} ${n(y1)} m ${n(x2)} ${n(y2)} l S`);
  }

  fill(x: number, y: number, w: number, h: number, gray: number): void {
    this.ops.push(`${n(gray)} g ${n(x)} ${n(y)} ${n(w)} ${n(h)} re f`);
  }

  /** Wrapped lines at the cursor, breaking across pages line by line. */
  lines(text: string, font: Font, size: number, leading: number, indent = 0, gray = 0): void {
    for (const line of wrap(toWinAnsi(text), font, size, CONTENT_W - indent)) {
      this.ensure(leading);
      this.y -= leading;
      this.text(MARGIN_X + indent, this.y + (leading - size) / 2, line, font, size, gray);
    }
  }

  table(columns: { label: string; width: number }[], rows: string[][], header = true): void {
    const total = columns.reduce((s, c) => s + c.width, 0);
    const widths = columns.map((c) => (c.width / total) * CONTENT_W);
    const size = 9.5;
    const leading = 12.5;
    const pad = 4;
    const cellLines = (cells: string[], font: Font) => cells.map((cell, i) => wrap(toWinAnsi(cell ?? ''), font, size, widths[i] - 2 * pad));
    const drawRow = (lines: string[][], font: Font, shade: boolean) => {
      const height = Math.max(...lines.map((l) => l.length)) * leading + 2 * pad;
      if (this.y - height < BOTTOM) {
        this.newPage();
        if (header && font === 'regular')
          drawRow(
            cellLines(
              columns.map((c) => c.label),
              'bold',
            ),
            'bold',
            true,
          );
      }
      const top = this.y;
      if (shade) this.fill(MARGIN_X, top - height, CONTENT_W, height, 0.93);
      let x = MARGIN_X;
      lines.forEach((cell, i) => {
        cell.forEach((line, j) => this.text(x + pad, top - pad - (j + 1) * leading + 3, line, font, size));
        x += widths[i];
      });
      this.y = top - height;
      this.rule(MARGIN_X, this.y, MARGIN_X + CONTENT_W, this.y);
    };
    this.ensure(40);
    if (header) {
      this.rule(MARGIN_X, this.y, MARGIN_X + CONTENT_W, this.y);
      drawRow(
        cellLines(
          columns.map((c) => c.label),
          'bold',
        ),
        'bold',
        true,
      );
    }
    for (const row of rows) drawRow(cellLines(row, 'regular'), 'regular', false);
  }
}

function layout(blocks: Block[]): string[][] {
  const l = new Layout();
  for (const b of blocks) {
    switch (b.kind) {
      case 'title':
        l.lines(b.text, 'bold', 20, 26);
        break;
      case 'subtitle':
        l.lines(b.text, 'regular', 11, 15, 0, 0.35);
        l.y -= 8;
        break;
      case 'h2':
        l.ensure(60);
        l.y -= 10;
        l.lines(b.text, 'bold', 14, 19);
        l.rule(MARGIN_X, l.y - 2, MARGIN_X + CONTENT_W, l.y - 2, 0.6, 0.75);
        l.y -= 6;
        break;
      case 'h3':
        l.ensure(40);
        l.y -= 4;
        l.lines(b.text, 'bold', 11, 16);
        break;
      case 'p':
        l.lines(b.text, 'regular', 10.5, 14.5);
        l.y -= 5;
        break;
      case 'note':
        l.lines(b.text, 'regular', 9, 12.5, 0, 0.35);
        l.y -= 5;
        break;
      case 'bullets':
        for (const item of b.items) {
          const lines = wrap(toWinAnsi(item), 'regular', 10.5, CONTENT_W - 14);
          lines.forEach((line, i) => {
            l.ensure(14.5);
            l.y -= 14.5;
            if (i === 0) l.text(MARGIN_X + 2, l.y + 2, String.fromCharCode(0x95), 'regular', 10.5);
            l.text(MARGIN_X + 14, l.y + 2, line, 'regular', 10.5);
          });
        }
        l.y -= 5;
        break;
      case 'table':
        l.table(b.columns, b.rows);
        l.y -= 10;
        break;
      case 'fields':
        l.table(
          [
            { label: '', width: 1 },
            { label: '', width: 2.4 },
          ],
          b.rows.map(([k, v]) => [k, v]),
          false,
        );
        l.y -= 10;
        break;
    }
  }
  return l.pages;
}

function pdfDate(d: Date): string {
  const p = (v: number) => String(v).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** Render the document to PDF bytes. */
export function renderPdf(doc: PdfDocument): Buffer {
  const pages = layout(doc.blocks);
  const total = pages.length;
  pages.forEach((ops, i) => {
    const footer = toWinAnsi(doc.footer);
    const pageNo = toWinAnsi(`Page ${i + 1} of ${total}`);
    ops.push(`0.6 G 0.5 w ${MARGIN_X} 48 m ${PAGE_W - MARGIN_X} 48 l S`);
    ops.push(`BT /F1 8 Tf 0.4 g ${MARGIN_X} 36 Td ${pdfString(footer)} Tj ET`);
    ops.push(`BT /F1 8 Tf 0.4 g ${n(PAGE_W - MARGIN_X - textWidth(pageNo, 'regular', 8))} 36 Td ${pdfString(pageNo)} Tj ET`);
  });

  const objects: Buffer[] = [];
  const add = (body: string | Buffer): number => {
    objects.push(typeof body === 'string' ? Buffer.from(body, 'latin1') : body);
    return objects.length;
  };
  const catalog = add('');
  const pagesObj = add('');
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const date = pdfDate(doc.createdAt);
  const info = add(`<< /Title ${pdfString(toWinAnsi(doc.title))} /Producer (MedexRegAI trust pack) /CreationDate (${date}) /ModDate (${date}) >>`);
  const pageIds: number[] = [];
  for (const ops of pages) {
    const data = deflateSync(Buffer.from(ops.join('\n'), 'latin1'));
    const content = add(
      Buffer.concat([Buffer.from(`<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]),
    );
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`, 'latin1');
  objects[pagesObj - 1] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`, 'latin1');

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = chunks[0].length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    const obj = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    chunks.push(obj);
    offset += obj.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n`, '0000000000 65535 f \n', ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${offset}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(chunks);
}
