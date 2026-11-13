import { dataService } from '../services/DataService';
import { hybridSearch } from '../retrieval/search';
import { scoreRules } from '../sorting/SectionClassifier';
import { AppError, ErrorCodes } from '../utils/AppError';

/**
 * F5.1 letter splitter (FR-14.23): turn an FDA Additional Information request or RTA hold letter
 * into numbered deficiencies, each with a proposed eSTAR section, the client files it most likely
 * concerns and the drafted statements that cite them. Nothing is saved here: the consultant
 * checks and edits the proposal, then creates the letter (FdaLetterService.create).
 *
 * Deterministic: FDA numbers its deficiencies, so the split follows that numbering (the longest
 * run 1, 2, 3 ... of numbered lines), not a model. Sub-items (a., b., i.) stay inside their
 * deficiency. Section proposals use the same rules that sort client files; file proposals use
 * the project's own search. Both are suggestions, shown with why they were made.
 *
 * Deadline: FDA allows 180 calendar days from the date of the request for a complete response
 * to an AI request, and 180 calendar days to address an RTA hold (fda.gov, "510(k) Submission
 * Process"); dueOn is proposed from the letter date found in the text.
 */

export const RESPONSE_DAYS = 180;
const MAX_TEXT = 200_000;
const MAX_ITEM = 20_000;

export interface ProposedDeficiency {
  number: number;
  summary: string;
  fdaText: string;
  sectionId: string | null;
  sectionTitle: string | null;
  sectionCues: string[];
  files: { id: string; name: string }[];
  statements: { id: string; text: string; sectionTitle: string }[];
}

export interface LetterProposal {
  kind: 'ai_request' | 'rta_hold';
  fdaReference: string | null;
  issuedOn: string | null;
  dueOn: string | null;
  deficiencies: ProposedDeficiency[];
  notes: string[];
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** Add calendar days to a YYYY-MM-DD date (UTC, no time-zone drift). */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The first full date near the top of the letter ("June 2, 2025", "2 June 2025" or "2025-06-02"). */
export function findLetterDate(text: string): string | null {
  const head = text.slice(0, 3000);
  const iso = (y: number, m: number, d: number): string | null => {
    const dt = new Date(Date.UTC(y, m, d));
    return dt.getUTCMonth() === m && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
  };
  const candidates: { at: number; value: string | null }[] = [];
  for (const m of head.matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/gi)) {
    candidates.push({ at: m.index ?? 0, value: iso(Number(m[3]), MONTHS.indexOf(m[1].toLowerCase()), Number(m[2])) });
  }
  for (const m of head.matchAll(/\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/gi)) {
    candidates.push({ at: m.index ?? 0, value: iso(Number(m[3]), MONTHS.indexOf(m[2].toLowerCase()), Number(m[1])) });
  }
  for (const m of head.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    candidates.push({ at: m.index ?? 0, value: iso(Number(m[1]), Number(m[2]) - 1, Number(m[3])) });
  }
  const first = candidates.filter((c) => c.value).sort((a, b) => a.at - b.at)[0];
  return first?.value ?? null;
}

// Where the letter's closing text starts: nothing after it belongs to the last deficiency.
const CLOSING =
  /^\s*(If you have any questions|Sincerely|The deficiencies identified above|Please submit your response|Your response (should|must)|We believe that the information|If the requested information is not received|This request for additional information)/im;

/** Split letter text into FDA's numbered deficiencies (pure; exported for the tests). */
export function splitDeficiencies(raw: string): { number: number; text: string }[] {
  const text = raw.replace(/\r\n?/g, '\n');
  const marks: { number: number; start: number; bodyStart: number }[] = [];
  const re = /^[ \t]*(?:Deficiency\s+)?(\d{1,3})[.)][ \t]+(?=\S)/gim;
  for (const m of text.matchAll(re)) {
    marks.push({ number: Number(m[1]), start: m.index ?? 0, bodyStart: (m.index ?? 0) + m[0].length });
  }
  // The longest run 1, 2, 3 ...: numbered lines that break the sequence (a list inside a
  // deficiency, a numbered address line) are part of the text around them.
  let best: typeof marks = [];
  for (let i = 0; i < marks.length; i++) {
    if (marks[i].number !== 1) continue;
    const run = [marks[i]];
    for (let j = i + 1; j < marks.length; j++) if (marks[j].number === run[run.length - 1].number + 1) run.push(marks[j]);
    if (run.length > best.length) best = run;
  }
  return best.map((m, k) => {
    const end = k + 1 < best.length ? best[k + 1].start : text.length;
    let body = text.slice(m.bodyStart, end);
    if (k === best.length - 1) {
      const close = CLOSING.exec(body);
      if (close) body = body.slice(0, close.index);
    }
    return { number: m.number, text: body.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_ITEM) };
  });
}

/** A one-line summary for the tracker: the first sentence, at most 300 characters. */
export function summarise(item: string): string {
  const flat = item.replace(/\s+/g, ' ').trim();
  const sentence = /^(.{20,}?[.?!])(\s|$)/.exec(flat)?.[1] ?? flat;
  return sentence.length > 300 ? `${sentence.slice(0, 297).trimEnd()}...` : sentence;
}

