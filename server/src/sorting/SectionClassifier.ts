import { documentGenerate } from '../ai/guard/documentCall';
import { dataService } from '../services/DataService';
import { AppError, ErrorCodes } from '../utils/AppError';

/**
 * F2.2 section sorter: which eSTAR section (server/migrations/025) a client file is
 * evidence for, with a confidence and a reason the consultant sees on hover.
 *
 * Cheapest, most explainable signal first; the model only when nothing else is sure:
 *   1. learned  - the firm re-filed a file with a near-identical name: use its choice
 *   2. rules    - regulatory cues in the name and first pages (e.g. ISO 10993 ->
 *                 Biocompatibility, ISO 11135 -> Sterility, ASTM F1980 -> Shelf Life)
 *   3. embedding- the text reads like a file the firm has already filed (pgvector)
 *   4. llm      - the guarded "classify" AI route (allowed-section list, cites required)
 * A consultant's decision is never replaced. If no stage is sure, the file is left
 * without a section and a low confidence, so the screen asks rather than guesses.
 * Corrections are learned for this firm only (stages 1 and 3 read only its rows).
 */

export const CONFIDENT = 0.7;
const LEARNED_NAME_SIMILARITY = 0.6;
const EMBEDDING_SIMILARITY = 0.86;
const LLM_MAX_CONFIDENCE = 0.9;
const TEXT_SAMPLE_CHARS = 4000;

export interface SectionChoice {
  sectionId: string | null;
  confidence: number;
  source: 'rules' | 'embedding' | 'llm';
  reason: string;
}

interface Section {
  id: string;
  title: string;
  applies_to: 'all' | 'special_510k';
}

type Cue = { re: RegExp; weight: number; label: string };

const cue = (re: RegExp, weight: number, label: string): Cue => ({ re, weight, label });

