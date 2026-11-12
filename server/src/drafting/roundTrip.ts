import JSZip from 'jszip';
import { splitSentences } from '../citations/gate';
import { DRAFT_ID_PROPERTY, STATEMENT_BOOKMARK } from './docxWriter';
import type { StatementInput } from './SectionDrafter';

/**
 * F3.2 DOCX round trip: read a consultant's edited copy of an exported draft and diff it
 * against the draft it came from.
 *
 *  - text inside a statement's bookmark (mx_s_<n>) is that statement: unchanged, edited
 *    (kept as human-approved) or, when the bookmark or its text is gone, deleted;
 *  - text outside every bookmark was written by a person and is kept as human-approved;
 *    text typed straight after a sentence (Word puts it outside the bookmark) continues
 *    that sentence and counts as an edit of it;
 *  - tracked deletions (w:del, w:moveFrom) are not text; tracked insertions are;
 *  - the title (mx_title) and the removed-statements note (mx_removed) are ours, not content.
 */

export interface ReadSegment {
  /** The statement ordinal whose bookmark holds this text, or null for unbookmarked text. */
  ordinal: number | null;
  /** Our own non-statement parts (title, removed note): ignored by the diff. */
  ours: boolean;
  text: string;
}

export interface ReadDocx {
  draftId: string | null;
  paragraphs: ReadSegment[][];
  /** The file has at least one statement bookmark. */
  hasStatementBookmarks: boolean;
}

export class NotADraftDocxError extends Error {}

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITY[e.toLowerCase()] ?? whole;
  });
}

const attr = (attrs: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m ? decode(m[1]) : null;
};

/** Paragraphs of a DOCX body as runs of text labelled with the statement bookmark they sit in. */
export async function readDraftDocx(bytes: Buffer): Promise<ReadDocx> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new NotADraftDocxError('The file is not a Word document (.docx)');
  }
  const doc = zip.file('word/document.xml');
  if (!doc) throw new NotADraftDocxError('The file is not a Word document (.docx)');
  const xml = await doc.async('string');
  const custom = await zip.file('docProps/custom.xml')?.async('string');
  const idMatch = custom ? new RegExp(`name="${DRAFT_ID_PROPERTY.replace('.', '\\.')}"[^>]*>\\s*<vt:lpwstr>([^<]*)</vt:lpwstr>`).exec(custom) : null;

  const paragraphs: ReadSegment[][] = [];
  const names = new Map<string, string>(); // bookmark id -> name
  const open: string[] = []; // names of open bookmarks, innermost last
  let current: ReadSegment[] | null = null;
  let skipDepth = 0; // inside w:del / w:moveFrom
  let inText = false;
  let hasStatementBookmarks = false;

  const owner = (): { ordinal: number | null; ours: boolean } => {
    for (let i = open.length - 1; i >= 0; i--) {
      const m = STATEMENT_BOOKMARK.exec(open[i]);
      if (m) return { ordinal: Number(m[1]), ours: false };
      if (open[i] === 'mx_title' || open[i] === 'mx_removed') return { ordinal: null, ours: true };
    }
    return { ordinal: null, ours: false };
  };
  const emit = (text: string): void => {
    if (!current || skipDepth > 0 || !text) return;
    const o = owner();
    const last = current[current.length - 1];
    if (last && last.ordinal === o.ordinal && last.ours === o.ours) last.text += text;
    else current.push({ ...o, text });
  };

  const TOKEN = /<(\/?)(w:[A-Za-z]+)((?:\s[^>]*?)?)(\/?)>|([^<]+)/g;
  for (let m = TOKEN.exec(xml); m; m = TOKEN.exec(xml)) {
    const [, closing, tag, attrs, selfClosing, text] = m;
    if (text !== undefined) {
      if (inText) emit(decode(text));
      continue;
    }
    switch (tag) {
      case 'w:p':
        if (closing) {
          if (current) paragraphs.push(current);
          current = null;
        } else if (!selfClosing) current = [];
        else paragraphs.push([]);
        break;
      case 'w:t':
        inText = !closing && !selfClosing;
        break;
      case 'w:del':
      case 'w:moveFrom':
        if (!selfClosing) skipDepth += closing ? -1 : 1;
        break;
      case 'w:tab':
        if (!closing) emit('\t');
        break;
      case 'w:br':
      case 'w:cr':
        if (!closing) emit(' ');
        break;
      case 'w:bookmarkStart': {
        const id = attr(attrs, 'w:id');
        const name = attr(attrs, 'w:name');
        if (id !== null && name !== null) {
          names.set(id, name);
          open.push(name);
          if (STATEMENT_BOOKMARK.test(name)) hasStatementBookmarks = true;
        }
        break;
      }
      case 'w:bookmarkEnd': {
        const name = names.get(attr(attrs, 'w:id') ?? '');
        const i = name === undefined ? -1 : open.lastIndexOf(name);
        if (i >= 0) open.splice(i, 1);
        break;
      }
      default:
        break;
    }
  }
  return { draftId: idMatch ? idMatch[1].trim() : null, paragraphs, hasStatementBookmarks };
}

