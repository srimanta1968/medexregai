import { ProjectSourceResolver } from '../citations/CitationService';
import { parseCitations, refKey } from '../citations/gate';
import { leadingChunks } from '../retrieval/search';
import { dataService } from '../services/DataService';

/**
 * F3.6 claim checker. A drafted statement may cite a real passage and still claim more than
 * the submission can carry. This flags, for the consultant to decide (nothing is removed):
 *  - an intended use ("indicated for ...", "for use in ...") whose words are not in the
 *    project's Indications for Use;
 *  - a patient population or use setting (pediatric, home use, over-the-counter ...) the
 *    Indications for Use does not name;
 *  - a performance or safety claim (superior, eliminates, clinically proven, 100% ...) that
 *    the statement's own cited source does not make.
 * Deterministic: word and phrase matching, no model, so the same draft always gets the same warnings.
 */

export interface IfuText {
  text: string;
  /** Where it came from, for messages: "Indications for Use draft v2" or a file name. */
  label: string;
}

const STOP = new Set(
  'with that this which their there these those from into onto upon over under than then them they such only also each both other used uses using within without including include includes intended indicated device devices patient patients system systems'.split(
    ' ',
  ),
);

/** Openers of an intended-use claim; the claim is the clause after them. */
const USE_OPENER =
  /\b(?:indicated|intended)\s+(?:for(?:\s+use)?(?:\s+(?:in|on|by|with))?|to(?:\s+be\s+used)?(?:\s+(?:in|on|by|with|for))?)\s+|\bfor\s+use\s+(?:in|on|by|with)\s+|\bused\s+to\s+(?=(?:treat|diagnose|monitor|prevent|cure|detect|relieve|deliver|administer|measure)\b)/i;

/** Populations and settings an IFU states explicitly; naming one it does not is a new claim. */
const SCOPE_TERMS: { name: string; re: RegExp }[] = [
  { name: 'pediatric', re: /\bp(?:a)?ediatric\w*/i },
  { name: 'neonates', re: /\bneonat\w*/i },
  { name: 'infants', re: /\binfants?\b/i },
  { name: 'children', re: /\bchild(?:ren)?\b/i },
  { name: 'adolescents', re: /\badolescen\w*/i },
  { name: 'geriatric', re: /\bgeriatric\w*|\belderly\b/i },
  { name: 'pregnancy', re: /\bpregnan\w*/i },
  { name: 'home use', re: /\bhome[- ](?:use|care|setting|environment)s?\b|\bat home\b/i },
  { name: 'over-the-counter use', re: /\bover[- ]the[- ]counter\b|\bOTC\b/ },
  { name: 'implantation', re: /\bimplant(?:ed|able|ation)?\b/i },
];

/** Claims of performance or safety that need a source saying the same. */
const EVIDENCE_TERMS: { name: string; re: RegExp }[] = [
  { name: 'superior', re: /\bsuperior(?:ity)?\b/i },
  { name: 'better than', re: /\bbetter\s+than\b/i },
  { name: 'more effective', re: /\bmore\s+effective\b/i },
  { name: 'safer', re: /\bsafer\b|\bsafest\b/i },
  { name: 'eliminates', re: /\beliminat(?:e|es|ed|ing)\b/i },
  { name: 'guarantees', re: /\bguarantee[sd]?\b/i },
  { name: 'prevents', re: /\bprevent(?:s|ed|ing)?\b/i },
  { name: 'cures', re: /\bcure[sd]?\b/i },
  { name: 'clinically proven', re: /\bclinically\s+(?:proven|validated|shown)\b|\bproven\s+to\b/i },
  { name: '100%', re: /\b100\s?%|\bone hundred percent\b/i },
  { name: 'risk-free', re: /\brisk[- ]free\b|\bno\s+risks?\b|\bwithout\s+(?:any\s+)?risk\b/i },
  { name: 'painless', re: /\bpainless\b|\bpain[- ]free\b/i },
];

const words = (s: string): string[] => (s.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []).filter((w) => !STOP.has(w));
/** A light stem: the first five letters, so "infusion"/"infusions" and "catheter"/"catheters" match. */
const stem = (w: string): string => w.slice(0, 5);

/** The intended-use clause of a sentence, or null when it makes no use claim. */
export function useClause(sentence: string): string | null {
  const m = USE_OPENER.exec(sentence);
  if (!m) return null;
  const rest = sentence.slice(m.index + m[0].length).split(/[.;:]/)[0];
  const clause = rest.split(/\s+/).slice(0, 15).join(' ').trim();
  return clause.length >= 3 ? clause : null;
}

/**
 * Warnings for one statement. `ifu` is null when the project has no Indications for Use yet;
 * `isIfuSection` skips the IFU comparisons for the IFU section itself.
 */
