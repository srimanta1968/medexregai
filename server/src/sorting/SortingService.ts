import { dataService } from '../services/DataService';
import { AppError, ErrorCodes } from '../utils/AppError';
import { decodeCursor, Page, toPage } from '../utils/pagination';
import { CONFIDENT, sectionClassifier } from './SectionClassifier';

/** F2.2 read side of the sorted folder: files with their section, coverage and the first-hour checklist. */

export interface EstarSection {
  id: string;
  ordinal: number;
  title: string;
  description: string;
  appliesTo: 'all' | 'special_510k';
  takesEvidence: boolean;
  edition: string;
  source: string;
}

export interface Assignment {
  sectionId: string | null;
  sectionTitle: string | null;
  confidence: number;
  source: 'rules' | 'embedding' | 'llm' | 'consultant';
  /** Why this section, shown on hover. */
  reason: string;
  /** The sorter is not sure: the screen asks the consultant. */
  needsReview: boolean;
  decidedAt: string;
}

export interface SortedFile {
  id: string;
  name: string;
  source: string;
  path: string | null;
  versionCount: number;
  parseStatus: string | null;
  unreadable: boolean;
  assignment: Assignment | null;
  createdAt: string;
}

export interface CoverageSection {
  id: string;
  title: string;
  ordinal: number;
  fileCount: number;
  /** No file yet: evidence the submission is missing (or that is not needed for this device). */
  empty: boolean;
}

export interface ChecklistStep {
  key: 'files_added' | 'files_read' | 'files_sorted' | 'sorting_confirmed' | 'versions_confirmed' | 'coverage_reviewed';
  label: string;
  done: boolean;
  detail: string;
}

interface AssignmentRow {
  section_id: string | null;
  section_title: string | null;
  confidence: string;
  source: Assignment['source'];
  reason: string;
  created_at: string;
}

const toAssignment = (a: AssignmentRow | null): Assignment | null =>
  a
    ? {
        sectionId: a.section_id,
        sectionTitle: a.section_title,
        confidence: Number(a.confidence),
        source: a.source,
        reason: a.reason,
        needsReview: a.source !== 'consultant' && (a.section_id === null || Number(a.confidence) < CONFIDENT),
        decidedAt: new Date(a.created_at).toISOString(),
      }
    : null;

async function project(orgId: string, projectId: string): Promise<{ submission_type: string }> {
  const [p] = await dataService.query<{ submission_type: string }>(
    { orgId },
    'projects',
    'SELECT submission_type FROM projects WHERE id = $1 AND org_id = $2',
    [projectId, orgId],
  );
  if (!p) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
  return p;
}

