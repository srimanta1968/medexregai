import { projectHeader } from '../records/RecordService';
import { renderDocx } from '../records/docxBlocks';
import { Block } from '../trust/pdf';
import { fdaLetterService, LetterDetail } from './FdaLetterService';

/**
 * F5.1 Word response skeleton (FR-14.23; UI 2.0 §7.1 "Export response skeleton (Word)"): one
 * heading per deficiency in FDA's order, FDA's request quoted as on the letter, an empty
 * response for the consultant to write, and the client files and drafted statements the
 * deficiency is linked to as a starting point. Nothing is answered for the consultant: the
 * response is theirs to write, check, sign and send. MedexRegAI never files with FDA.
 */

const KIND_TITLE: Record<LetterDetail['kind'], string> = {
  ai_request: 'Response to FDA Additional Information Request',
  rta_hold: 'Response to FDA Refuse to Accept (RTA) Hold',
};

const safeName = (s: string): string => s.replace(/[^A-Za-z0-9 ()&,.-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

export async function responseSkeleton(orgId: string, letterId: string): Promise<{ fileName: string; bytes: Buffer }> {
  const letter = await fdaLetterService.get(orgId, letterId);
  const h = await projectHeader(orgId, letter.projectId);
  const blocks: Block[] = [
    { kind: 'title', text: KIND_TITLE[letter.kind] },
    { kind: 'subtitle', text: `${h.deviceName} · ${h.clientName}` },
    {
      kind: 'fields',
      rows: [
        ['FDA reference', letter.fdaReference ?? '[enter the submission number]'],
        ['Letter date', letter.issuedOn],
        [
          'Response due',
          letter.kind === 'ai_request'
            ? `${letter.dueOn} (FDA: a complete response within 180 calendar days of the date of the AI request; no extensions beyond 180 days)`
            : `${letter.dueOn} (FDA: 180 calendar days to fully address the deficiencies cited in the RTA hold)`,
        ],
        ['Deficiencies', String(letter.deficiencies.length)],
      ],
    },
    {
      kind: 'note',
      text: 'Draft skeleton prepared in MedexRegAI from the letter as logged. FDA’s requests are quoted as entered; check them against the letter. The responses are to be written, checked and signed by the consultant.',
    },
  ];
  for (const d of letter.deficiencies) {
    blocks.push({ kind: 'h2', text: `Deficiency ${d.number}${d.sectionTitle ? ` · ${d.sectionTitle}` : ''}` });
    blocks.push({ kind: 'h3', text: 'FDA’s request' });
    for (const para of d.fdaText.split(/\n{2,}/)) if (para.trim()) blocks.push({ kind: 'p', text: para.trim() });
    blocks.push({ kind: 'h3', text: 'Response' });
    blocks.push({ kind: 'p', text: '[Response to be written by the consultant.]' });
    const evidence = [...d.files.map((f) => `File: ${f.name}`), ...d.statements.map((s) => `Drafted statement: ${s.text}`)];
    if (evidence.length) {
      blocks.push({ kind: 'h3', text: 'Linked evidence (for reference; attach or cite as needed)' });
      blocks.push({ kind: 'bullets', items: evidence });
    }
  }
  const bytes = await renderDocx({ title: KIND_TITLE[letter.kind], footer: `${h.projectName} · response skeleton`, createdAt: new Date(), blocks });
  const ref = letter.fdaReference ? ` ${safeName(letter.fdaReference)}` : '';
  return { fileName: `Response skeleton${ref} ${letter.issuedOn}.docx`, bytes };
}
