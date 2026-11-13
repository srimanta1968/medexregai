import { dataService, Tx } from '../services/DataService';
import { AppError, ErrorCodes } from '../utils/AppError';
import { decodeCursor, Page, toPage } from '../utils/pagination';
import { addDays, RESPONSE_DAYS } from './LetterSplitter';

/**
 * F5.1 FDA letters (FR-14.23; UI 2.0 §7.1): a project's Additional Information requests and RTA
 * hold letters, their numbered deficiencies and what each affects (client files, drafted
 * statements), with a deadline clock. A letter is saved only from what the consultant confirmed
 * (the splitter proposes; it never saves).
 */

export type LetterKind = 'ai_request' | 'rta_hold';
export type LetterStatus = 'open' | 'responded' | 'closed';
export type DeficiencyStatus = 'open' | 'requested' | 'drafting' | 'ready' | 'answered';
export type Owner = 'consultant' | 'client';

export interface DeficiencyInput {
  number: number;
  summary: string;
  fdaText: string;
  sectionId?: string | null;
  owner?: Owner;
  dueOn?: string | null;
  fileIds?: string[];
  statementIds?: string[];
}

export interface LetterInput {
  kind: LetterKind;
  fdaReference?: string | null;
  issuedOn: string;
  receivedOn?: string | null;
  dueOn?: string | null;
  fileVersionId?: string | null;
  notes?: string | null;
  deficiencies: DeficiencyInput[];
}

export interface DeficiencyView {
  id: string;
  number: number;
  summary: string;
  fdaText: string;
  sectionId: string | null;
  sectionTitle: string | null;
  owner: Owner;
  status: DeficiencyStatus;
  dueOn: string | null;
  files: { id: string; name: string }[];
  statements: { id: string; text: string }[];
}

export interface LetterSummary {
  id: string;
  projectId: string;
  kind: LetterKind;
  fdaReference: string | null;
  issuedOn: string;
  receivedOn: string | null;
  dueOn: string;
  status: LetterStatus;
  respondedOn: string | null;
  /** Calendar days until dueOn (negative once past); null once the letter is responded or closed. */
  daysLeft: number | null;
  deficiencyCount: number;
  answeredCount: number;
  fileVersionId: string | null;
  notes: string | null;
  createdAt: string;
}

export interface LetterDetail extends LetterSummary {
  deficiencies: DeficiencyView[];
}

const today = (): string => new Date().toISOString().slice(0, 10);
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

interface LetterRow {
  id: string;
  project_id: string;
  kind: LetterKind;
  fda_reference: string | null;
  issued_on: string;
  received_on: string | null;
  due_on: string;
  status: LetterStatus;
  responded_on: string | null;
  file_version_id: string | null;
  notes: string | null;
  created_at: Date;
  deficiency_count: number;
  answered_count: number;
}

const LETTER_SELECT = `SELECT l.id, l.project_id, l.kind, l.fda_reference, l.issued_on::text AS issued_on, l.received_on::text AS received_on,
        l.due_on::text AS due_on, l.status, l.responded_on::text AS responded_on, l.file_version_id, l.notes, l.created_at,
        (SELECT count(*)::int FROM fda_deficiencies d WHERE d.letter_id = l.id) AS deficiency_count,
        (SELECT count(*)::int FROM fda_deficiencies d WHERE d.letter_id = l.id AND d.status = 'answered') AS answered_count
   FROM fda_letters l`;

const toSummary = (r: LetterRow): LetterSummary => ({
  id: r.id,
  projectId: r.project_id,
  kind: r.kind,
  fdaReference: r.fda_reference,
  issuedOn: r.issued_on,
  receivedOn: r.received_on,
  dueOn: r.due_on,
  status: r.status,
  respondedOn: r.responded_on,
  daysLeft: r.status === 'open' ? daysBetween(today(), r.due_on) : null,
  deficiencyCount: r.deficiency_count,
  answeredCount: r.answered_count,
  fileVersionId: r.file_version_id,
  notes: r.notes,
  createdAt: r.created_at.toISOString(),
});