export interface BaseStatement {
  id: string;
  ordinal: number;
  kind: 'heading' | 'statement';
  text: string;
  citations: { marker: string; label: string }[];
  warnings: string[];
  origin: 'generated' | 'human_edited' | 'human_added';
  humanApproved: boolean;
  approvedBy: string | null;
}

export interface ImportSummary {
  unchanged: number;
  edited: number;
  added: number;
  deleted: string[];
}

/** Whitespace and Unicode form do not count as an edit. */
export const sameText = (a: string, b: string): boolean => norm(a) === norm(b);
const norm = (s: string): string => s.normalize('NFC').replace(/[\s ]+/g, ' ').trim();

/**
 * The statements of the imported draft, in document order, and what changed. Everything a
 * person wrote or changed is human-approved by `importerId`; untouched statements keep their
 * citations and origin.
 */
export function diffImport(base: BaseStatement[], doc: ReadDocx, importerId: string): { statements: StatementInput[]; summary: ImportSummary } {
  const byOrdinal = new Map(base.map((b) => [b.ordinal, b]));
  // Collect each statement's text (a bookmark may be split by a comment or a tracked change).
  interface Item {
    paragraph: number;
    ordinal: number | null;
    text: string;
  }
  const items: Item[] = [];
  let paragraph = -1;
  for (const segments of doc.paragraphs) {
    const content = segments.filter((s) => !s.ours && (s.ordinal !== null ? byOrdinal.has(s.ordinal) : norm(s.text) !== ''));
    if (!content.some((s) => norm(s.text) !== '' || s.ordinal !== null)) continue;
    paragraph += 1;
    for (const s of content) {
      const prev = items[items.length - 1];
      if (s.ordinal !== null) {
        const same = items.find((i) => i.ordinal === s.ordinal);
        if (same) same.text += s.text;
        else items.push({ paragraph, ordinal: s.ordinal, text: s.text });
        continue;
      }
      // Unbookmarked text right after a statement in the same paragraph that does not start a
      // new sentence continues it ("...oxide" + ", at 55 C."): an edit, not an addition.
      const text = s.text;
      if (prev && prev.paragraph === paragraph && prev.ordinal !== null && (!/[.!?]["')\]]?\s*$/.test(prev.text) || /^\s*[a-z,;:)\]]/.test(text))) {
        prev.text += text;
        continue;
      }
      if (prev && prev.paragraph === paragraph && prev.ordinal === null) prev.text += text;
      else items.push({ paragraph, ordinal: null, text });
    }
  }

  const statements: StatementInput[] = [];
  const summary: ImportSummary = { unchanged: 0, edited: 0, added: 0, deleted: [] };
  const seen = new Set<number>();
  for (const item of items) {
    if (item.ordinal === null) {
      for (const sentence of splitSentences(norm(item.text)).filter((t) => t.trim())) {
        statements.push({ paragraph: item.paragraph, kind: 'statement', text: sentence.trim(), citations: [], origin: 'human_added', humanApproved: true, approvedBy: importerId });
        summary.added += 1;
      }
      continue;
    }
    const b = byOrdinal.get(item.ordinal)!;
    const text = norm(item.text);
    if (!text) continue; // emptied in Word: deleted (counted below)
    seen.add(b.ordinal);
    if (sameText(text, b.text)) {
      statements.push({
        paragraph: item.paragraph,
        kind: b.kind,
        text: b.text,
        citations: b.citations,
        warnings: b.warnings,
        origin: b.origin,
        humanApproved: b.humanApproved,
        approvedBy: b.approvedBy,
        sourceStatementId: b.id,
      });
      summary.unchanged += 1;
    } else {
      statements.push({
        paragraph: item.paragraph,
        kind: b.kind,
        text,
        citations: b.citations,
        warnings: [],
        origin: b.origin === 'human_added' ? 'human_added' : 'human_edited',
        humanApproved: true,
        approvedBy: importerId,
        sourceStatementId: b.id,
      });
      summary.edited += 1;
    }
  }
  for (const b of base) if (!seen.has(b.ordinal)) summary.deleted.push(b.text);
  return { statements, summary };
}
