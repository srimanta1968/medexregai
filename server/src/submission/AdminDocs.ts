import { fdaClient } from '../fda/fdaService';
import { renderDocx } from '../records/docxBlocks';
import { projectHeader, ProjectHeader } from '../records/RecordService';
import { dataService } from '../services/DataService';
import { Block } from '../trust/pdf';
import { AppError, ErrorCodes } from '../utils/AppError';
import { buildSummaryTable } from './SummaryTables';

/**
 * F3.6 administrative documents of a 510(k), generated from project data:
 *  - the 510(k) Summary, following the elements of 21 CFR 807.92(a)(1)-(6) and (b);
 *  - the cover letter;
 *  - a preparation sheet for Form FDA 3601 (the Medical Device User Fee Cover Sheet). The form
 *    itself is created in FDA's online MDUFA system, which assigns the payment identification
 *    number; this sheet only gathers what that system asks for;
 *  - the Truthful and Accurate statement, in FDA's wording (21 CFR 807.87(l)).
 * Nothing is invented: what the project does not hold becomes a bracketed "[To be completed: ...]"
 * listed as an open item, and every signature, typed name and signing date is left blank for the
 * submitter to complete. FDA says the Truthful and Accurate statement must be signed by a
 * responsible person of the submitting firm, not by a consultant.
 */

export type AdminDocKind = 'summary_510k' | 'cover_letter' | 'fda_3601' | 'truthful_accurate';
export const ADMIN_DOC_KINDS: AdminDocKind[] = ['summary_510k', 'cover_letter', 'fda_3601', 'truthful_accurate'];

export const ADMIN_DOC_TITLE: Record<AdminDocKind, string> = {
  summary_510k: '510(k) Summary',
  cover_letter: 'Cover letter',
  fda_3601: 'FDA 3601 preparation sheet',
  truthful_accurate: 'Truthful and Accurate statement',
};

export interface AdminDoc {
  kind: AdminDocKind;
  title: string;
  /** What the project did not hold, as written in the document. */
  openItems: string[];
  /** Signature fields, always blank in the generated document. */
  signatureFields: string[];
  blocks: Block[];
}

/** The fields a signer completes by hand; generated documents leave every one blank. */
const SIGNATURE_FIELDS = ['Signature', 'Typed name', 'Title', 'Date'];

/** FDA's Truthful and Accurate statement (FDA, "Premarket Notification Truthful and Accurate Statement"). */
export const TRUTHFUL_AND_ACCURATE =
  'I certify that, in my capacity as {position} of {company}, I believe to the best of my knowledge, that all data and information submitted in the premarket notification are truthful and accurate and that no material fact has been omitted.';

interface Predicate {
  kNumber: string;
  deviceName: string | null;
  applicant: string | null;
  decisionDate: string | null;
}

interface Classification {
  name: string | null;
  regulationNumber: string | null;
  deviceClass: string | null;
  panel: string | null;
}

export interface AdminData {
  header: ProjectHeader;
  preparedOn: string;
  classification: Classification | null;
  predicates: Predicate[];
  sections: Record<string, string[]>;
  tests: { report: string; standards: string[]; result: string }[];
}

const SECTION_SOURCES = ['device_description', 'indications_for_use', 'predicates_se'];
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const ROMAN: Record<string, string> = { '1': 'I', '2': 'II', '3': 'III', I: 'I', II: 'II', III: 'III' };
/** FDA's device classification review panel codes. */
const PANELS: Record<string, string> = {
  AN: 'Anesthesiology', CV: 'Cardiovascular', CH: 'Clinical Chemistry', DE: 'Dental', EN: 'Ear, Nose and Throat', GU: 'Gastroenterology and Urology',
  HO: 'General Hospital', HE: 'Hematology', IM: 'Immunology', MI: 'Microbiology', NE: 'Neurology', OB: 'Obstetrics and Gynecology', OP: 'Ophthalmic',
  OR: 'Orthopedic', PA: 'Pathology', PM: 'Physical Medicine', RA: 'Radiology', SU: 'General and Plastic Surgery', TX: 'Clinical Toxicology', MG: 'Medical Genetics',
};
const deviceClass = (c: string | null | undefined): string | null => (c && ROMAN[c.trim()] ? `Class ${ROMAN[c.trim()]}` : c ?? null);
const panel = (p: string | null | undefined): string | null => (p ? (PANELS[p] ? `${PANELS[p]} (${p})` : p) : null);