async function projectWorkspace(orgId: string, projectId: string): Promise<string> {
  const [p] = await dataService.query<{ workspace_id: string }>({ orgId }, 'projects', 'SELECT workspace_id FROM projects WHERE id = $1 AND org_id = $2', [projectId, orgId]);
  if (!p) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
  return p.workspace_id;
}

async function letterProject(orgId: string, letterId: string): Promise<string> {
  const [l] = await dataService.query<{ project_id: string }>({ orgId }, 'fda_letters', 'SELECT project_id FROM fda_letters WHERE id = $1 AND org_id = $2', [letterId, orgId]);
  if (!l) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Letter not found');
  return l.project_id;
}

const bad = (field: string, message: string): AppError => new AppError(400, ErrorCodes.VALIDATION_ERROR, message, [{ field, message }]);

/** Every id must belong to this project; returns them de-duplicated. */
async function checkRefs(tx: Tx, orgId: string, projectId: string, field: string, kind: 'file' | 'statement', ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return unique;
  const rows =
    kind === 'file'
      ? await tx.query<{ id: string }>('files', 'SELECT id FROM files WHERE org_id = $1 AND project_id = $2 AND id = ANY($3::uuid[])', [orgId, projectId, unique])
      : await tx.query<{ id: string }>(
          'draft_statements',
          `SELECT s.id FROM draft_statements s
             JOIN section_drafts d ON d.id = s.draft_id AND d.org_id = s.org_id
             JOIN project_sections ps ON ps.id = d.project_section_id AND ps.org_id = d.org_id
            WHERE s.org_id = $1 AND ps.project_id = $2 AND s.id = ANY($3::uuid[])`,
          [orgId, projectId, unique],
        );
  if (rows.length !== unique.length) throw bad(field, kind === 'file' ? 'Every linked file must be in this project' : 'Every linked statement must be in this project');
  return unique;
}

async function checkSection(sectionId: string | null | undefined): Promise<void> {
  if (!sectionId) return;
  const [s] = await dataService.query<{ id: string }>({}, 'estar_sections', 'SELECT id FROM estar_sections WHERE id = $1', [sectionId]);
  if (!s) throw bad('sectionId', 'sectionId is not an eSTAR section');
}

async function replaceLinks(tx: Tx, orgId: string, deficiencyId: string, fileIds: string[], statementIds: string[]): Promise<void> {
  await tx.query('fda_deficiency_links', 'DELETE FROM fda_deficiency_links WHERE deficiency_id = $1 AND org_id = $2', [deficiencyId, orgId]);
  const refs = [...fileIds.map((id) => ['file', id]), ...statementIds.map((id) => ['statement', id])];
  if (!refs.length) return;
  await tx.query(
    'fda_deficiency_links',
    `INSERT INTO fda_deficiency_links (org_id, deficiency_id, kind, ref_id)
     SELECT $1, $2, r.kind, r.ref_id FROM unnest($3::text[], $4::uuid[]) AS r(kind, ref_id)`,
    [orgId, deficiencyId, refs.map((r) => r[0]), refs.map((r) => r[1])],
  );
}

async function insertDeficiency(tx: Tx, orgId: string, letterId: string, projectId: string, d: DeficiencyInput, index: number): Promise<string> {
  await checkSection(d.sectionId);
  const fileIds = await checkRefs(tx, orgId, projectId, `deficiencies.${index}.fileIds`, 'file', d.fileIds ?? []);
  const statementIds = await checkRefs(tx, orgId, projectId, `deficiencies.${index}.statementIds`, 'statement', d.statementIds ?? []);
  let row: { id: string } | undefined;
  try {
    [row] = await tx.query<{ id: string }>(
      'fda_deficiencies',
      `INSERT INTO fda_deficiencies (org_id, letter_id, project_id, number, summary, fda_text, section_id, owner, due_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date) RETURNING id`,
      [orgId, letterId, projectId, d.number, d.summary, d.fdaText, d.sectionId ?? null, d.owner ?? 'consultant', d.dueOn ?? null],
    );
  } catch (err) {
    if ((err as { constraint?: string }).constraint === 'fda_deficiencies_number_uq') {
      throw new AppError(409, ErrorCodes.DUPLICATE_NUMBER, `Deficiency ${d.number} is already on this letter`, [{ field: `deficiencies.${index}.number`, message: 'Already used' }]);
    }
    throw err;
  }
  await replaceLinks(tx, orgId, row!.id, fileIds, statementIds);
  return row!.id;
}

