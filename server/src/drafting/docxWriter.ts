import JSZip from 'jszip';

/**
 * F3.2 DOCX export (UI 2.0 §5.2, "The draft in Word, with sources in the margin").
 *
 *  - every statement sits inside a bookmark named mx_s_<ordinal>, so a re-imported copy
 *    can be matched statement by statement (roundTrip.ts);
 *  - every statement carries a Word comment by "MedexRegAI" naming its source(s); a
 *    statement a person wrote or edited carries "Your edit, kept as human-approved";
 *  - statements the citation gate removed appear once, as a bracketed note at the end
 *    with an "Open item" comment listing each one and why;
 *  - the draft id is stored as a custom document property (MedexRegAI.DraftId), which
 *    Word keeps on save, so an import can tell which draft the file came from.
 * Plain WordprocessingML written by hand: no template, no macros, no external parts.
 */

export const DRAFT_ID_PROPERTY = 'MedexRegAI.DraftId';
export const STATEMENT_BOOKMARK = /^mx_s_(\d+)$/;
const AUTHOR = 'MedexRegAI';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

export interface DocxStatement {
  ordinal: number;
  paragraph: number;
  kind: 'heading' | 'statement';
  text: string;
  citations: { label: string }[];
  warnings: string[];
  origin: 'generated' | 'human_edited' | 'human_added';
}

export interface DocxDraft {
  draftId: string;
  versionNo: number;
  sectionTitle: string;
  projectName: string;
  createdAt: Date;
  statements: DocxStatement[];
  removed: { text: string; reason: string }[];
}

/** XML 1.0 text: escape markup and drop characters XML cannot carry. */
export function xmlText(s: string): string {
  return (
    s
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  );
}

const run = (text: string, props = ''): string => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlText(text)}</w:t></w:r>`;
const para = (body: string, style?: string): string => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${body}</w:p>`;

class Comments {
  private items: string[] = [];
  constructor(private readonly date: string) {}
  /** Add a comment of one or more paragraphs; returns its id. */
  add(lines: string[]): number {
    const id = this.items.length;
    const body = lines.map((l) => `<w:p><w:pPr><w:pStyle w:val="CommentText"/></w:pPr>${run(l)}</w:p>`).join('');
    this.items.push(`<w:comment w:id="${id}" w:author="${AUTHOR}" w:initials="MX" w:date="${this.date}">${body}</w:comment>`);
    return id;
  }
  xml(): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:comments xmlns:w="${W}">${this.items.join('')}</w:comments>`;
  }
}

/** Text anchored to a comment, optionally inside a named bookmark. */
function anchored(text: string, commentId: number, bookmark: { id: number; name: string } | null, props = ''): string {
  return [
    bookmark ? `<w:bookmarkStart w:id="${bookmark.id}" w:name="${bookmark.name}"/>` : '',
    `<w:commentRangeStart w:id="${commentId}"/>`,
    run(text, props),
    `<w:commentRangeEnd w:id="${commentId}"/>`,
    `<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${commentId}"/></w:r>`,
    bookmark ? `<w:bookmarkEnd w:id="${bookmark.id}"/>` : '',
  ].join('');
}

function commentFor(s: DocxStatement): string[] {
  if (s.origin === 'human_added') return ['Added by you, kept as human-approved.'];
  const sources = s.citations.map((c, i) => `${AUTHOR} source${s.citations.length > 1 ? ` ${i + 1}` : ''}: ${c.label}`);
  const lines = s.origin === 'human_edited' ? ['Your edit, kept as human-approved.', ...sources.map((x) => `Originally cited: ${x}`)] : sources;
  return [...lines, ...s.warnings.map((w) => `Warning: ${w}`)];
}

export async function writeDraftDocx(d: DocxDraft): Promise<Buffer> {
  const date = d.createdAt.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const comments = new Comments(date);
  let bookmarkId = 0;
  const body: string[] = [];

  const titleComment = comments.add([
    `Draft version ${d.versionNo} of "${d.sectionTitle}" for ${d.projectName}, made by ${AUTHOR}.`,
    'Every statement carries a comment naming its source. Edit freely; when you import this file, your edits are kept as human-approved.',
  ]);
  body.push(para(anchored(d.sectionTitle, titleComment, { id: bookmarkId++, name: 'mx_title' }), 'Heading1'));

  const paragraphs = new Map<number, DocxStatement[]>();
  for (const s of [...d.statements].sort((a, b) => a.ordinal - b.ordinal)) {
    paragraphs.set(s.paragraph, [...(paragraphs.get(s.paragraph) ?? []), s]);
  }
  for (const group of paragraphs.values()) {
    const heading = group.length === 1 && group[0].kind === 'heading';
    const parts = group.map((s, i) => {
      const bookmark = { id: bookmarkId++, name: `mx_s_${s.ordinal}` };
      const inner = s.citations.length || s.origin !== 'generated' ? anchored(s.text, comments.add(commentFor(s)), bookmark) : `<w:bookmarkStart w:id="${bookmark.id}" w:name="${bookmark.name}"/>${run(s.text)}<w:bookmarkEnd w:id="${bookmark.id}"/>`;
      // The space between statements sits outside every bookmark; the importer ignores whitespace there.
      return (i > 0 ? run(' ') : '') + inner;
    });
    body.push(para(parts.join(''), heading ? 'Heading2' : undefined));
  }

  if (d.removed.length) {
    const n = d.removed.length;
    const id = comments.add([
      `Open item: ${n} statement${n === 1 ? ' was' : 's were'} removed because no source in the client files supports ${n === 1 ? 'it' : 'them'}.`,
      ...d.removed.map((r, i) => `${i + 1}. Removed: "${r.text}" (${r.reason}). Request from client?`),
    ]);
    body.push(
      para(
        anchored(`[${n} statement${n === 1 ? ' was' : 's were'} removed because no source was found. See comment.]`, id, { id: bookmarkId++, name: 'mx_removed' }, '<w:i/><w:color w:val="7F7F7F"/>'),
      ),
    );
  }

  const zip = new JSZip();
  // No folder entries: an OOXML package lists only its parts.
  const part = (name: string, xml: string): void => void zip.file(name, xml, { createFolders: false });
  part(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>`,
  );
  part(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/></Relationships>`,
  );
  part(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/></Relationships>`,
  );
  part(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  );
  part('word/comments.xml', comments.xml());
  part(
    'word/styles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="CommentText"><w:name w:val="annotation text"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="20"/></w:rPr></w:style><w:style w:type="character" w:styleId="CommentReference"><w:name w:val="annotation reference"/><w:rPr><w:sz w:val="16"/></w:rPr></w:style></w:styles>`,
  );
  part(
    'docProps/core.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlText(`${d.sectionTitle} (draft v${d.versionNo})`)}</dc:title><dc:creator>${AUTHOR}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${date}</dcterms:created></cp:coreProperties>`,
  );
  part(
    'docProps/custom.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="${DRAFT_ID_PROPERTY}"><vt:lpwstr>${xmlText(d.draftId)}</vt:lpwstr></property></Properties>`,
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** A safe download name: "<Section> draft v<n>.docx". */
export function draftFileName(sectionTitle: string, versionNo: number): string {
  const base = sectionTitle.replace(/[^A-Za-z0-9 ()&,.-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Section';
  return `${base} draft v${versionNo}.docx`;
}
