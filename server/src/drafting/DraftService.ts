import { config } from '../config/env';
import { Permission, roleHasPermission } from '../middleware/authorize';
import { sectionService } from '../sections/SectionService';
import { dataService } from '../services/DataService';
import { AppError, ErrorCodes } from '../utils/AppError';
import { draftFileName, writeDraftDocx } from './docxWriter';
import { BaseStatement, diffImport, ImportSummary, NotADraftDocxError, readDraftDocx } from './roundTrip';
import { generateDraft, saveStatements } from './SectionDrafter';

/**
 * F3.2 drafts of one section: request a generated draft (queued for the worker), read the
 * latest or any version, export it to Word, and import the consultant's edited Word copy as
 * a new version with their edits kept as human-approved.
 */

export type DraftStatus = 'queued' | 'generating' | 'ready' | 'failed';

export interface DraftStatement {
  id: string;
  ordinal: number;
  paragraph: number;
  kind: 'heading' | 'statement';
  text: string;
  citations: { marker: string; label: string }[];
  warnings: string[];
  origin: 'generated' | 'human_edited' | 'human_added';
  humanApproved: boolean;
  approvedBy: string | null;
}

export interface DraftVersion {
  id: string;
  versionNo: number;
  origin: 'generated' | 'imported';
  status: DraftStatus;
  createdAt: string;
}

export interface Draft extends DraftVersion {
  sectionId: string;
  sectionTitle: string;
  basedOnVersion: number | null;
  model: string | null;
  error: string | null;
  createdBy: string | null;
  finishedAt: string | null;
  statements: DraftStatement[];
  removed: { text: string; code: string; reason: string }[];
  importSummary: ImportSummary | null;
}

