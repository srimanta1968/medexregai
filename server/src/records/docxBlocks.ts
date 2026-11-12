import JSZip from 'jszip';
import { xmlText } from '../drafting/docxWriter';
import { Block } from '../trust/pdf';

/**
 * Render the same blocks the PDF writer takes (trust/pdf.ts) as a Word document, so a dated
 * record (F3.4) can be handed to an eQMS in either format with the same content.
 * Plain WordprocessingML: headings, paragraphs, bullets, bordered tables, a footer line.
 */

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const run = (text: string, props = ''): string => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlText(text)}</w:t></w:r>`;
const para = (body: string, style?: string): string => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${body}</w:p>`;
const TABLE_WIDTH = 9360; // twips: 6.5 in of a US Letter page with 1 in margins

function table(header: string[] | null, rows: string[][], weights: number[]): string {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const widths = weights.map((w) => Math.round((w / sum) * TABLE_WIDTH));
  const cell = (text: string, width: number, bold: boolean) =>
    `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>${para(run(text, bold ? '<w:b/>' : ''), 'TableText')}</w:tc>`;
  const row = (cells: string[], bold: boolean) => `<w:tr>${cells.map((c, i) => cell(c, widths[i] ?? widths[widths.length - 1], bold)).join('')}</w:tr>`;
  const border = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((b) => `<w:${b} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="${TABLE_WIDTH}" w:type="dxa"/><w:tblBorders>${border}</w:tblBorders></w:tblPr><w:tblGrid>${widths
    .map((w) => `<w:gridCol w:w="${w}"/>`)
    .join('')}</w:tblGrid>${header ? row(header, true) : ''}${rows.map((r) => row(r, false)).join('')}</w:tbl>${para('')}`;
}

function block(b: Block): string {
  switch (b.kind) {
    case 'title':
      return para(run(b.text), 'Title');
    case 'subtitle':
      return para(run(b.text), 'Subtitle');
    case 'h2':
      return para(run(b.text), 'Heading1');
    case 'h3':
      return para(run(b.text), 'Heading2');
    case 'p':
      return para(run(b.text));
    case 'note':
      return para(run(b.text, '<w:i/><w:color w:val="595959"/>'));
    case 'bullets':
      return b.items.map((i) => para(run(`• ${i}`))).join('');
    case 'table':
      return table(
        b.columns.map((c) => c.label),
        b.rows,
        b.columns.map((c) => c.width),
      );
    case 'fields':
      return table(null, b.rows.map(([k, v]) => [k, v]), [1, 2.5]);
    default:
      return '';
  }
}

export async function renderDocx(doc: { title: string; footer: string; createdAt: Date; blocks: Block[] }): Promise<Buffer> {
  const zip = new JSZip();
  const part = (name: string, xml: string): void => void zip.file(name, xml, { createFolders: false });
  const date = doc.createdAt.toISOString().replace(/\.\d{3}Z$/, 'Z');
  part(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
  );
  part(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
  );
  part(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`,
  );
  part(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${doc.blocks.map(block).join('')}<w:sectPr><w:footerReference w:type="default" r:id="rId2"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  );
  part(
    'word/footer1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="${W}">${para(run(doc.footer, '<w:sz w:val="16"/><w:color w:val="666666"/>'))}</w:ftr>`,
  );
  part(
    'word/styles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="21"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:rPr><w:color w:val="595959"/><w:sz w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:sz w:val="18"/></w:rPr></w:style></w:styles>`,
  );
  part(
    'docProps/core.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlText(doc.title)}</dc:title><dc:creator>MedexRegAI</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${date}</dcterms:created></cp:coreProperties>`,
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