/** Builds documents while collecting what had to be left to the consultant. */
class Doc {
  readonly blocks: Block[] = [];
  readonly openItems: string[] = [];

  todo(what: string): string {
    if (!this.openItems.includes(what)) this.openItems.push(what);
    return `[To be completed: ${what}]`;
  }

  or(value: string | null | undefined, what: string): string {
    return value && value.trim() ? value : this.todo(what);
  }

  add(...b: Block[]): this {
    this.blocks.push(...b);
    return this;
  }

  signature(): this {
    return this.add({ kind: 'fields', rows: SIGNATURE_FIELDS.map((f) => [f, ''] as [string, string]) });
  }
}

/** Paragraphs of the latest ready draft of each of the given sections of a project. */
async function sectionTexts(orgId: string, projectId: string): Promise<Record<string, string[]>> {
  const rows = await dataService.query<{ section_id: string; paragraph: number; text: string }>(
    { orgId },
    'draft_statements',
    `WITH latest AS (
       SELECT DISTINCT ON (d.project_section_id) d.id, ps.section_id
         FROM section_drafts d JOIN project_sections ps ON ps.id = d.project_section_id AND ps.org_id = d.org_id
        WHERE d.org_id = $1 AND ps.project_id = $2 AND d.status = 'ready' AND ps.section_id = ANY($3::varchar[])
        ORDER BY d.project_section_id, d.version_no DESC)
     SELECT l.section_id, st.paragraph, string_agg(st.text, ' ' ORDER BY st.ordinal) AS text
       FROM latest l JOIN draft_statements st ON st.draft_id = l.id AND st.org_id = $1 AND st.kind = 'statement'
      GROUP BY l.section_id, st.paragraph ORDER BY l.section_id, st.paragraph`,
    [orgId, projectId, SECTION_SOURCES],
  );
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[r.section_id] ??= []).push(r.text);
  return out;
}

/** K-numbers verified with FDA in the predicates section's latest draft (F3.5 checks). */
async function predicates(orgId: string, projectId: string): Promise<Predicate[]> {
  const rows = await dataService.query<{ k_number: string; clearance: { deviceName?: string; applicant?: string; decisionDate?: string } | null }>(
    { orgId },
    'draft_fda_checks',
    `WITH latest AS (
       SELECT DISTINCT ON (d.project_section_id) d.id
         FROM section_drafts d JOIN project_sections ps ON ps.id = d.project_section_id AND ps.org_id = d.org_id
        WHERE d.org_id = $1 AND ps.project_id = $2 AND d.status = 'ready' AND ps.section_id = 'predicates_se'
        ORDER BY d.project_section_id, d.version_no DESC)
     SELECT c.k_number, c.clearance FROM latest l JOIN draft_fda_checks c ON c.draft_id = l.id AND c.org_id = $1
      WHERE c.status = 'verified' ORDER BY c.k_number`,
    [orgId, projectId],
  );
  return rows.map((r) => ({
    kNumber: r.k_number,
    deviceName: r.clearance?.deviceName ?? null,
    applicant: r.clearance?.applicant ?? null,
    decisionDate: r.clearance?.decisionDate ?? null,
  }));
}

/** FDA's classification for the device's product code; null when unknown or the FDA service is unreachable. */
async function classification(productCode: string | null): Promise<Classification | null> {
  if (!productCode) return null;
  try {
    const p = await fdaClient().getProductCode(productCode);
    return { name: p.deviceName, regulationNumber: p.regulationNumber, deviceClass: p.deviceClass, panel: p.reviewPanel };
  } catch {
    return null;
  }
}

export async function adminData(orgId: string, projectId: string): Promise<AdminData> {
  const header = await projectHeader(orgId, projectId);
  const [cls, preds, sections, table] = await Promise.all([
    classification(header.productCode),
    predicates(orgId, projectId),
    sectionTexts(orgId, projectId),
    buildSummaryTable(orgId, projectId),
  ]);
  return {
    header,
    preparedOn: new Date().toISOString().slice(0, 10),
    classification: cls,
    predicates: preds,
    sections,
    tests: table.rows.map((r) => ({ report: r.report, standards: r.standards, result: r.result })),
  };
}

function predicateLine(p: Predicate): string {
  return [p.kNumber, p.deviceName, p.applicant, p.decisionDate ? `cleared ${p.decisionDate}` : null].filter(Boolean).join(', ');
}