/** Regulatory cues per section. Standards numbers weigh more than generic words. */
export const RULES: Record<string, Cue[]> = {
  sterility: [
    cue(/\bISO\s*11135\b/i, 3, 'ISO 11135'),
    cue(/\bISO\s*11137\b/i, 3, 'ISO 11137'),
    cue(/\bISO\s*17665\b/i, 3, 'ISO 17665'),
    cue(/\bISO\s*11737\b/i, 3, 'ISO 11737'),
    cue(/\bISO\s*10993-7\b/i, 3, 'ISO 10993-7 (EO residuals)'),
    cue(/\bsteril(e|ity|i[sz]ation)\b/i, 2, 'sterilization'),
    cue(/\bethylene oxide\b|\bEO\b(?=[\s-]*(valid|residu|steril|cycle))/i, 2, 'ethylene oxide'),
    cue(/\bbioburden\b|\bbiological indicators?\b|\bSAL\b|\bgamma\b|\bE-?beam\b/i, 1, 'sterility testing'),
  ],
  shelf_life: [
    cue(/\bASTM\s*F\s*1980\b/i, 3, 'ASTM F1980'),
    cue(/\bISO\s*11607\b/i, 3, 'ISO 11607'),
    cue(/\bASTM\s*F\s*(88|2096|1929)\b/i, 2, 'package test standard'),
    cue(/\bshelf[\s-]*life\b/i, 3, 'shelf life'),
    cue(/\b(accelerated|real[\s-]*time)\s+age?ing\b/i, 3, 'ageing study'),
    cue(/\bpackag(e|ing) integrity\b|\bseal strength\b|\bdye penetration\b/i, 2, 'package integrity'),
  ],
  biocompatibility: [
    cue(/\bISO\s*10993(?!-7)\b/i, 3, 'ISO 10993'),
    cue(/\bbiocompatib/i, 3, 'biocompatibility'),
    cue(/\bASTM\s*F\s*756\b/i, 3, 'ASTM F756 (hemolysis)'),
    cue(/\bhemoly|\bhaemoly|\bcytotoxic|\bsensiti[sz]ation\b|\birritation\b|\bhemocompatib|\bhaemocompatib|\bpyrogen|\bgenotox|\bsystemic toxicity\b/i, 2, 'biological endpoint'),
  ],
  software: [
    cue(/\bIEC\s*62304\b/i, 3, 'IEC 62304'),
    // "no software" / "without firmware" describes the device; it is not software evidence.
    cue(/(?<!\b(?:no|without)\s+)\b(?:software|firmware)\b/i, 2, 'software'),
    cue(/\b(SRS|SDS)\b|\bsoftware requirements\b|\banomal(y|ies) list\b|\bdocumentation level\b|\blevel of concern\b/i, 2, 'software documentation'),
  ],
  cybersecurity: [
    cue(/\bcyber\s*security\b|\bcybersecurity\b/i, 3, 'cybersecurity'),
    cue(/\bSBOM\b|\bsoftware bill of materials\b/i, 3, 'SBOM'),
    cue(/\bthreat model|\bpenetration test|\bAAMI\s*TIR\s*57\b|\bIEC\s*81001-5-1\b|\bvulnerabilit/i, 2, 'security testing'),
  ],
  emc_safety: [
    cue(/\bIEC\s*60601-1-2\b/i, 3, 'IEC 60601-1-2'),
    cue(/\bIEC\s*60601-1\b/i, 3, 'IEC 60601-1'),
    cue(/\bIEC\s*61010\b|\bCISPR\s*\d+|\bANSI\s*C63\.27\b/i, 3, 'EMC / safety standard'),
    cue(/\bEMC\b|\belectromagnetic\b|\belectrical safety\b|\bwireless coexistence\b/i, 2, 'EMC / electrical safety'),
  ],
  labeling: [
    cue(/\bIFU\b|\binstructions for use\b|\bpackage insert\b|\buser manual\b/i, 3, 'instructions for use'),
    cue(/\bISO\s*15223\b/i, 3, 'ISO 15223 (symbols)'),
    cue(/\blabel(s|ing|ling)?\b/i, 2, 'labeling'),
  ],
  performance_testing: [
    cue(/\bbench (test|testing|report)\b|\bperformance test/i, 3, 'bench testing'),
    cue(/\bdesign verification\b|\bverification (report|test)\b|\btest report\b/i, 2, 'verification testing'),
    cue(/\bISO\s*80369\b/i, 3, 'ISO 80369'),
    cue(/\btensile\b|\bflow rate\b|\bburst\b|\bkink\b|\btorque\b|\bfatigue\b|\bleak(age)? test\b/i, 2, 'bench measurement'),
    cue(/\banimal (study|testing)\b|\bclinical (study|investigation|data)\b/i, 2, 'animal or clinical study'),
  ],
  device_description: [
    cue(/\bdevice description\b|\bproduct (description|overview)\b|\bprinciple of operation\b/i, 3, 'device description'),
    cue(/\bspecification\b|\bspec\b|\bbill of materials\b|\bBOM\b/i, 2, 'specification'),
    cue(/\bdrawing\b|\bassembly\b|\bmaterials list\b|\bdimensions\b/i, 2, 'drawing or assembly'),
  ],
  predicates_se: [
    cue(/\bsubstantial(ly)? equivalen/i, 3, 'substantial equivalence'),
    cue(/\bpredicate\b|\bSE (comparison|table)\b/i, 3, 'predicate comparison'),
    cue(/\bK\d{6}\b/, 1, '510(k) number'),
  ],
  indications_for_use: [
    cue(/\bindications for use\b|\b(FDA\s*)?(Form\s*)?3881\b/i, 3, 'indications for use'),
    cue(/\bintended use\b/i, 1, 'intended use'),
  ],
  reprocessing: [
    cue(/\breprocess/i, 3, 'reprocessing'),
    cue(/\bcleaning validation\b|\bdisinfection\b|\bAAMI\s*TIR\s*(12|30)\b|\breusable\b/i, 2, 'cleaning and disinfection'),
  ],
  consensus_standards: [
    cue(/\bdeclaration of conformity\b|\bstandards data report\b|\b(FDA\s*)?(Form\s*)?3654\b/i, 3, 'declaration of conformity'),
    cue(/\brecognized consensus standard/i, 2, 'consensus standards'),
  ],
  presubmission_correspondence: [
    cue(/\bpre-?sub(mission)?\b|\bq-?sub(mission)?\b/i, 3, 'Q-Submission'),
    cue(/\bQ\d{6}\b/, 2, 'Q-Submission number'),
    cue(/\bFDA (feedback|meeting minutes)\b|\bmeeting minutes\b/i, 2, 'FDA correspondence'),
  ],
  design_risk_special: [
    cue(/\bISO\s*14971\b/i, 3, 'ISO 14971'),
    cue(/\brisk (analysis|management|assessment)\b|\bFMEA\b|\bdFMEA\b|\bpFMEA\b/i, 2, 'risk analysis'),
    cue(/\bdesign change\b|\bchange (analysis|assessment)\b/i, 2, 'design change'),
  ],
  references: [cue(/\bliterature (review|search)\b|\bbibliography\b|\breferences\b/i, 2, 'literature')],
  administrative: [
    cue(/\btruthful and accura/i, 3, 'Truthful and Accuracy Statement'),
    cue(/\b510\(k\) summary\b|\bexecutive summary\b/i, 3, '510(k) summary'),
    cue(/\b(FDA\s*)?(Form\s*)?(3514|3454|3455)\b|\buser fee\b|\bfinancial (certification|disclosure)\b/i, 2, 'administrative form'),
  ],
  cover_letter: [cue(/\bcover letter\b|\bletters? of reference\b|\bright of reference\b/i, 3, 'cover letter')],
  ai_response: [
    cue(/\badditional information (request|response|letter)\b|\bAI (request|response|letter)\b/i, 3, 'Additional Information response'),
    cue(/\bdeficienc(y|ies)\b|\bhold letter\b/i, 2, 'FDA deficiency'),
  ],
};

