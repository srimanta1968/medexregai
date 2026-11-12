import { extractFacts, Fact } from '../citations/facts';
import { projectHeader } from '../records/RecordService';
import { leadingChunks } from '../retrieval/search';
import { dataService } from '../services/DataService';
import { Sheet, writeXlsx } from './xlsxWriter';

/**
 * F3.6 summary tables. One row per test report filed under a testing section of the
 * project: the standards it names (with editions), its acceptance criteria and the result
 * it states, all read from the report's own text. Each row is then compared with what the
 * project's drafts say about it; any difference is a mismatch the consultant resolves
 * before filing:
 *  - EDITION:  a draft names the same standard with a different edition;
 *  - RESULT:   a draft citing the report states a pass where the report states a failure, or the reverse;
 *  - OUTDATED: a draft cites an older version of the report than the current one.
 * Deterministic text matching, no model: the same files and drafts give the same table.
 */

/** eSTAR sections whose files are test reports. */
export const TEST_SECTIONS = ['performance_testing', 'biocompatibility', 'sterility', 'shelf_life', 'emc_safety', 'software', 'cybersecurity', 'reprocessing'];

/** Passages read per report: enough for a test report's scope, criteria and conclusion. */
const PASSAGES_PER_REPORT = 80;

export type ReportResult = 'pass' | 'fail' | 'not_stated';
export type MismatchKind = 'EDITION' | 'RESULT' | 'OUTDATED';

export interface Mismatch {
  kind: MismatchKind;
  detail: string;
  /** The draft section and its statement, for the consultant to find it. */
  section: string;
  statement: string;
}

export interface SummaryRow {
  fileId: string;
  report: string;
  versionNo: number;
  sectionId: string;
  section: string;
  standards: string[];
  acceptanceCriteria: string | null;
  result: ReportResult;
  mismatches: Mismatch[];
}

export interface SummaryTable {
  projectId: string;
  projectName: string;
  generatedAt: string;
  rows: SummaryRow[];
  mismatchCount: number;
}

const FAIL = /\b(?:failed|fails|did not (?:meet|pass|conform)|does not (?:meet|conform|comply)|non-?conform(?:ing|ance|ity)|out of specification|unacceptable)\b/i;
const PASS = /\b(?:passed|passes|pass(?![/-])|met (?:the|all) (?:acceptance )?(?:criteria|requirements)|meets? (?:the |all )?(?:acceptance )?(?:criteria|requirements)|conform(?:s|ed)? to|complies with|compliant with|acceptable results?)\b/i;

/** The result a text states: a failure anywhere outweighs a pass. */
export function statedResult(text: string): ReportResult {
  const clean = text.replace(/\bpass\s*\/\s*fail\b/gi, ' ');
  if (FAIL.test(clean)) return 'fail';
  if (PASS.test(clean)) return 'pass';
  return 'not_stated';
}

export function acceptanceCriteria(text: string): string | null {
  const m = /[^.\n]*\bacceptance criteri(?:a|on)\b[^.\n]*[.\n]?/i.exec(text);
  return m ? m[0].trim().slice(0, 300) : null;
}

type Std = Extract<Fact, { kind: 'standard' }>;
const stdKey = (s: Std): string => `${s.body} ${s.number}`;
const stdLabel = (s: Std): string => `${s.body} ${s.number}${s.edition ? `:${s.edition}` : ''}`;

export function standardsIn(text: string): Std[] {
  const seen = new Map<string, Std>();
  for (const f of extractFacts(text)) {
    if (f.fact.kind !== 'standard') continue;
    const s = f.fact;
    const k = stdLabel(s);
    if (!seen.has(k)) seen.set(k, s);
  }
  return [...seen.values()];
}

interface DraftStatementRow {
  text: string;
  section: string;
  file_ids: string[] | null;
  version_ids: string[] | null;
}

