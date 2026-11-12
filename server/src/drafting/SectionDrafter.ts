import { aiGenerate } from '../ai/registry';
import { runCitationGate } from '../citations/CitationService';
import { parseCitations, splitSentences } from '../citations/gate';
import { hybridSearch, leadingChunks, SearchHit } from '../retrieval/search';
import { dataService, Tx } from '../services/DataService';
import { DRAFT_PROMPT_VERSION, DRAFT_SYSTEM, templateFor } from './templates';

/**
 * F3.2 section drafter (RAG). For one section of a submission:
 *  1. gather evidence: the leading passages of files filed under the section, then
 *     searches for the section title, FDA's description of it and the template's terms;
 *  2. ask the `draft` route to write the section, citing passages by short tags [S1];
 *  3. turn the tags into real citation markers and run the citation gate in its
 *     every-statement mode: a statement without a resolvable citation is removed and
 *     listed for the consultant (it is never shown as drafted text);
 *  4. store what survived as the draft's statements.
 * Runs in the worker (draftPass); drafts are claimed queued -> generating so two workers
 * never draft the same one.
 */

const MAX_PASSAGES = 12;
const PASSAGE_CHARS = 1500;

export interface Passage {
  tag: string;
  marker: string;
  label: string;
  text: string;
}

export interface StatementInput {
  paragraph: number;
  kind: 'heading' | 'statement';
  text: string;
  citations: { marker: string; label: string }[];
  warnings?: string[];
  origin?: 'generated' | 'human_edited' | 'human_added';
  humanApproved?: boolean;
  approvedBy?: string | null;
  sourceStatementId?: string | null;
}

/** Write a draft's statements in order (ordinal = position). */
export async function saveStatements(tx: Tx, orgId: string, draftId: string, statements: StatementInput[]): Promise<void> {
  if (!statements.length) return;
  await tx.query(
    'draft_statements',
    `INSERT INTO draft_statements (org_id, draft_id, ordinal, paragraph, kind, text, citations, warnings, origin, human_approved, approved_by, source_statement_id)
     SELECT $1, $2, s.ordinal, s.paragraph, s.kind, s.text, s.citations, s.warnings, s.origin, s.human_approved, s.approved_by, s.source_statement_id
       FROM jsonb_to_recordset($3::jsonb) AS s(ordinal int, paragraph int, kind varchar, text text, citations jsonb, warnings jsonb,
                                              origin varchar, human_approved boolean, approved_by uuid, source_statement_id uuid)`,
    [
      orgId,
      draftId,
      JSON.stringify(
        statements.map((s, i) => ({
          ordinal: i + 1,
          paragraph: s.paragraph,
          kind: s.kind,
          text: s.text,
          citations: s.citations,
          warnings: s.warnings ?? [],
          origin: s.origin ?? 'generated',
          human_approved: s.humanApproved ?? false,
          approved_by: s.approvedBy ?? null,
          source_statement_id: s.sourceStatementId ?? null,
        })),
      ),
    ],
  );
}

const label = (h: SearchHit): string => `${h.fileName} v${h.versionNo}, ${h.where}`;

/** Evidence for a section: its own files first, then what the searches find elsewhere in the project. */
export async function gatherEvidence(input: {
  orgId: string;
  projectId: string;
  sectionId: string;
  title: string;
  fdaDescription: string;
}): Promise<Passage[]> {
  const { orgId, projectId, sectionId } = input;
  const filed = await dataService.query<{ file_id: string }>(
    { orgId },
    'file_assignments',
    `SELECT a.file_id FROM file_assignments a JOIN files f ON f.id = a.file_id AND f.org_id = a.org_id AND f.status = 'active'
      WHERE a.org_id = $1 AND a.project_id = $2 AND a.is_current AND a.section_id = $3`,
    [orgId, projectId, sectionId],
  );
  const filedIds = new Set(filed.map((f) => f.file_id));
  const hits: SearchHit[] = await leadingChunks({ orgId, projectId, fileIds: [...filedIds], perFile: 4 });
  for (const query of [input.title, input.fdaDescription, ...templateFor(sectionId).queries]) {
    const r = await hybridSearch({ orgId, projectId, query, limit: 6 });
    // A file filed under another section is still evidence when a search finds it; the section's own files rank first.
    hits.push(...[...r.items].sort((a, b) => Number(filedIds.has(b.fileId)) - Number(filedIds.has(a.fileId))));
  }
  const seen = new Set<string>();
  const out: Passage[] = [];
  for (const h of hits) {
    if (seen.has(h.chunkId)) continue;
    seen.add(h.chunkId);
    out.push({ tag: `S${out.length + 1}`, marker: h.citation, label: label(h), text: h.text.slice(0, PASSAGE_CHARS) });
    if (out.length >= MAX_PASSAGES) break;
  }
  return out;
}