export function claimWarnings(text: string, sourceTexts: string[], ifu: IfuText | null, isIfuSection = false): string[] {
  const out: string[] = [];
  if (!isIfuSection) {
    const clause = useClause(text);
    if (clause) {
      if (!ifu) {
        out.push('States an intended use, but the project has no Indications for Use to compare it with.');
      } else {
        const ifuStems = new Set(words(ifu.text).map(stem));
        const claimWords = [...new Set(words(clause))];
        const missing = claimWords.filter((w) => !ifuStems.has(stem(w)));
        if (claimWords.length && missing.length && missing.length * 3 > claimWords.length) {
          out.push(`Goes beyond the Indications for Use: ${missing.map((w) => `“${w}”`).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in ${ifu.label}.`);
        }
      }
    }
    if (ifu) {
      for (const t of SCOPE_TERMS) {
        if (t.re.test(text) && !t.re.test(ifu.text)) out.push(`Names ${t.name}, which ${ifu.label} does not cover.`);
      }
    }
  }
  const cited = sourceTexts.join('\n');
  for (const t of EVIDENCE_TERMS) {
    if (!t.re.test(text)) continue;
    if (!sourceTexts.length) out.push(`“${t.name}” goes beyond the evidence: the statement cites no source.`);
    else if (!t.re.test(cited)) out.push(`“${t.name}” goes beyond the evidence: the cited source does not say it.`);
  }
  return out;
}

/** The project's Indications for Use: its latest ready IFU draft, else the files filed under that section. */
export async function ifuFor(orgId: string, projectId: string): Promise<IfuText | null> {
  const [draft] = await dataService.query<{ version_no: number; text: string }>(
    { orgId },
    'section_drafts',
    `SELECT d.version_no, string_agg(st.text, ' ' ORDER BY st.ordinal) AS text
       FROM section_drafts d
       JOIN project_sections ps ON ps.id = d.project_section_id AND ps.org_id = d.org_id
       JOIN draft_statements st ON st.draft_id = d.id AND st.org_id = d.org_id
      WHERE d.org_id = $1 AND ps.project_id = $2 AND ps.section_id = 'indications_for_use' AND d.status = 'ready'
      GROUP BY d.id, d.version_no ORDER BY d.version_no DESC LIMIT 1`,
    [orgId, projectId],
  );
  if (draft?.text) return { text: draft.text, label: `the Indications for Use draft (v${draft.version_no})` };
  const filed = await dataService.query<{ file_id: string }>(
    { orgId },
    'file_assignments',
    `SELECT a.file_id FROM file_assignments a JOIN files f ON f.id = a.file_id AND f.org_id = a.org_id AND f.status = 'active'
      WHERE a.org_id = $1 AND a.project_id = $2 AND a.is_current AND a.section_id = 'indications_for_use'`,
    [orgId, projectId],
  );
  const hits = await leadingChunks({ orgId, projectId, fileIds: filed.map((f) => f.file_id), perFile: 6 });
  if (!hits.length) return null;
  const names = [...new Set(hits.map((h) => h.fileName))];
  return { text: hits.map((h) => h.text).join('\n'), label: `the Indications for Use (${names.join(', ')})` };
}

/**
 * Check every statement of one draft and store the warnings. Safe to run again: it replaces
 * only claim_warnings. Returns how many statements were warned.
 */
export async function checkClaims(orgId: string, draftId: string): Promise<number> {
  const [d] = await dataService.query<{ project_id: string; section_id: string }>(
    { orgId },
    'section_drafts',
    `SELECT ps.project_id, ps.section_id FROM section_drafts d JOIN project_sections ps ON ps.id = d.project_section_id AND ps.org_id = d.org_id
      WHERE d.id = $1 AND d.org_id = $2 AND d.status = 'ready'`,
    [draftId, orgId],
  );
  if (!d) return 0;
  const statements = await dataService.query<{ id: string; text: string; citations: { marker: string }[] }>(
    { orgId },
    'draft_statements',
    `SELECT id, text, citations FROM draft_statements WHERE org_id = $1 AND draft_id = $2 AND kind = 'statement' ORDER BY ordinal`,
    [orgId, draftId],
  );
  if (!statements.length) return 0;
  const isIfuSection = d.section_id === 'indications_for_use';
  const ifu = isIfuSection ? null : await ifuFor(orgId, d.project_id);
  const refs = parseCitations(statements.flatMap((s) => s.citations.map((c) => c.marker)).join(' '));
  const resolved = refs.length ? await new ProjectSourceResolver(orgId, d.project_id).resolve(refs) : new Map();
  const textOf = (marker: string): string | null => {
    const [ref] = parseCitations(marker);
    const r = ref ? resolved.get(refKey(ref)) : undefined;
    return r && !('error' in r) ? r.text : null;
  };
  const results = statements.map((s) => ({
    id: s.id,
    claim_warnings: claimWarnings(
      s.text,
      s.citations.map((c) => textOf(c.marker)).filter((t): t is string => t !== null),
      ifu,
      isIfuSection,
    ),
  }));
  await dataService.query(
    { orgId },
    'draft_statements',
    `UPDATE draft_statements st SET claim_warnings = r.claim_warnings
       FROM jsonb_to_recordset($3::jsonb) AS r(id uuid, claim_warnings jsonb)
      WHERE st.id = r.id AND st.org_id = $1 AND st.draft_id = $2`,
    [orgId, draftId, JSON.stringify(results)],
  );
  return results.filter((r) => r.claim_warnings.length).length;
}