/** Mismatches between one report and the project's drafts. Pure, for the table and the board. */
export function compare(
  report: { fileId: string; currentVersionId: string; versionNo: number; standards: Std[]; result: ReportResult },
  statements: DraftStatementRow[],
  versionNoOf: Map<string, number>,
): Mismatch[] {
  const out: Mismatch[] = [];
  const reportStds = new Map(report.standards.map((s) => [stdKey(s), s]));
  for (const st of statements) {
    const cites = (st.file_ids ?? []).includes(report.fileId);
    for (const s of standardsIn(st.text)) {
      const r = reportStds.get(stdKey(s));
      // Only a draft standard with an edition can disagree; a report with several editions of it is not a mismatch.
      if (!r || !s.edition || !r.edition) continue;
      const editions = report.standards.filter((x) => stdKey(x) === stdKey(s)).map((x) => x.edition);
      if (!editions.includes(s.edition)) {
        out.push({ kind: 'EDITION', detail: `Draft states ${stdLabel(s)}; the report states ${stdLabel(r)}.`, section: st.section, statement: st.text });
      }
    }
    if (cites) {
      const said = statedResult(st.text);
      if (report.result !== 'not_stated' && said !== 'not_stated' && said !== report.result) {
        out.push({ kind: 'RESULT', detail: `Draft states a ${said}; the report states a ${report.result}.`, section: st.section, statement: st.text });
      }
      const older = (st.version_ids ?? []).filter((v, i) => (st.file_ids ?? [])[i] === report.fileId && v !== report.currentVersionId);
      for (const v of new Set(older)) {
        out.push({
          kind: 'OUTDATED',
          detail: `Draft cites v${versionNoOf.get(v) ?? '?'} of the report; the current version is v${report.versionNo}.`,
          section: st.section,
          statement: st.text,
        });
      }
    }
  }
  return out;
}

export async function buildSummaryTable(orgId: string, projectId: string): Promise<SummaryTable> {
  const h = await projectHeader(orgId, projectId);
  const files = await dataService.query<{ id: string; name: string; current_version_id: string; version_no: number; section_id: string; title: string }>(
    { orgId },
    'file_assignments',
    `SELECT f.id, f.name, f.current_version_id, v.version_no, a.section_id, s.title
       FROM file_assignments a
       JOIN files f ON f.id = a.file_id AND f.org_id = a.org_id AND f.status = 'active'
       JOIN file_versions v ON v.id = f.current_version_id AND v.org_id = f.org_id
       JOIN estar_sections s ON s.id = a.section_id
      WHERE a.org_id = $1 AND a.project_id = $2 AND a.is_current AND a.section_id = ANY($3::varchar[])
      ORDER BY s.ordinal, f.name`,
    [orgId, projectId, TEST_SECTIONS],
  );
  const hits = await leadingChunks({ orgId, projectId, fileIds: files.map((f) => f.id), perFile: PASSAGES_PER_REPORT });
  const textOf = new Map<string, string>();
  for (const hit of hits) textOf.set(hit.fileId, `${textOf.get(hit.fileId) ?? ''}\n${hit.text}`);

  // The latest ready draft of each section, with the files each statement cites.
  const statements = await dataService.query<DraftStatementRow>(
    { orgId },
    'draft_statements',
    `WITH latest AS (
       SELECT DISTINCT ON (d.project_section_id) d.id, s.title
         FROM section_drafts d
         JOIN project_sections ps ON ps.id = d.project_section_id AND ps.org_id = d.org_id
         JOIN estar_sections s ON s.id = ps.section_id
        WHERE d.org_id = $1 AND ps.project_id = $2 AND d.status = 'ready'
        ORDER BY d.project_section_id, d.version_no DESC)
     SELECT st.text, l.title AS section,
            array_remove(array_agg(ss.file_id), NULL) AS file_ids, array_remove(array_agg(ss.file_version_id), NULL) AS version_ids
       FROM latest l
       JOIN draft_statements st ON st.draft_id = l.id AND st.org_id = $1 AND st.kind = 'statement'
       LEFT JOIN statement_sources ss ON ss.statement_id = st.id AND ss.org_id = st.org_id
      GROUP BY st.id, st.text, l.title, st.ordinal
      ORDER BY l.title, st.ordinal`,
    [orgId, projectId],
  );
  const versionIds = [...new Set(statements.flatMap((s) => s.version_ids ?? []))];
  const versions = versionIds.length
    ? await dataService.query<{ id: string; version_no: number }>(
        { orgId },
        'file_versions',
        'SELECT id, version_no FROM file_versions WHERE org_id = $1 AND id = ANY($2::uuid[])',
        [orgId, versionIds],
      )
    : [];
  const versionNoOf = new Map(versions.map((v) => [v.id, v.version_no]));

  const rows: SummaryRow[] = files.map((f) => {
    const text = textOf.get(f.id) ?? '';
    const standards = standardsIn(text);
    const result = statedResult(text);
    return {
      fileId: f.id,
      report: f.name,
      versionNo: f.version_no,
      sectionId: f.section_id,
      section: f.title,
      standards: standards.map(stdLabel),
      acceptanceCriteria: acceptanceCriteria(text),
      result,
      mismatches: compare({ fileId: f.id, currentVersionId: f.current_version_id, versionNo: f.version_no, standards, result }, statements, versionNoOf),
    };
  });
  return {
    projectId,
    projectName: h.projectName,
    generatedAt: new Date().toISOString(),
    rows,
    mismatchCount: rows.reduce((n, r) => n + r.mismatches.length, 0),
  };
}