const STOP = new Set(['the', 'and', 'for', 'report', 'rev', 'final', 'draft', 'copy', 'version', 'pdf', 'docx', 'xlsx', 'pptx', 'csv']);

/** Words of a file name that carry meaning (no extension, revision tags or numbers). */
export function nameTokens(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .replace(/\.[a-z0-9]{1,5}$/, '')
      .replace(/\brev(ision)?[\s._-]*[a-z0-9]{1,3}\b/g, ' ')
      .split(/[^a-z]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  );
}

const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
};

/** Stage 2: score every section on the file name (counts double) and its first text. */
export function scoreRules(name: string, text: string, allowed: Set<string>): { sectionId: string; score: number; cues: string[] }[] {
  const scored: { sectionId: string; score: number; cues: string[] }[] = [];
  for (const [sectionId, cues] of Object.entries(RULES)) {
    if (!allowed.has(sectionId)) continue;
    let score = 0;
    const hits: string[] = [];
    for (const c of cues) {
      const inName = c.re.test(name);
      const inText = c.re.test(text);
      if (inName || inText) {
        score += c.weight * (inName ? 2 : 1);
        hits.push(inName ? `${c.label} (in the name)` : c.label);
      }
    }
    if (score > 0) scored.push({ sectionId, score, cues: hits });
  }
  return scored.sort((a, b) => b.score - a.score);
}

const ruleConfidence = (top: number, second: number): number => Math.min(0.92, Math.max(0.2, 0.4 + 0.06 * top + 0.05 * (top - second)));

interface FileRow {
  id: string;
  project_id: string;
  name: string;
  current_version_id: string | null;
  submission_type: string;
}

async function sectionsFor(submissionType: string): Promise<Section[]> {
  const rows = await dataService.query<Section>({}, 'estar_sections', 'SELECT id, title, applies_to FROM estar_sections WHERE takes_evidence ORDER BY ordinal');
  return rows.filter((s) => s.applies_to === 'all' || submissionType === 'special');
}