export const fdaLetterService = {
  /** Letters of a project, latest issued first, cursor-paged on (issued_on, id). */
  async list(orgId: string, projectId: string, opts: { limit: number; cursor?: string }): Promise<Page<LetterSummary>> {
    await projectWorkspace(orgId, projectId);
    const c = decodeCursor(opts.cursor);
    const rows = await dataService.query<LetterRow>(
      { orgId },
      'fda_letters',
      `${LETTER_SELECT} WHERE l.org_id = $1 AND l.project_id = $2
          AND ($3::date IS NULL OR (l.issued_on, l.id) < ($3::date, $4::uuid))
        ORDER BY l.issued_on DESC, l.id DESC LIMIT $5`,
      [orgId, projectId, c.createdAt ? c.createdAt.slice(0, 10) : null, c.id, opts.limit + 1],
    );
    // The cursor carries the issue date in its time slot; the row itself is kept as it is.
    return toPage(
      rows.map((row) => ({ id: row.id, created_at: `${row.issued_on}T00:00:00.000Z`, row })),
      opts.limit,
      (x) => toSummary(x.row),
    );
  },

  /** 404 unless the project is in the caller's firm. */
  async assertProject(orgId: string, projectId: string): Promise<void> {
    await projectWorkspace(orgId, projectId);
  },

  async get(orgId: string, letterId: string): Promise<LetterDetail> {
    const [r] = await dataService.query<LetterRow>({ orgId }, 'fda_letters', `${LETTER_SELECT} WHERE l.id = $1 AND l.org_id = $2`, [letterId, orgId]);
    if (!r) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Letter not found');
    const defs = await dataService.query<{
      id: string;
      number: number;
      summary: string;
      fda_text: string;
      section_id: string | null;
      section_title: string | null;
      owner: Owner;
      status: DeficiencyStatus;
      due_on: string | null;
    }>(
      { orgId },
      'fda_deficiencies',
      `SELECT d.id, d.number, d.summary, d.fda_text, d.section_id, e.title AS section_title, d.owner, d.status, d.due_on::text AS due_on
         FROM fda_deficiencies d LEFT JOIN estar_sections e ON e.id = d.section_id
        WHERE d.letter_id = $1 AND d.org_id = $2 ORDER BY d.number`,
      [letterId, orgId],
    );
    const links = await dataService.query<{ deficiency_id: string; kind: 'file' | 'statement'; ref_id: string; label: string | null }>(
      { orgId },
      'fda_deficiency_links',
      `SELECT k.deficiency_id, k.kind, k.ref_id,
              CASE WHEN k.kind = 'file' THEN (SELECT f.name FROM files f WHERE f.id = k.ref_id AND f.org_id = k.org_id)
                   ELSE (SELECT left(s.text, 240) FROM draft_statements s WHERE s.id = k.ref_id AND s.org_id = k.org_id) END AS label
         FROM fda_deficiency_links k JOIN fda_deficiencies d ON d.id = k.deficiency_id
        WHERE d.letter_id = $1 AND k.org_id = $2 ORDER BY k.created_at`,
      [letterId, orgId],
    );
    return {
      ...toSummary(r),
      deficiencies: defs.map((d) => {
        const mine = links.filter((k) => k.deficiency_id === d.id && k.label !== null);
        return {
          id: d.id,
          number: d.number,
          summary: d.summary,
          fdaText: d.fda_text,
          sectionId: d.section_id,
          sectionTitle: d.section_title,
          owner: d.owner,
          status: d.status,
          dueOn: d.due_on,
          files: mine.filter((k) => k.kind === 'file').map((k) => ({ id: k.ref_id, name: k.label ?? '' })),
          statements: mine.filter((k) => k.kind === 'statement').map((k) => ({ id: k.ref_id, text: k.label ?? '' })),
        };
      }),
    };
  },

  /** Save a letter and the deficiencies the consultant confirmed. */
  async create(orgId: string, userId: string, projectId: string, input: LetterInput): Promise<LetterDetail> {
    const workspaceId = await projectWorkspace(orgId, projectId);
    const numbers = input.deficiencies.map((d) => d.number);
    const dup = numbers.find((n, i) => numbers.indexOf(n) !== i);
    if (dup !== undefined) throw new AppError(409, ErrorCodes.DUPLICATE_NUMBER, `Deficiency ${dup} appears twice`, [{ field: 'deficiencies', message: 'Numbers must be unique' }]);
    const dueOn = input.dueOn ?? addDays(input.issuedOn, RESPONSE_DAYS);
    if (dueOn < input.issuedOn) throw bad('dueOn', 'dueOn must not be before issuedOn');
    if (input.receivedOn && input.receivedOn < input.issuedOn) throw bad('receivedOn', 'receivedOn must not be before issuedOn');
    const id = await dataService.transaction({ orgId }, async (tx) => {
      if (input.fileVersionId) {
        const [v] = await tx.query<{ id: string }>(
          'file_versions',
          'SELECT v.id FROM file_versions v JOIN files f ON f.id = v.file_id AND f.org_id = v.org_id WHERE v.id = $1 AND v.org_id = $2 AND f.project_id = $3',
          [input.fileVersionId, orgId, projectId],
        );
        if (!v) throw bad('fileVersionId', 'The letter file must be in this project');
      }
      const [l] = await tx.query<{ id: string }>(
        'fda_letters',
        `INSERT INTO fda_letters (org_id, workspace_id, project_id, kind, fda_reference, issued_on, received_on, due_on, file_version_id, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8::date, $9, $10, $11) RETURNING id`,
        [orgId, workspaceId, projectId, input.kind, input.fdaReference ?? null, input.issuedOn, input.receivedOn ?? null, dueOn, input.fileVersionId ?? null, input.notes ?? null, userId],
      );
      for (const [i, d] of input.deficiencies.entries()) await insertDeficiency(tx, orgId, l.id, projectId, d, i);
      return l.id;
    });
    return this.get(orgId, id);
  },

  async update(
    orgId: string,
    letterId: string,
    patch: { status?: LetterStatus; respondedOn?: string | null; fdaReference?: string | null; receivedOn?: string | null; dueOn?: string; notes?: string | null },
  ): Promise<LetterDetail> {
    const [cur] = await dataService.query<{ issued_on: string; status: LetterStatus; responded_on: string | null }>(
      { orgId },
      'fda_letters',
      'SELECT issued_on::text AS issued_on, status, responded_on::text AS responded_on FROM fda_letters WHERE id = $1 AND org_id = $2',
      [letterId, orgId],
    );
    if (!cur) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Letter not found');
    if (patch.dueOn && patch.dueOn < cur.issued_on) throw bad('dueOn', 'dueOn must not be before the letter date');
    if (patch.receivedOn && patch.receivedOn < cur.issued_on) throw bad('receivedOn', 'receivedOn must not be before the letter date');
    // Marking it responded records the day, unless one is given.
    const respondedOn =
      patch.respondedOn !== undefined ? patch.respondedOn : patch.status === 'responded' && !cur.responded_on ? today() : patch.status === 'open' ? null : cur.responded_on;
    await dataService.query(
      { orgId },
      'fda_letters',
      `UPDATE fda_letters SET
          status = COALESCE($3, status),
          responded_on = $4::date,
          fda_reference = CASE WHEN $5 THEN $6 ELSE fda_reference END,
          received_on = CASE WHEN $7 THEN $8::date ELSE received_on END,
          due_on = COALESCE($9::date, due_on),
          notes = CASE WHEN $10 THEN $11 ELSE notes END,
          updated_at = now()
        WHERE id = $1 AND org_id = $2`,
      [
        letterId,
        orgId,
        patch.status ?? null,
        respondedOn,
        patch.fdaReference !== undefined,
        patch.fdaReference ?? null,
        patch.receivedOn !== undefined,
        patch.receivedOn ?? null,
        patch.dueOn ?? null,
        patch.notes !== undefined,
        patch.notes ?? null,
      ],
    );
    return this.get(orgId, letterId);
  },

  async remove(orgId: string, letterId: string): Promise<void> {
    await letterProject(orgId, letterId);
    await dataService.query({ orgId }, 'fda_letters', 'DELETE FROM fda_letters WHERE id = $1 AND org_id = $2', [letterId, orgId]);
  },

  /** A deficiency missed when the letter was split. */
  async addDeficiency(orgId: string, letterId: string, d: DeficiencyInput): Promise<DeficiencyView> {
    const projectId = await letterProject(orgId, letterId);
    const id = await dataService.transaction({ orgId }, (tx) => insertDeficiency(tx, orgId, letterId, projectId, d, 0));
    return this.deficiency(orgId, id);
  },

  async deficiency(orgId: string, deficiencyId: string): Promise<DeficiencyView> {
    const [d] = await dataService.query<{ letter_id: string }>({ orgId }, 'fda_deficiencies', 'SELECT letter_id FROM fda_deficiencies WHERE id = $1 AND org_id = $2', [deficiencyId, orgId]);
    if (!d) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Deficiency not found');
    const letter: LetterDetail = await this.get(orgId, d.letter_id);
    return letter.deficiencies.find((x: DeficiencyView) => x.id === deficiencyId)!;
  },

  async updateDeficiency(
    orgId: string,
    deficiencyId: string,
    patch: { summary?: string; sectionId?: string | null; owner?: Owner; status?: DeficiencyStatus; dueOn?: string | null },
  ): Promise<DeficiencyView> {
    await this.deficiency(orgId, deficiencyId);
    await checkSection(patch.sectionId);
    await dataService.query(
      { orgId },
      'fda_deficiencies',
      `UPDATE fda_deficiencies SET
          summary = COALESCE($3, summary),
          section_id = CASE WHEN $4 THEN $5 ELSE section_id END,
          owner = COALESCE($6, owner),
          status = COALESCE($7, status),
          due_on = CASE WHEN $8 THEN $9::date ELSE due_on END,
          updated_at = now()
        WHERE id = $1 AND org_id = $2`,
      [
        deficiencyId,
        orgId,
        patch.summary ?? null,
        patch.sectionId !== undefined,
        patch.sectionId ?? null,
        patch.owner ?? null,
        patch.status ?? null,
        patch.dueOn !== undefined,
        patch.dueOn ?? null,
      ],
    );
    return this.deficiency(orgId, deficiencyId);
  },

  /** Replace what a deficiency affects. */
  async setLinks(orgId: string, deficiencyId: string, links: { fileIds: string[]; statementIds: string[] }): Promise<DeficiencyView> {
    const [d] = await dataService.query<{ project_id: string }>({ orgId }, 'fda_deficiencies', 'SELECT project_id FROM fda_deficiencies WHERE id = $1 AND org_id = $2', [
      deficiencyId,
      orgId,
    ]);
    if (!d) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Deficiency not found');
    await dataService.transaction({ orgId }, async (tx) => {
      const fileIds = await checkRefs(tx, orgId, d.project_id, 'fileIds', 'file', links.fileIds);
      const statementIds = await checkRefs(tx, orgId, d.project_id, 'statementIds', 'statement', links.statementIds);
      await replaceLinks(tx, orgId, deficiencyId, fileIds, statementIds);
    });
    return this.deficiency(orgId, deficiencyId);
  },
};