const RESULT_LABEL: Record<ReportResult, string> = { pass: 'Pass', fail: 'Fail', not_stated: 'Not stated in the report' };

/** The table as an Excel workbook: the summary, every mismatch, and how it was made. */
export async function summaryTableXlsx(t: SummaryTable): Promise<{ fileName: string; bytes: Buffer }> {
  const summary: Sheet = {
    name: 'Summary of testing',
    preamble: [
      [`Summary of testing: ${t.projectName}`],
      [`Mismatches with the drafts: ${t.mismatchCount}`],
      [`Drafted ${t.generatedAt.slice(0, 16).replace('T', ' ')} UTC from the test reports filed in the project. Check every row against the report before filing.`],
    ],
    header: ['Section', 'Test report', 'Version', 'Standards named', 'Acceptance criteria', 'Result stated', 'Mismatches'],
    rows: t.rows.map((r) => [r.section, r.report, r.versionNo, r.standards.join('; '), r.acceptanceCriteria ?? 'Not found in the report', RESULT_LABEL[r.result], r.mismatches.length]),
    widths: [22, 36, 9, 34, 50, 16, 12],
  };
  const mismatches: Sheet = {
    name: 'Mismatches',
    preamble: [[`Mismatches: ${t.mismatchCount}`]],
    header: ['Test report', 'Kind', 'Detail', 'Draft section', 'Draft statement'],
    rows: t.rows.flatMap((r) => r.mismatches.map((m) => [r.report, m.kind, m.detail, m.section, m.statement])),
    widths: [36, 11, 50, 22, 70],
  };
  const about: Sheet = {
    name: 'How this was made',
    header: ['Item', 'Meaning'],
    rows: [
      ['Rows', 'One per test report filed under Performance testing, Biocompatibility, Sterility, Shelf life, EMC and electrical safety, Software, Cybersecurity or Reprocessing.'],
      ['Standards named', "Standard numbers and editions as written in the report's text."],
      ['Result stated', 'Fail when the report states a failure or non-conformance anywhere; Pass when it states a pass or conformance and no failure; otherwise Not stated.'],
      ['EDITION', 'A draft names the same standard with a different edition than the report.'],
      ['RESULT', 'A draft statement citing the report states a pass where the report states a failure, or the reverse.'],
      ['OUTDATED', 'A draft statement cites an older version of the report than the current one.'],
    ],
    widths: [20, 110],
  };
  const safe = t.projectName.replace(/[^A-Za-z0-9 ()&,.-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Project';
  return { fileName: `${safe} - Summary of testing ${t.generatedAt.slice(0, 10)}.xlsx`, bytes: await writeXlsx([summary, mismatches, about], `Summary of testing: ${t.projectName}`) };
}