function classificationRows(d: Doc, a: AdminData): [string, string][] {
  const c = a.classification;
  return [
    ['Classification name', d.or(c?.name, 'classification name')],
    ['Regulation number', c?.regulationNumber ? `21 CFR ${c.regulationNumber}` : d.todo('regulation number')],
    ['Product code', d.or(a.header.productCode, 'product code')],
    ['Device class', d.or(deviceClass(c?.deviceClass ?? a.header.deviceClass), 'device class')],
    ['Review panel', d.or(panel(c?.panel), 'review panel')],
  ];
}

function summary510k(a: AdminData): Doc {
  const d = new Doc();
  const h = a.header;
  d.add({ kind: 'title', text: '510(k) Summary' }, { kind: 'subtitle', text: `${h.deviceName} (21 CFR 807.92)` });
  d.add({ kind: 'h2', text: 'Submitter' });
  d.add({
    kind: 'fields',
    rows: [
      ['Submitter', h.clientName],
      ['Address', d.todo('submitter address')],
      ['Telephone', d.todo('submitter telephone number')],
      ['Contact person', d.todo('contact person')],
      ['Date prepared', a.preparedOn],
    ],
  });
  d.add({ kind: 'h2', text: 'Device' });
  d.add({ kind: 'fields', rows: [['Trade or proprietary name', h.deviceName], ['Common or usual name', d.todo('common or usual name')], ...classificationRows(d, a)] });
  d.add({ kind: 'h2', text: 'Predicate device' });
  if (a.predicates.length) d.add({ kind: 'bullets', items: a.predicates.map(predicateLine) });
  else d.add({ kind: 'p', text: d.todo('predicate device (no K-number in the Predicates section draft has been verified with FDA)') });
  d.add({ kind: 'h2', text: 'Device description' });
  (a.sections.device_description?.length ? a.sections.device_description : [d.todo('device description (no finished Device description draft)')]).forEach((t) => d.add({ kind: 'p', text: t }));
  d.add({ kind: 'h2', text: 'Intended use / Indications for use' });
  (a.sections.indications_for_use?.length ? a.sections.indications_for_use : [d.todo('indications for use (no finished Indications for Use draft)')]).forEach((t) => d.add({ kind: 'p', text: t }));
  d.add({ kind: 'h2', text: 'Technological characteristics compared with the predicate' });
  (a.sections.predicates_se?.length ? a.sections.predicates_se : [d.todo('technological characteristics comparison (no finished Predicates and substantial equivalence draft)')]).forEach((t) =>
    d.add({ kind: 'p', text: t }),
  );
  d.add({ kind: 'h2', text: 'Performance data' });
  d.add({ kind: 'h3', text: 'Nonclinical tests' });
  if (a.tests.length) {
    d.add({
      kind: 'table',
      columns: [
        { label: 'Test report', width: 3 },
        { label: 'Standards', width: 3 },
        { label: 'Result stated', width: 1.4 },
      ],
      rows: a.tests.map((t) => [t.report, t.standards.join('; ') || '—', t.result === 'pass' ? 'Pass' : t.result === 'fail' ? 'Fail' : 'Not stated']),
    });
  } else {
    d.add({ kind: 'p', text: d.todo('nonclinical tests (no test reports filed under a testing section)') });
  }
  d.add({ kind: 'h3', text: 'Clinical tests' }, { kind: 'p', text: d.todo('clinical tests relied on, if any') });
  d.add({ kind: 'h2', text: 'Conclusions' }, { kind: 'p', text: d.todo('conclusions drawn from the nonclinical and clinical tests') });
  return d;
}

function coverLetter(a: AdminData): Doc {
  const d = new Doc();
  const h = a.header;
  d.add({ kind: 'p', text: a.preparedOn });
  d.add({ kind: 'p', text: 'U.S. Food and Drug Administration, Center for Devices and Radiological Health' });
  d.add({ kind: 'p', text: d.todo('submission route (CDRH Portal or mailing address)') });
  d.add({ kind: 'h2', text: `Re: ${cap(h.submissionType)} 510(k) premarket notification for the ${h.deviceName}` });
  d.add({ kind: 'p', text: 'Dear Sir or Madam:' });
  d.add({
    kind: 'p',
    text: `${h.clientName} submits this ${h.submissionType} 510(k) premarket notification for the ${h.deviceName}, prepared with the ${h.estarTemplate} eSTAR template.`,
  });
  d.add({ kind: 'fields', rows: [['Device trade name', h.deviceName], ...classificationRows(d, a), ['Predicate device(s)', a.predicates.length ? a.predicates.map(predicateLine).join('; ') : d.todo('predicate device')]] });
  d.add({ kind: 'fields', rows: [['Prior FDA correspondence (Q-Submission number)', d.todo('Q-Submission number, if any')], ['User fee payment identification number', d.todo('payment identification number from Form FDA 3601')]] });
  d.add({ kind: 'p', text: `Please direct questions about this submission to ${d.todo('contact person, telephone and email')}.` });
  d.add({ kind: 'p', text: 'Sincerely,' });
  d.signature();
  d.add({ kind: 'p', text: h.clientName });
  return d;
}