async function textSample(orgId: string, versionId: string | null): Promise<{ text: string; chunks: { id: string; text: string; where: string }[] }> {
  if (!versionId) return { text: '', chunks: [] };
  const chunks = await dataService.query<{ id: string; text: string; section_path: string | null; ordinal: number }>(
    { orgId },
    'chunks',
    `SELECT id, text, section_path, ordinal FROM chunks WHERE file_version_id = $1 AND org_id = current_setting('app.org_id')::uuid ORDER BY ordinal LIMIT 6`,
    [versionId],
  );
  return {
    text: chunks.map((c) => c.text).join('\n').slice(0, TEXT_SAMPLE_CHARS),
    chunks: chunks.map((c) => ({ id: c.id, text: c.text.slice(0, 1500), where: c.section_path || `Part ${c.ordinal + 1}` })),
  };
}

/** Stage 1: the firm's own corrections, matched on file-name words. */
async function learnedFromName(orgId: string, name: string, allowed: Set<string>): Promise<SectionChoice | null> {
  const rows = await dataService.query<{ section_id: string | null; name: string }>(
    { orgId },
    'file_assignments',
    `SELECT a.section_id, f.name FROM file_assignments a JOIN files f ON f.id = a.file_id AND f.org_id = a.org_id
      WHERE a.org_id = current_setting('app.org_id')::uuid AND a.source = 'consultant' AND a.is_current AND a.section_id IS NOT NULL
      ORDER BY a.created_at DESC LIMIT 500`,
  );
  const mine = nameTokens(name);
  let best: { sim: number; row: (typeof rows)[number] } | null = null;
  for (const r of rows) {
    if (!r.section_id || !allowed.has(r.section_id)) continue;
    const sim = jaccard(mine, nameTokens(r.name));
    if (!best || sim > best.sim) best = { sim, row: r };
  }
  if (!best || best.sim < LEARNED_NAME_SIMILARITY) return null;
  return { sectionId: best.row.section_id, confidence: Math.min(0.92, 0.6 + best.sim * 0.35), source: 'rules', reason: `Your firm filed a similar file ("${best.row.name}") here.` };
}

/** Stage 3: nearest file the firm has filed, by the average embedding of its text. */
async function learnedFromText(orgId: string, versionId: string | null, fileId: string, allowed: Set<string>): Promise<SectionChoice | null> {
  if (!versionId) return null;
  const rows = await dataService.query<{ section_id: string; name: string; sim: number }>(
    { orgId },
    'chunks',
    `WITH me AS (
       SELECT avg(embedding) AS v FROM chunks WHERE file_version_id = $1 AND org_id = current_setting('app.org_id')::uuid AND embedding IS NOT NULL),
     filed AS (
       SELECT a.section_id, f.name, avg(c.embedding) AS v
         FROM file_assignments a
         JOIN files f ON f.id = a.file_id AND f.org_id = a.org_id
         JOIN chunks c ON c.file_version_id = f.current_version_id AND c.org_id = f.org_id AND c.embedding IS NOT NULL
        WHERE a.org_id = current_setting('app.org_id')::uuid AND a.source = 'consultant' AND a.is_current AND a.section_id IS NOT NULL AND f.id <> $2
        GROUP BY a.section_id, f.id, f.name
        ORDER BY max(a.created_at) DESC LIMIT 200)
     SELECT filed.section_id, filed.name, 1 - (filed.v <=> me.v) AS sim FROM filed, me WHERE me.v IS NOT NULL ORDER BY sim DESC LIMIT 1`,
    [versionId, fileId],
  );
  const top = rows[0];
  if (!top || !allowed.has(top.section_id) || Number(top.sim) < EMBEDDING_SIMILARITY) return null;
  return { sectionId: top.section_id, confidence: Math.min(0.9, Number(top.sim)), source: 'embedding', reason: `Reads like "${top.name}", which your firm filed here.` };
}