/**
 * Sentences about the sources or the task rather than the device ("The passages do not
 * mention...", "No information is provided..."). A citation does not make them statements;
 * they are removed and listed like any other unsupported sentence.
 */
const META =
  /\b(?:the |these |provided |given |source )?passages?\b|\bS\d+\b|\b(?:no|not enough|insufficient) (?:specific |relevant )?(?:information|content|evidence|data)\b|\b(?:is|are|was|were) not (?:provided|mentioned|specified|available)\b|\bthis section (?:should|will|would|must)\b|\bas an ai\b/i;

export function isMeta(sentence: string): boolean {
  return META.test(sentence.replace(/\[(C|R):[^\]]+\]/g, ''));
}

export function buildPrompt(title: string, fdaDescription: string, passages: Passage[]): string {
  const blocks = passages
    .map((p) => `<passage tag="${p.tag}" source="${p.label.replace(/"/g, "'")}">\n${p.text.replace(/<\/?passage/gi, '')}\n</passage>`)
    .join('\n');
  return `Section: ${title}\nWhat FDA expects in this section: ${fdaDescription}\n\nSource passages:\n${blocks}\n\nWrite the section now. End every sentence with its passage tag.`;
}

/** Replace [S2] / [S2, S5] / [S2][S5] with the passages' citation markers; unknown tags are left and fail the gate. */
export function resolveTags(text: string, passages: Passage[]): string {
  const byTag = new Map(passages.map((p) => [p.tag.toUpperCase(), p.marker]));
  return text.replace(/\[\s*(S\d+(?:\s*[,;]\s*S\d+)*)\s*\]/gi, (whole, list: string) => {
    const markers = list.split(/[,;]/).map((t) => byTag.get(t.trim().toUpperCase()));
    return markers.every(Boolean) ? markers.join('') : whole;
  });
}

