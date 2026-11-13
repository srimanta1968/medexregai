import { projectHeader } from '../records/RecordService';
import { renderDocx } from '../records/docxBlocks';
import { Cell as XCell, writeXlsx } from '../submission/xlsxWriter';
import { Block } from '../trust/pdf';
import { Cell, seComparisonService, SeRow } from './SeComparisonService';

/**
 * F5.2 SE comparison export (UI 2.0 §7.2 "exports to Word and Excel"): the table as the consultant
 * left it, every cell with its sources (client file and location, the predicate's 510(k) summary
 * page, or the FDA database record). Word for the submission draft; Excel for working with the
 * rows. MedexRegAI does not decide substantial equivalence: rows still marked 'review' say so.
 */

const COMPARISON_LABEL: Record<SeRow['comparison'], string> = { same: 'Same', different: 'Different', review: 'To review' };

/** "label [marker]; ..." for a cell's sources. */
export const sources = (c: Cell): string => c.citations.map((x) => (x.marker ? `${x.label} ${x.marker}` : x.label)).join('; ') || 'No source found';
const safe = (s: string): string => s.replace(/[^A-Za-z0-9 ()&,.-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

export async function exportSeComparison(orgId: string, id: string, format: 'docx' | 'xlsx'): Promise<{ fileName: string; contentType: string; bytes: Buffer }> {
  const c = await seComparisonService.get(orgId, id);
  const h = await projectHeader(orgId, c.projectId);
  const predicate = `${c.predicateKNumber}${c.predicateDeviceName ? ` ${c.predicateDeviceName}` : ''}`;
  const title = `Substantial equivalence comparison: ${h.deviceName} and ${c.predicateKNumber}`;
  const base = `SE comparison ${safe(h.deviceName)} vs ${c.predicateKNumber}`;
  const toReview = c.rows.filter((r) => r.comparison === 'review').length;
  const status = toReview ? `${toReview} of ${c.rows.length} rows still to review` : 'Every row reviewed';

  if (format === 'xlsx') {
    const rows: XCell[][] = c.rows.map((r) => [
      r.attribute,
      r.subject.text || null,
      sources(r.subject),
      r.predicate.text || null,
      sources(r.predicate),
      COMPARISON_LABEL[r.comparison],
      r.note,
      r.edited ? 'Yes' : 'No',
    ]);
    const bytes = await writeXlsx(
      [
        {
          name: 'SE comparison',
          preamble: [[title], [`Subject: ${h.deviceName} (${h.clientName}) · Predicate: ${predicate}${c.predicateApplicant ? `, ${c.predicateApplicant}` : ''}`], [status]],
          header: ['Attribute', 'Subject device', 'Subject source', 'Predicate device', 'Predicate source', 'Comparison', 'Note', 'Edited by consultant'],
          rows,
          widths: [26, 60, 40, 60, 40, 14, 40, 12],
        },
      ],
      title,
    );
    return { fileName: `${base}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes };
  }

  const blocks: Block[] = [
    { kind: 'title', text: 'Substantial equivalence comparison' },
    { kind: 'subtitle', text: `${h.deviceName} · ${h.clientName}` },
    {
      kind: 'fields',
      rows: [
        ['Subject device', h.deviceName],
        ['Predicate device', `${predicate}${c.predicateApplicant ? ` (${c.predicateApplicant})` : ''}`],
        ['Status', status],
      ],
    },
    {
      kind: 'note',
      text: 'Draft prepared in MedexRegAI. Each cell is quoted from the cited source; the comparison column is the consultant’s. MedexRegAI does not determine substantial equivalence.',
    },
    {
      kind: 'table',
      columns: [
        { label: 'Attribute', width: 18 },
        { label: 'Subject device', width: 34 },
        { label: 'Predicate device', width: 34 },
        { label: 'Comparison', width: 14 },
      ],
      rows: c.rows.map((r) => [r.attribute, r.subject.text || '—', r.predicate.text || '—', COMPARISON_LABEL[r.comparison]]),
    },
    { kind: 'h2', text: 'Sources and notes' },
  ];
  for (const r of c.rows) {
    blocks.push({ kind: 'h3', text: r.attribute });
    blocks.push({ kind: 'bullets', items: [`Subject: ${sources(r.subject)}`, `Predicate: ${sources(r.predicate)}`, ...(r.note ? [`Note: ${r.note}`] : [])] });
  }
  const bytes = await renderDocx({ title, footer: `${h.projectName} · SE comparison`, createdAt: new Date(), blocks });
  return { fileName: `${base}.docx`, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes };
}