async function letterText(orgId: string, projectId: string, fileVersionId: string): Promise<string> {
  const [v] = await dataService.query<{ id: string; parse_status: string }>(
    { orgId },
    'file_versions',
    `SELECT v.id, v.parse_status FROM file_versions v JOIN files f ON f.id = v.file_id AND f.org_id = v.org_id
      WHERE v.id = $1 AND v.org_id = $2 AND f.project_id = $3`,
    [fileVersionId, orgId, projectId],
  );
  if (!v) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Letter file not found in this project');
  if (v.parse_status !== 'parsed') throw new AppError(409, ErrorCodes.FILE_NOT_READ, 'The letter file has not been read yet. Try again when it shows as read.');
  const rows = await dataService.query<{ text: string }>(
    { orgId },
    'source_locations',
    'SELECT text FROM source_locations WHERE file_version_id = $1 AND org_id = $2 ORDER BY ordinal',
    [fileVersionId, orgId],
  );
  return rows.map((r) => r.text).join('\n');
}

async function sectionTitles(): Promise<Map<string, string>> {
  const rows = await dataService.query<{ id: string; title: string }>({}, 'estar_sections', 'SELECT id, title FROM estar_sections WHERE takes_evidence ORDER BY ordinal');
  return new Map(rows.map((r) => [r.id, r.title]));
}

/** Drafted statements in each section's latest ready draft that cite the current version of these files. */
async function citingStatements(orgId: string, projectId: string, fileIds: string[]): Promise<{ id: string; text: string; sectionTitle: string }[]> {
  if (!fileIds.length) return [];
  return dataService.query<{ id: string; text: string; sectionTitle: string }>(
    { orgId },
    'draft_statements',
    `WITH latest AS (
       SELECT DISTINCT ON (d.project_section_id) d.id, ps.section_id
         FROM section_drafts d JOIN project_sections ps ON ps.id = d.project_section_id AND ps.org_id = d.org_id
        WHERE ps.project_id = $2 AND d.org_id = $1 AND d.status = 'ready'
        ORDER BY d.project_section_id, d.version_no DESC),
     versions AS (SELECT current_version_id AS vid FROM files WHERE org_id = $1 AND project_id = $2 AND id = ANY($3::uuid[]) AND current_version_id IS NOT NULL)
     SELECT s.id, s.text, e.title AS "sectionTitle"
       FROM draft_statements s JOIN latest l ON l.id = s.draft_id JOIN estar_sections e ON e.id = l.section_id
      WHERE s.org_id = $1 AND s.kind = 'statement'
        AND EXISTS (SELECT 1 FROM versions v WHERE s.citations::text LIKE '%C:' || v.vid::text || '#%')
      ORDER BY e.title, s.ordinal
      LIMIT 8`,
    [orgId, projectId, fileIds],
  );
}

export const letterSplitter = {
  /** Propose a letter from its text or from a letter file already in the project. */
  async propose(orgId: string, projectId: string, input: { text?: string; fileVersionId?: string }): Promise<LetterProposal> {
    const raw = input.fileVersionId ? await letterText(orgId, projectId, input.fileVersionId) : (input.text ?? '');
    const text = raw.slice(0, MAX_TEXT);
    const notes: string[] = [];
    if (raw.length > MAX_TEXT) notes.push(`Only the first ${MAX_TEXT.toLocaleString('en-US')} characters were read.`);
    const kind = /refuse\s+to\s+accept|\bRTA\b/i.test(text) ? 'rta_hold' : 'ai_request';
    const fdaReference = /\b[KDP]\d{6}\b/.exec(text)?.[0] ?? null;
    const issuedOn = findLetterDate(text);
    if (!issuedOn) notes.push('No letter date was found: enter the date on the letter so the 180-day clock is right.');
    const items = splitDeficiencies(text);
    if (!items.length) notes.push('No numbered deficiencies were found. Add them by hand, numbered as on the letter.');

    const titles = await sectionTitles();
    const allowed = new Set(titles.keys());
    const deficiencies: ProposedDeficiency[] = [];
    for (const item of items) {
      const summary = summarise(item.text);
      const top = scoreRules('', item.text, allowed)[0];
      const sectionId = top && top.score >= 2 ? top.sectionId : null;
      let files: { id: string; name: string }[] = [];
      try {
        const hits = await hybridSearch({ orgId, projectId, query: item.text.slice(0, 400), limit: 8 });
        const seen = new Map<string, string>();
        for (const h of hits.items) if (!seen.has(h.fileId) && seen.size < 3) seen.set(h.fileId, h.fileName);
        files = [...seen].map(([id, name]) => ({ id, name }));
      } catch (err) {
        console.warn(`[fda-letters] file search for deficiency ${item.number} failed: ${(err as Error).message}`);
      }
      deficiencies.push({
        number: item.number,
        summary,
        fdaText: item.text,
        sectionId,
        sectionTitle: sectionId ? (titles.get(sectionId) ?? null) : null,
        sectionCues: sectionId ? top.cues.slice(0, 4) : [],
        files,
        statements: await citingStatements(orgId, projectId, files.map((f) => f.id)),
      });
    }
    return { kind, fdaReference, issuedOn, dueOn: issuedOn ? addDays(issuedOn, RESPONSE_DAYS) : null, deficiencies, notes };
  },
};