export const sortingService = {
  /** The eSTAR sections (FDA reference data), in FDA's order. */
  async sections(): Promise<EstarSection[]> {
    const rows = await dataService.query<{
      id: string;
      ordinal: number;
      title: string;
      fda_description: string;
      applies_to: 'all' | 'special_510k';
      takes_evidence: boolean;
      edition: string;
      source: string;
    }>({}, 'estar_sections', 'SELECT id, ordinal, title, fda_description, applies_to, takes_evidence, edition, source FROM estar_sections ORDER BY ordinal');
    return rows.map((r) => ({
      id: r.id,
      ordinal: r.ordinal,
      title: r.title,
      description: r.fda_description,
      appliesTo: r.applies_to,
      takesEvidence: r.takes_evidence,
      edition: r.edition,
      source: r.source,
    }));
  },

  /** A project's files with their current section, optionally one section ("none" = unsorted). */
  async files(orgId: string, projectId: string, size: number, cursor?: string, section?: string): Promise<Page<SortedFile>> {
    await project(orgId, projectId);
    const c = decodeCursor(cursor);
    const rows = await dataService.query<{
      id: string;
      name: string;
      source: string;
      source_path: string | null;
      version_count: number;
      parse_status: string | null;
      unreadable: boolean;
      assignment: AssignmentRow | null;
      created_at: Date;
    }>(
      { orgId },
      'files',
      `SELECT f.id, f.name, f.source, f.source_path, f.version_count, f.created_at, v.parse_status,
              COALESCE(f.unreadable_kind IS NOT NULL OR v.unreadable_kind IS NOT NULL OR v.parse_status IN ('failed', 'unsupported'), false) AS unreadable,
              (SELECT row_to_json(x) FROM (SELECT a.section_id, s.title AS section_title, a.confidence, a.source, a.reason, a.created_at
                                             FROM file_assignments a LEFT JOIN estar_sections s ON s.id = a.section_id
                                            WHERE a.file_id = f.id AND a.org_id = f.org_id AND a.is_current) x) AS assignment
         FROM files f
         -- The latest version, read or not (current_version_id is set only once a version is read).
         LEFT JOIN LATERAL (SELECT parse_status, unreadable_kind FROM file_versions
                             WHERE file_id = f.id AND org_id = f.org_id ORDER BY version_no DESC LIMIT 1) v ON true
        WHERE f.org_id = $1 AND f.project_id = $2 AND f.status = 'active'
          AND ($3::text IS NULL
               OR ($3 = 'none' AND NOT EXISTS (SELECT 1 FROM file_assignments a WHERE a.file_id = f.id AND a.is_current AND a.section_id IS NOT NULL))
               OR EXISTS (SELECT 1 FROM file_assignments a WHERE a.file_id = f.id AND a.is_current AND a.section_id = $3))
          AND ($4::timestamptz IS NULL OR (f.created_at, f.id) < ($4::timestamptz, $5::uuid))
        ORDER BY f.created_at DESC, f.id DESC
        LIMIT $6`,
      [orgId, projectId, section ?? null, c.createdAt, c.id, size + 1],
    );
    return toPage(rows, size, (r) => ({
      id: r.id,
      name: r.name,
      source: r.source,
      path: r.source_path,
      versionCount: r.version_count,
      parseStatus: r.parse_status,
      unreadable: r.unreadable,
      assignment: toAssignment(r.assignment),
      createdAt: r.created_at.toISOString(),
    }));
  },

  /** Every evidence section with its file count (empty = no evidence yet), and the first-hour checklist. */
  async coverage(orgId: string, projectId: string): Promise<{ sections: CoverageSection[]; checklist: ChecklistStep[]; totals: Record<string, number> }> {
    const p = await project(orgId, projectId);
    const sections = await dataService.query<{ id: string; title: string; ordinal: number; n: string }>(
      { orgId },
      'file_assignments',
      `SELECT s.id, s.title, s.ordinal,
              (SELECT count(*) FROM file_assignments a JOIN files f ON f.id = a.file_id AND f.org_id = a.org_id AND f.status = 'active'
                WHERE a.org_id = $1 AND a.project_id = $2 AND a.is_current AND a.section_id = s.id) AS n
         FROM estar_sections s
        WHERE s.takes_evidence AND (s.applies_to = 'all' OR $3 = 'special')
        ORDER BY s.ordinal`,
      [orgId, projectId, p.submission_type],
    );
    const [t] = await dataService.query<{ files: string; read: string; unreadable: string; sorted: string; unsure: string; links: string }>(
      { orgId },
      'files',
      `SELECT count(*) AS files,
              count(*) FILTER (WHERE v.parse_status = 'parsed' AND v.unreadable_kind IS NULL) AS read,
              count(*) FILTER (WHERE f.unreadable_kind IS NOT NULL OR v.unreadable_kind IS NOT NULL OR v.parse_status IN ('failed', 'unsupported')) AS unreadable,
              count(*) FILTER (WHERE a.section_id IS NOT NULL) AS sorted,
              count(*) FILTER (WHERE a.source IS NOT NULL AND a.source <> 'consultant' AND (a.section_id IS NULL OR a.confidence < $3)) AS unsure,
              (SELECT count(*) FROM project_folder_links l WHERE l.project_id = $2 AND l.org_id = $1 AND l.status <> 'unlinked') AS links
         FROM files f
         -- The latest version, read or not (current_version_id is set only once a version is read).
         LEFT JOIN LATERAL (SELECT parse_status, unreadable_kind FROM file_versions
                             WHERE file_id = f.id AND org_id = f.org_id ORDER BY version_no DESC LIMIT 1) v ON true
         LEFT JOIN file_assignments a ON a.file_id = f.id AND a.org_id = f.org_id AND a.is_current
        WHERE f.org_id = $1 AND f.project_id = $2 AND f.status = 'active'`,
      [orgId, projectId, CONFIDENT],
    );
    const [vg] = await dataService.query<{ unclear: string }>(
      { orgId },
      'file_revision_groups',
      "SELECT count(*) AS unclear FROM file_revision_groups WHERE org_id = $1 AND project_id = $2 AND status = 'unclear'",
      [orgId, projectId],
    );
    const unclearVersions = Number(vg.unclear);
    const n = (k: keyof typeof t) => Number(t[k]);
    const cov = sections.map((s) => ({ id: s.id, title: s.title, ordinal: s.ordinal, fileCount: Number(s.n), empty: Number(s.n) === 0 }));
    const empty = cov.filter((s) => s.empty).length;
    const readable = n('files') - n('unreadable');
    const checklist: ChecklistStep[] = [
      {
        key: 'files_added',
        label: 'Connect a folder or add files',
        done: n('files') > 0,
        detail: n('links') ? `${n('links')} folder(s) linked, ${n('files')} file(s)` : `${n('files')} file(s)`,
      },
      {
        key: 'files_read',
        label: 'Files read',
        done: n('files') > 0 && n('read') >= readable,
        detail: `${n('read')} of ${n('files')} read${n('unreadable') ? `, ${n('unreadable')} could not be read` : ''}`,
      },
      { key: 'files_sorted', label: 'Files sorted into eSTAR sections', done: n('files') > 0 && n('sorted') + n('unreadable') >= n('files'), detail: `${n('sorted')} sorted` },
      {
        key: 'sorting_confirmed',
        label: 'Confirm the files the sorter was unsure about',
        done: n('files') > 0 && n('unsure') === 0,
        detail: n('unsure') ? `${n('unsure')} to confirm` : 'Nothing to confirm',
      },
      {
        key: 'versions_confirmed',
        label: 'Confirm unclear versions',
        done: n('files') > 0 && unclearVersions === 0,
        detail: unclearVersions ? `${unclearVersions} file group(s) where the current version is unclear` : 'No unclear versions',
      },
      {
        key: 'coverage_reviewed',
        label: 'Check sections with no evidence',
        done: n('files') > 0 && empty === 0,
        detail: `${empty} of ${cov.length} sections have no files`,
      },
    ];
    return {
      sections: cov,
      checklist,
      totals: { files: n('files'), read: n('read'), unreadable: n('unreadable'), sorted: n('sorted'), unsure: n('unsure'), unclearVersions, sectionsWithoutEvidence: empty },
    };
  },

  /** A consultant files a file (or marks it as not evidence); returns the new assignment. */
  async reassign(orgId: string, userId: string, fileId: string, sectionId: string | null): Promise<{ fileId: string; assignment: Assignment }> {
    await sectionClassifier.reassign(orgId, userId, fileId, sectionId);
    const [a] = await dataService.query<AssignmentRow & { project_id: string }>(
      { orgId },
      'file_assignments',
      `SELECT a.section_id, s.title AS section_title, a.confidence, a.source, a.reason, a.created_at, a.project_id
         FROM file_assignments a LEFT JOIN estar_sections s ON s.id = a.section_id
        WHERE a.file_id = $1 AND a.org_id = current_setting('app.org_id')::uuid AND a.is_current`,
      [fileId],
    );
    return { fileId, assignment: toAssignment(a)! };
  },
};