export const sectionClassifier = {
  /** Work out a section for a file. Pure decision: nothing is saved here. */
  async suggest(orgId: string, fileId: string): Promise<SectionChoice> {
    const [file] = await dataService.query<FileRow>(
      { orgId },
      'files',
      `SELECT f.id, f.project_id, f.name, f.current_version_id, p.submission_type
         FROM files f JOIN projects p ON p.id = f.project_id AND p.org_id = f.org_id
        WHERE f.id = $1 AND f.org_id = current_setting('app.org_id')::uuid`,
      [fileId],
    );
    if (!file) throw new AppError(404, ErrorCodes.NOT_FOUND, 'File not found');
    const sections = await sectionsFor(file.submission_type);
    const allowed = new Set(sections.map((s) => s.id));
    const title = (id: string | null) => sections.find((s) => s.id === id)?.title ?? id;

    const learned = await learnedFromName(orgId, file.name, allowed);
    if (learned) return learned;

    const sample = await textSample(orgId, file.current_version_id);
    const ranked = scoreRules(file.name, sample.text, allowed);
    const top = ranked[0];
    const ruleChoice: SectionChoice | null = top
      ? {
          sectionId: top.sectionId,
          confidence: Number(ruleConfidence(top.score, ranked[1]?.score ?? 0).toFixed(3)),
          source: 'rules',
          reason: `Mentions ${top.cues.slice(0, 3).join(', ')}: ${title(top.sectionId)}.`,
        }
      : null;
    if (ruleChoice && ruleChoice.confidence >= CONFIDENT) return ruleChoice;

    const byText = await learnedFromText(orgId, file.current_version_id, file.id, allowed);
    if (byText) return byText;

    if (sample.chunks.length) {
      try {
        const r = await documentGenerate({ orgId, projectId: file.project_id }, 'classify', {
          task: { sections: sections.map((s) => ({ id: s.id, title: s.title })) },
          blocks: sample.chunks.map((c) => ({ ref: `chunk:${c.id}`, source: file.name, where: c.where, text: c.text })),
        });
        const v = r.value as { section: string; confidence: number; reason: string };
        return {
          sectionId: v.section,
          confidence: Number(Math.min(LLM_MAX_CONFIDENCE, v.confidence).toFixed(3)),
          source: 'llm',
          reason: `AI: ${v.reason}`.slice(0, 500),
        };
      } catch (err) {
        console.warn(`[sorting] AI classification unavailable for file ${file.id}: ${(err as Error).message}`);
      }
    }
    if (ruleChoice) return { ...ruleChoice, reason: `${ruleChoice.reason} Not sure: please confirm.` };
    return { sectionId: null, confidence: 0, source: 'rules', reason: 'Could not tell which section this file belongs to. Pick one.' };
  },

  /**
   * Sort one file and save the decision as its current assignment, unless a
   * consultant has already decided (their choice stands across new versions).
   */
  async sortFile(orgId: string, fileId: string): Promise<{ saved: boolean; choice?: SectionChoice }> {
    const [current] = await dataService.query<{ source: string }>(
      { orgId },
      'file_assignments',
      `SELECT source FROM file_assignments WHERE file_id = $1 AND org_id = current_setting('app.org_id')::uuid AND is_current`,
      [fileId],
    );
    if (current?.source === 'consultant') return { saved: false };
    const choice = await this.suggest(orgId, fileId);
    await dataService.transaction({ orgId }, async (tx) => {
      const [f] = await tx.query<{ project_id: string; current_version_id: string | null }>(
        'files',
        'SELECT project_id, current_version_id FROM files WHERE id = $1 AND org_id = $2 FOR UPDATE',
        [fileId, orgId],
      );
      if (!f) return;
      // Re-check under the lock: a consultant may have decided while we were thinking.
      const [now] = await tx.query<{ source: string }>('file_assignments', 'SELECT source FROM file_assignments WHERE file_id = $1 AND is_current', [fileId]);
      if (now?.source === 'consultant') return;
      await tx.query('file_assignments', 'UPDATE file_assignments SET is_current = false WHERE file_id = $1 AND org_id = $2 AND is_current', [fileId, orgId]);
      await tx.query(
        'file_assignments',
        `INSERT INTO file_assignments (org_id, project_id, file_id, version_id, section_id, confidence, source, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, left($8, 500))`,
        [orgId, f.project_id, fileId, f.current_version_id, choice.sectionId, choice.confidence, choice.source, choice.reason],
      );
    });
    return { saved: true, choice };
  },

  /** A consultant puts a file in a section (or none). Learned for this firm from then on. */
  async reassign(orgId: string, userId: string, fileId: string, sectionId: string | null): Promise<void> {
    await dataService.transaction({ orgId, userId }, async (tx) => {
      const [f] = await tx.query<{ project_id: string; current_version_id: string | null; submission_type: string }>(
        'files',
        `SELECT f.project_id, f.current_version_id, p.submission_type FROM files f JOIN projects p ON p.id = f.project_id AND p.org_id = f.org_id
          WHERE f.id = $1 AND f.org_id = $2 AND f.status = 'active' FOR UPDATE OF f`,
        [fileId, orgId],
      );
      if (!f) throw new AppError(404, ErrorCodes.NOT_FOUND, 'File not found');
      if (sectionId !== null) {
        const allowed = new Set((await sectionsFor(f.submission_type)).map((s) => s.id));
        if (!allowed.has(sectionId)) {
          throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'sectionId is not an eSTAR section that takes evidence for this submission', [
            { field: 'sectionId', message: 'Unknown or not applicable section' },
          ]);
        }
      }
      const [prev] = await tx.query<{ section_id: string | null }>(
        'file_assignments',
        'SELECT section_id FROM file_assignments WHERE file_id = $1 AND org_id = $2 AND is_current',
        [fileId, orgId],
      );
      await tx.query('file_assignments', 'UPDATE file_assignments SET is_current = false WHERE file_id = $1 AND org_id = $2 AND is_current', [fileId, orgId]);
      await tx.query(
        'file_assignments',
        `INSERT INTO file_assignments (org_id, project_id, file_id, version_id, section_id, confidence, source, reason, corrected_from, decided_by)
         VALUES ($1, $2, $3, $4, $5, 1, 'consultant', $6, $7, $8)`,
        [
          orgId,
          f.project_id,
          fileId,
          f.current_version_id,
          sectionId,
          sectionId ? 'Filed here by a consultant.' : 'A consultant marked this file as not evidence for any section.',
          prev?.section_id ?? null,
          userId,
        ],
      );
    });
  },

  /** Worker pass: sort files whose current version has no decision yet. */
  async sortPending(perOrg = 20): Promise<{ sorted: number; errors: number }> {
    const totals = { sorted: 0, errors: 0 };
    const orgs = await dataService.query<{ id: string }>({}, 'orgs', "SELECT id FROM orgs WHERE status = 'active' ORDER BY id");
    for (const { id: orgId } of orgs) {
      const due = await dataService.query<{ id: string }>(
        { orgId },
        'files',
        `SELECT f.id FROM files f
          LEFT JOIN file_assignments a ON a.file_id = f.id AND a.org_id = f.org_id AND a.is_current
          LEFT JOIN file_versions v ON v.id = f.current_version_id AND v.org_id = f.org_id
         WHERE f.org_id = current_setting('app.org_id')::uuid AND f.status = 'active'
           AND (a.id IS NULL OR (a.source <> 'consultant' AND a.version_id IS DISTINCT FROM f.current_version_id))
           -- Wait for the text: a version still being read is sorted once it is parsed.
           AND (f.current_version_id IS NULL OR v.parse_status IN ('parsed', 'failed', 'unsupported'))
           -- Listed-only and unreadable-only files are sorted once, by name.
           AND (f.current_version_id IS NOT NULL OR a.id IS NULL)
         ORDER BY f.created_at LIMIT $1`,
        [perOrg],
      );
      for (const { id } of due) {
        try {
          if ((await this.sortFile(orgId, id)).saved) totals.sorted++;
        } catch (err) {
          totals.errors++;
          console.warn(`[sorting] file ${id}: ${(err as Error).message}`);
        }
      }
    }
    return totals;
  },
};