/** Split gated draft text into stored statements, labelling each citation from the passages it came from. */
export function toStatements(text: string, passages: Passage[], warningsBySentence = new Map<string, string[]>()): StatementInput[] {
  const labels = new Map(passages.map((p) => [p.marker, p.label]));
  const out: StatementInput[] = [];
  text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .forEach((para, paragraph) => {
      if (para.startsWith('#')) {
        out.push({ paragraph, kind: 'heading', text: para.replace(/^#+\s*/, ''), citations: [] });
        return;
      }
      for (const sentence of splitSentences(para.replace(/\n/g, ' ')).filter(Boolean)) {
        const cites = parseCitations(sentence);
        // Drop the markers, and a stray leading label the model sometimes copies from a source ("[EO-09] The ...").
        const plain = sentence
          .replace(/\s*\[(C|R):[^\]]+\]/g, '')
          .replace(/^\s*\[[^\]]{1,24}\]\s*/, '')
          .trim();
        out.push({
          paragraph,
          kind: 'statement',
          text: plain,
          citations: cites.map((c) => ({ marker: c.marker, label: labels.get(c.marker) ?? c.marker })),
          warnings: warningsBySentence.get(plain) ?? [],
        });
      }
    });
  return out;
}

async function fail(orgId: string, draftId: string, message: string): Promise<void> {
  await dataService.query(
    { orgId },
    'section_drafts',
    `UPDATE section_drafts SET status = 'failed', error = left($3, 500), finished_at = now() WHERE id = $1 AND org_id = $2`,
    [draftId, orgId, message],
  );
}

/** Draft one queued draft. Safe to call twice or concurrently: only the call that claims it works. */
export async function generateDraft(orgId: string, draftId: string): Promise<void> {
  const [d] = await dataService.query<{
    project_id: string;
    section_id: string;
    title: string;
    fda_description: string;
    created_by: string | null;
  }>(
    { orgId },
    'section_drafts',
    `UPDATE section_drafts d SET status = 'generating', started_at = now()
       FROM project_sections ps JOIN estar_sections s ON s.id = ps.section_id
      WHERE d.id = $1 AND d.org_id = $2 AND d.status = 'queued' AND ps.id = d.project_section_id AND ps.org_id = d.org_id
      RETURNING ps.project_id, ps.section_id, s.title, s.fda_description, d.created_by`,
    [draftId, orgId],
  );
  if (!d) return;
  try {
    const passages = await gatherEvidence({ orgId, projectId: d.project_id, sectionId: d.section_id, title: d.title, fdaDescription: d.fda_description });
    if (!passages.length) {
      await fail(orgId, draftId, 'No client passages were found for this section, so nothing could be drafted with a source. File evidence under it and draft again.');
      return;
    }
    const ai = await aiGenerate({ orgId, projectId: d.project_id }, 'draft', { system: DRAFT_SYSTEM, prompt: buildPrompt(d.title, d.fda_description, passages) });
    if (/^\s*NO_EVIDENCE\s*\.?\s*$/.test(ai.text)) {
      await fail(orgId, draftId, 'The client passages found for this section do not cover what it needs, so nothing was drafted. File evidence under it and draft again.');
      return;
    }
    const gate = await runCitationGate({
      orgId,
      userId: d.created_by ?? undefined,
      projectId: d.project_id,
      route: 'draft',
      text: resolveTags(ai.text, passages),
      everyStatement: true,
    });
    const warnings = new Map(gate.kept.map((k) => [k.text, k.warnings]));
    const removed: { text: string; code: string; reason: string }[] = [...gate.removed];
    const statements = toStatements(gate.text, passages, warnings).filter((s) => {
      if (s.kind === 'heading') return true;
      if (isMeta(s.text)) {
        removed.push({ text: s.text, code: 'NOT_A_STATEMENT', reason: 'Talks about the sources or the task, not the device' });
        return false;
      }
      return s.citations.length > 0;
    });
    if (!statements.some((s) => s.kind === 'statement')) {
      await dataService.query(
        { orgId },
        'section_drafts',
        `UPDATE section_drafts SET status = 'failed', error = $3, removed_items = $4::jsonb, gate_run_id = $5, model = $6, prompt_version = $7, finished_at = now()
          WHERE id = $1 AND org_id = $2`,
        [
          draftId,
          orgId,
          'No drafted statement could be tied to a client source, so nothing is shown as draft. The removed statements are listed.',
          JSON.stringify(removed),
          gate.runId,
          `${ai.provider}:${ai.model}`,
          DRAFT_PROMPT_VERSION,
        ],
      );
      return;
    }
    await dataService.transaction({ orgId }, async (tx) => {
      await saveStatements(tx, orgId, draftId, statements);
      await tx.query(
        'section_drafts',
        `UPDATE section_drafts SET status = 'ready', model = $3, prompt_version = $4, gate_run_id = $5, removed_items = $6::jsonb, finished_at = now()
          WHERE id = $1 AND org_id = $2`,
        [draftId, orgId, `${ai.provider}:${ai.model}`, DRAFT_PROMPT_VERSION, gate.runId, JSON.stringify(removed)],
      );
    });
  } catch (err) {
    await fail(orgId, draftId, `Drafting failed: ${(err as Error).message}`);
  }
}

/** Worker pass: draft what is queued, oldest first, a few per firm. */
export async function draftPending(perOrg = 2): Promise<number> {
  let drafted = 0;
  const orgs = await dataService.query<{ id: string }>({}, 'orgs', "SELECT id FROM orgs WHERE status = 'active' ORDER BY id");
  for (const { id: orgId } of orgs) {
    // A claim older than this is a dead worker's: put it back in the queue.
    await dataService.query(
      { orgId },
      'section_drafts',
      `UPDATE section_drafts SET status = 'queued', started_at = NULL
        WHERE org_id = $1 AND status = 'generating' AND started_at < now() - interval '15 minutes'`,
      [orgId],
    );
    const due = await dataService.query<{ id: string }>(
      { orgId },
      'section_drafts',
      `SELECT id FROM section_drafts WHERE org_id = $1 AND status = 'queued' ORDER BY created_at LIMIT $2`,
      [orgId, perOrg],
    );
    for (const { id } of due) {
      await generateDraft(orgId, id);
      drafted += 1;
    }
  }
  return drafted;
}