/** An edited DOCX of one section is small; the JSON body limit (BODY_PARSER_LIMIT) bounds it too. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

interface DraftRow {
  id: string;
  version_no: number;
  origin: 'generated' | 'imported';
  status: DraftStatus;
  created_at: Date;
  based_on_version: number | null;
  model: string | null;
  error: string | null;
  created_by_name: string | null;
  finished_at: Date | null;
  removed_items: { text: string; code: string; reason: string }[];
  import_summary: ImportSummary | null;
}

async function must(orgId: string, userId: string, permission: Permission, what: string): Promise<void> {
  const [m] = await dataService.query<{ role: string }>(
    { orgId, userId },
    'memberships',
    `SELECT r.key AS role FROM memberships m JOIN roles r ON r.id = m.role_id WHERE m.org_id = $1 AND m.user_id = $2 AND m.status = 'active'`,
    [orgId, userId],
  );
  if (!m || !roleHasPermission(m.role, permission)) throw new AppError(403, ErrorCodes.FORBIDDEN, `Your role does not allow this action: ${what}`);
}

async function section(orgId: string, projectSectionId: string): Promise<{ id: string; sectionId: string; title: string; status: string; projectName: string }> {
  const [s] = await dataService.query<{ id: string; section_id: string; title: string; status: string; project_name: string }>(
    { orgId },
    'project_sections',
    `SELECT ps.id, ps.section_id, s.title, ps.status, p.name AS project_name
       FROM project_sections ps JOIN estar_sections s ON s.id = ps.section_id JOIN projects p ON p.id = ps.project_id AND p.org_id = ps.org_id
      WHERE ps.id = $1 AND ps.org_id = $2`,
    [projectSectionId, orgId],
  );
  if (!s) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Section not found');
  return { id: s.id, sectionId: s.section_id, title: s.title, status: s.status, projectName: s.project_name };
}

const DRAFT_SELECT = `SELECT d.id, d.version_no, d.origin, d.status, d.created_at, b.version_no AS based_on_version, d.model, d.error,
         u.full_name AS created_by_name, d.finished_at, d.removed_items, d.import_summary
    FROM section_drafts d
    LEFT JOIN section_drafts b ON b.id = d.based_on_draft_id AND b.org_id = d.org_id
    LEFT JOIN user_profiles u ON u.user_id = d.created_by`;

async function statementsOf(orgId: string, draftId: string): Promise<DraftStatement[]> {
  const rows = await dataService.query<{
    id: string;
    ordinal: number;
    paragraph: number;
    kind: 'heading' | 'statement';
    text: string;
    citations: { marker: string; label: string }[];
    warnings: string[];
    origin: DraftStatement['origin'];
    human_approved: boolean;
    approved_by_name: string | null;
  }>(
    { orgId },
    'draft_statements',
    `SELECT st.id, st.ordinal, st.paragraph, st.kind, st.text, st.citations, st.warnings, st.origin, st.human_approved, u.full_name AS approved_by_name
       FROM draft_statements st LEFT JOIN user_profiles u ON u.user_id = st.approved_by
      WHERE st.org_id = $1 AND st.draft_id = $2 ORDER BY st.ordinal`,
    [orgId, draftId],
  );
  return rows.map((r) => ({
    id: r.id,
    ordinal: r.ordinal,
    paragraph: r.paragraph,
    kind: r.kind,
    text: r.text,
    citations: r.citations,
    warnings: r.warnings,
    origin: r.origin,
    humanApproved: r.human_approved,
    approvedBy: r.approved_by_name,
  }));
}

export const draftService = {
  /** Queue a generated draft of the section. One at a time per section. */
  async request(orgId: string, userId: string, projectSectionId: string): Promise<Draft> {
    await must(orgId, userId, 'projects:write', 'draft a section');
    const s = await section(orgId, projectSectionId);
    const draftId = await dataService.transaction({ orgId, userId }, async (tx) => {
      // Serialise requests for one section so two clicks cannot take the same version number.
      await tx.query('project_sections', 'SELECT id FROM project_sections WHERE id = $1 AND org_id = $2 FOR UPDATE', [projectSectionId, orgId]);
      const [busy] = await tx.query<{ version_no: number }>(
        'section_drafts',
        `SELECT version_no FROM section_drafts WHERE org_id = $1 AND project_section_id = $2 AND status IN ('queued', 'generating') LIMIT 1`,
        [orgId, projectSectionId],
      );
      if (busy) throw new AppError(409, ErrorCodes.DRAFT_IN_PROGRESS, `Draft version ${busy.version_no} of this section is still being written`);
      const [row] = await tx.query<{ id: string }>(
        'section_drafts',
        `INSERT INTO section_drafts (org_id, project_section_id, version_no, origin, status, created_by)
         SELECT $1, $2, COALESCE(max(version_no), 0) + 1, 'generated', 'queued', $3 FROM section_drafts WHERE org_id = $1 AND project_section_id = $2
         RETURNING id`,
        [orgId, projectSectionId, userId],
      );
      return row.id;
    });
    // A section someone starts drafting is in drafting.
    if (s.status === 'not_started') {
      await sectionService.update(orgId, userId, projectSectionId, { status: 'drafting', note: 'Draft requested' }).catch(() => undefined);
    }
    // Development convenience: draft right away so a lone `npm run dev` works without the
    // worker. In production only the worker drafts (draftPass), never the API process.
    if (config.nodeEnv !== 'production') {
      setImmediate(() => {
        generateDraft(orgId, draftId).catch((err) => console.error(`[drafts] dev draft ${draftId} failed: ${(err as Error).message}`));
      });
    }
    return this.get(orgId, projectSectionId, draftId);
  },

  /** Versions of the section's drafts, newest first. */
  async versions(orgId: string, projectSectionId: string): Promise<DraftVersion[]> {
    const rows = await dataService.query<{ id: string; version_no: number; origin: DraftVersion['origin']; status: DraftStatus; created_at: Date }>(
      { orgId },
      'section_drafts',
      'SELECT id, version_no, origin, status, created_at FROM section_drafts WHERE org_id = $1 AND project_section_id = $2 ORDER BY version_no DESC LIMIT 100',
      [orgId, projectSectionId],
    );
    return rows.map((r) => ({ id: r.id, versionNo: r.version_no, origin: r.origin, status: r.status, createdAt: r.created_at.toISOString() }));
  },

  /** One draft by id (must belong to the section). */
  async get(orgId: string, projectSectionId: string, draftId: string): Promise<Draft> {
    const s = await section(orgId, projectSectionId);
    const [r] = await dataService.query<DraftRow>(
      { orgId },
      'section_drafts',
      `${DRAFT_SELECT} WHERE d.id = $1 AND d.org_id = $2 AND d.project_section_id = $3`,
      [draftId, orgId, projectSectionId],
    );
    if (!r) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Draft not found');
    return {
      id: r.id,
      versionNo: r.version_no,
      origin: r.origin,
      status: r.status,
      createdAt: r.created_at.toISOString(),
      sectionId: s.sectionId,
      sectionTitle: s.title,
      basedOnVersion: r.based_on_version,
      model: r.model,
      error: r.error,
      createdBy: r.created_by_name,
      finishedAt: r.finished_at ? r.finished_at.toISOString() : null,
      statements: r.status === 'ready' ? await statementsOf(orgId, r.id) : [],
      removed: r.removed_items,
      importSummary: r.import_summary,
    };
  },

  /** The latest draft (or the given version), plus every version; draft is null before the first request. */
  async current(orgId: string, projectSectionId: string, versionNo?: number): Promise<{ draft: Draft | null; versions: DraftVersion[] }> {
    await section(orgId, projectSectionId);
    const versions: DraftVersion[] = await this.versions(orgId, projectSectionId);
    const pick = versionNo === undefined ? versions[0] : versions.find((v: DraftVersion) => v.versionNo === versionNo);
    if (versionNo !== undefined && !pick) throw new AppError(404, ErrorCodes.NOT_FOUND, `Draft version ${versionNo} not found`);
    return { draft: pick ? await this.get(orgId, projectSectionId, pick.id) : null, versions };
  },

  /** The latest ready draft (or the given version) as a Word document. */
  async exportDocx(orgId: string, projectSectionId: string, versionNo?: number): Promise<{ fileName: string; bytes: Buffer }> {
    const s = await section(orgId, projectSectionId);
    const [r] = await dataService.query<{ id: string; version_no: number; status: DraftStatus; created_at: Date; removed_items: Draft['removed'] }>(
      { orgId },
      'section_drafts',
      `SELECT id, version_no, status, created_at, removed_items FROM section_drafts
        WHERE org_id = $1 AND project_section_id = $2 AND status = 'ready' AND ($3::int IS NULL OR version_no = $3::int)
        ORDER BY version_no DESC LIMIT 1`,
      [orgId, projectSectionId, versionNo ?? null],
    );
    if (!r) throw new AppError(404, ErrorCodes.NOT_FOUND, versionNo === undefined ? 'This section has no finished draft to export yet' : `Draft version ${versionNo} is not finished`);
    const statements = await statementsOf(orgId, r.id);
    const bytes = await writeDraftDocx({
      draftId: r.id,
      versionNo: r.version_no,
      sectionTitle: s.title,
      projectName: s.projectName,
      createdAt: r.created_at,
      statements,
      removed: r.removed_items,
    });
    return { fileName: draftFileName(s.title, r.version_no), bytes };
  },

  /** Import an edited Word copy of one of this section's drafts as a new version. */
  async importDocx(orgId: string, userId: string, projectSectionId: string, input: { fileName: string; contentBase64: string }): Promise<Draft> {
    await must(orgId, userId, 'projects:write', 'import a draft');
    await section(orgId, projectSectionId);
    if (!/\.docx$/i.test(input.fileName)) throw new AppError(415, ErrorCodes.UNSUPPORTED_FILE_TYPE, 'Import the Word document (.docx) that was exported for this section');
    const bytes = Buffer.from(input.contentBase64, 'base64');
    if (bytes.length > MAX_IMPORT_BYTES) throw new AppError(413, ErrorCodes.FILE_TOO_LARGE, `Draft documents up to ${MAX_IMPORT_BYTES / (1024 * 1024)} MB can be imported`);
    let doc;
    try {
      doc = await readDraftDocx(bytes);
    } catch (err) {
      if (err instanceof NotADraftDocxError) throw new AppError(415, ErrorCodes.UNSUPPORTED_FILE_TYPE, err.message);
      throw err;
    }
    const notOurs = () =>
      new AppError(400, ErrorCodes.VALIDATION_ERROR, 'This document was not exported from this section. Export the draft, edit that file and import it.', [
        { field: 'contentBase64', message: 'Not an export of this section' },
      ]);
    if (!doc.draftId || !doc.hasStatementBookmarks) throw notOurs();
    const [base] = await dataService.query<{ id: string; removed_items: Draft['removed'] }>(
      { orgId },
      'section_drafts',
      `SELECT id, removed_items FROM section_drafts WHERE id = $1::uuid AND org_id = $2 AND project_section_id = $3 AND status = 'ready'`,
      [/^[0-9a-f-]{36}$/i.test(doc.draftId) ? doc.draftId : '00000000-0000-0000-0000-000000000000', orgId, projectSectionId],
    );
    if (!base) throw notOurs();
    const baseStatements: BaseStatement[] = (await statementsOf(orgId, base.id)).map((s) => ({ ...s, approvedBy: null }));
    // statementsOf returns names; the diff needs ids for statements left untouched.
    const approvers = await dataService.query<{ id: string; approved_by: string | null }>(
      { orgId },
      'draft_statements',
      'SELECT id, approved_by FROM draft_statements WHERE org_id = $1 AND draft_id = $2',
      [orgId, base.id],
    );
    const approverOf = new Map(approvers.map((a) => [a.id, a.approved_by]));
    baseStatements.forEach((b) => (b.approvedBy = approverOf.get(b.id) ?? null));
    const { statements, summary } = diffImport(baseStatements, doc, userId);

    const draftId = await dataService.transaction({ orgId, userId }, async (tx) => {
      await tx.query('project_sections', 'SELECT id FROM project_sections WHERE id = $1 AND org_id = $2 FOR UPDATE', [projectSectionId, orgId]);
      const [row] = await tx.query<{ id: string }>(
        'section_drafts',
        `INSERT INTO section_drafts (org_id, project_section_id, version_no, origin, status, based_on_draft_id, removed_items, import_summary, created_by, started_at, finished_at)
         SELECT $1, $2, COALESCE(max(version_no), 0) + 1, 'imported', 'ready', $3, $4::jsonb, $5::jsonb, $6, now(), now()
           FROM section_drafts WHERE org_id = $1 AND project_section_id = $2
         RETURNING id`,
        [orgId, projectSectionId, base.id, JSON.stringify(base.removed_items), JSON.stringify(summary), userId],
      );
      await saveStatements(tx, orgId, row.id, statements);
      return row.id;
    });
    return this.get(orgId, projectSectionId, draftId);
  },
};