function fda3601(a: AdminData): Doc {
  const d = new Doc();
  const h = a.header;
  d.add({ kind: 'title', text: 'Form FDA 3601 preparation sheet' }, { kind: 'subtitle', text: 'Medical Device User Fee Cover Sheet' });
  d.add({
    kind: 'note',
    text: "This is not Form FDA 3601. The cover sheet is created in FDA's online MDUFA user fee system, which assigns the payment identification number. This sheet gathers what that system asks for.",
  });
  d.add({
    kind: 'fields',
    rows: [
      ['Company name', h.clientName],
      ['Identifier (EIN for U.S. firms; DUNS for foreign firms; or FDA Organization ID)', d.todo('EIN, DUNS or Organization ID')],
      ['Contact name', d.todo('user fee contact name')],
      ['Address (street, city, state, ZIP, country)', d.todo('company address')],
      ['Telephone', d.todo('telephone')],
      ['Email', d.todo('email')],
      ['Application type', `510(k) premarket notification (${h.submissionType})`],
      ['Device', h.deviceName],
      ['Small business determination number, if any', d.todo('small business determination number, if any')],
      ['Payment identification number', d.todo("assigned by FDA's MDUFA system when the cover sheet is submitted")],
    ],
  });
  return d;
}

function truthfulAccurate(a: AdminData): Doc {
  const d = new Doc();
  d.add({ kind: 'title', text: 'Premarket Notification Truthful and Accurate Statement' }, { kind: 'subtitle', text: '[As required by 21 CFR 807.87(l)]' });
  d.add({ kind: 'p', text: TRUTHFUL_AND_ACCURATE.replace('{position}', '________________________').replace('{company}', a.header.clientName) });
  d.signature();
  d.add({ kind: 'fields', rows: [['Premarket Notification [510(k)] Number', '']] });
  d.add({ kind: 'note', text: 'Leave the 510(k) number blank for a new submission.' });
  d.add({
    kind: 'note',
    text: 'FDA: must be signed by a responsible person of the firm required to submit the premarket notification (for example, not a consultant for the 510(k) submitter).',
  });
  return d;
}

const BUILDERS: Record<AdminDocKind, (a: AdminData) => Doc> = {
  summary_510k: summary510k,
  cover_letter: coverLetter,
  fda_3601: fda3601,
  truthful_accurate: truthfulAccurate,
};

export function buildAdminDoc(kind: AdminDocKind, a: AdminData): AdminDoc {
  const d = BUILDERS[kind](a);
  if (d.openItems.length) d.add({ kind: 'h2', text: 'Open items' }, { kind: 'bullets', items: d.openItems.map((i) => `To be completed: ${i}`) });
  d.add({
    kind: 'note',
    text: 'Drafted by MedexRegAI from the project data. The consultant reviews it, and the submitter completes the bracketed items and signs.',
  });
  return { kind, title: ADMIN_DOC_TITLE[kind], openItems: d.openItems, signatureFields: kind === 'fda_3601' ? [] : SIGNATURE_FIELDS, blocks: d.blocks };
}

export async function adminDocDocx(orgId: string, projectId: string, kind: AdminDocKind): Promise<{ fileName: string; bytes: Buffer; doc: AdminDoc }> {
  if (!ADMIN_DOC_KINDS.includes(kind)) throw new AppError(404, ErrorCodes.NOT_FOUND, 'No such administrative document');
  const a = await adminData(orgId, projectId);
  const doc = buildAdminDoc(kind, a);
  const at = new Date();
  const bytes = await renderDocx({ title: `${doc.title}: ${a.header.projectName}`, footer: `${a.header.projectName} · ${doc.title} · ${a.preparedOn}`, createdAt: at, blocks: doc.blocks });
  const safe = a.header.projectName.replace(/[^A-Za-z0-9 ()&,.-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Project';
  return { fileName: `${safe} - ${doc.title.replace(/[^A-Za-z0-9 ()&,.-]+/g, ' ')} ${a.preparedOn}.docx`, bytes, doc };
}
