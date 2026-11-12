import { Permission, roleHasPermission } from '../middleware/authorize';
import { dataService } from '../services/DataService';
import { AppError, ErrorCodes } from '../utils/AppError';

/**
 * F3.1 review board: the eSTAR sections of a submission with status and reviewer.
 *
 *   not_started -> drafting -> in_review -> approved
 *   in_review -> drafting   (reviewer sends it back)
 *   approved  -> drafting   (reopened)
 *
 * Moving a section along and assigning reviewers needs projects:write; approving and
 * sending back from review need drafts:review. Every change is kept in the history.
 */

export type SectionStatus = 'not_started' | 'drafting' | 'in_review' | 'approved';
export const SECTION_STATUSES: readonly SectionStatus[] = ['not_started', 'drafting', 'in_review', 'approved'];

const ALLOWED: Record<SectionStatus, SectionStatus[]> = {
  not_started: ['drafting'],
  drafting: ['in_review', 'not_started'],
  in_review: ['approved', 'drafting'],
  approved: ['drafting'],
};

export interface BoardSection {
  id: string;
  sectionId: string;
  title: string;
  ordinal: number;
  status: SectionStatus;
  reviewer: { id: string; name: string } | null;
  approvedBy: string | null;
  approvedAt: string | null;
  fileCount: number;
  openProblems: number;
  updatedAt: string;
}

export interface Reviewer {
  id: string;
  name: string;
  role: string;
}

interface Row {
  id: string;
  section_id: string;
  title: string;
  ordinal: number;
  status: SectionStatus;
  reviewer_id: string | null;
  reviewer_name: string | null;
  approved_by_name: string | null;
  approved_at: Date | null;
  file_count: string;
  open_problems: string;
  updated_at: Date;
}

const toSection = (r: Row): BoardSection => ({
  id: r.id,
  sectionId: r.section_id,
  title: r.title,
  ordinal: r.ordinal,
  status: r.status,
  reviewer: r.reviewer_id ? { id: r.reviewer_id, name: r.reviewer_name ?? 'Unknown' } : null,
  approvedBy: r.approved_by_name,
  approvedAt: r.approved_at ? r.approved_at.toISOString() : null,
  fileCount: Number(r.file_count),
  openProblems: Number(r.open_problems),
  updatedAt: r.updated_at.toISOString(),
});

async function roleOf(orgId: string, userId: string): Promise<string | null> {
  const [m] = await dataService.query<{ role: string }>(
    { orgId, userId },
    'memberships',
    `SELECT r.key AS role FROM memberships m JOIN roles r ON r.id = m.role_id WHERE m.org_id = $1 AND m.user_id = $2 AND m.status = 'active'`,
    [orgId, userId],
  );
  return m?.role ?? null;
}

async function must(orgId: string, userId: string, permission: Permission, what: string): Promise<void> {
  const role = await roleOf(orgId, userId);
  if (!role || !roleHasPermission(role, permission)) throw new AppError(403, ErrorCodes.FORBIDDEN, `Your role does not allow this action: ${what}`);
}

const SELECT = `SELECT ps.id, ps.section_id, s.title, s.ordinal, ps.status, ps.reviewer_id, ru.full_name AS reviewer_name,
         au.full_name AS approved_by_name, ps.approved_at, ps.updated_at,
         (SELECT count(*) FROM file_assignments a JOIN files f ON f.id = a.file_id AND f.org_id = a.org_id AND f.status = 'active'
           WHERE a.org_id = ps.org_id AND a.project_id = ps.project_id AND a.is_current AND a.section_id = ps.section_id) AS file_count,
         (SELECT count(*) FROM problems p WHERE p.org_id = ps.org_id AND p.project_id = ps.project_id AND p.status = 'open' AND p.still_present
             AND (p.section_id = ps.section_id OR EXISTS (
               SELECT 1 FROM facts ft JOIN file_assignments a ON a.file_id = ft.file_id AND a.is_current
                WHERE ft.id IN (p.fact_a_id, p.fact_b_id) AND a.section_id = ps.section_id))) AS open_problems
    FROM project_sections ps
    JOIN estar_sections s ON s.id = ps.section_id
    LEFT JOIN user_profiles ru ON ru.user_id = ps.reviewer_id
    LEFT JOIN user_profiles au ON au.user_id = ps.approved_by`;

export const sectionService = {
  /** The board: every section that takes evidence for this submission type, in FDA's order. */
  async board(orgId: string, projectId: string): Promise<{ sections: BoardSection[]; reviewers: Reviewer[] }> {
    const [p] = await dataService.query<{ submission_type: string }>({ orgId }, 'projects', 'SELECT submission_type FROM projects WHERE id = $1 AND org_id = $2', [
      projectId,
      orgId,
    ]);
    if (!p) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
    await dataService.query(
      { orgId },
      'project_sections',
      `INSERT INTO project_sections (org_id, project_id, section_id)
       SELECT $1, $2, s.id FROM estar_sections s WHERE s.takes_evidence AND (s.applies_to = 'all' OR $3 = 'special')
       ON CONFLICT (project_id, section_id) DO NOTHING`,
      [orgId, projectId, p.submission_type],
    );
    const rows = await dataService.query<Row>(
      { orgId },
      'project_sections',
      `${SELECT} WHERE ps.org_id = $1 AND ps.project_id = $2
                   AND (s.applies_to = 'all' OR $3 = 'special')
                 ORDER BY s.ordinal`,
      [orgId, projectId, p.submission_type],
    );
    return { sections: rows.map(toSection), reviewers: await this.reviewers(orgId) };
  },

  /** Firm members whose role may review drafts. */
  async reviewers(orgId: string): Promise<Reviewer[]> {
    const rows = await dataService.query<{ user_id: string; name: string; role: string }>(
      { orgId },
      'memberships',
      `SELECT m.user_id, p.full_name AS name, r.key AS role
         FROM memberships m JOIN roles r ON r.id = m.role_id JOIN user_profiles p ON p.user_id = m.user_id
        WHERE m.org_id = $1 AND m.status = 'active' ORDER BY p.full_name`,
      [orgId],
    );
    return rows.filter((r) => roleHasPermission(r.role, 'drafts:review')).map((r) => ({ id: r.user_id, name: r.name, role: r.role }));
  },

  async get(orgId: string, projectSectionId: string): Promise<BoardSection> {
    const [r] = await dataService.query<Row>({ orgId }, 'project_sections', `${SELECT} WHERE ps.id = $1 AND ps.org_id = $2`, [projectSectionId, orgId]);
    if (!r) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Section not found');
    return toSection(r);
  },

  /** Change status and/or reviewer. reviewerId null removes the reviewer. */
  async update(
    orgId: string,
    userId: string,
    projectSectionId: string,
    change: { status?: SectionStatus; reviewerId?: string | null; note?: string },
  ): Promise<BoardSection> {
    const [cur] = await dataService.query<{ status: SectionStatus; reviewer_id: string | null }>(
      { orgId },
      'project_sections',
      'SELECT status, reviewer_id FROM project_sections WHERE id = $1 AND org_id = $2',
      [projectSectionId, orgId],
    );
    if (!cur) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Section not found');

    if (change.status !== undefined && change.status !== cur.status) {
      if (!ALLOWED[cur.status].includes(change.status)) {
        throw new AppError(409, ErrorCodes.SECTION_STATUS_INVALID, `A section that is ${cur.status.replace('_', ' ')} cannot go to ${change.status.replace('_', ' ')}`);
      }
      const reviewing = change.status === 'approved' || (cur.status === 'in_review' && change.status === 'drafting');
      await must(orgId, userId, reviewing ? 'drafts:review' : 'projects:write', reviewing ? 'review a section' : 'change a section');
    }
    if (change.reviewerId !== undefined && change.reviewerId !== cur.reviewer_id) {
      await must(orgId, userId, 'projects:write', 'assign a reviewer');
      if (change.reviewerId !== null && !(await this.reviewers(orgId)).some((r: Reviewer) => r.id === change.reviewerId)) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'The reviewer must be an active member of this firm whose role can review drafts', [
          { field: 'reviewerId', message: 'Not a reviewer in this firm' },
        ]);
      }
    }

    await dataService.transaction({ orgId, userId }, async (tx) => {
      if (change.status !== undefined && change.status !== cur.status) {
        await tx.query(
          'project_sections',
          `UPDATE project_sections SET status = $3::varchar,
                  approved_by = CASE WHEN $3::varchar = 'approved' THEN $4::uuid ELSE NULL END,
                  approved_at = CASE WHEN $3::varchar = 'approved' THEN now() ELSE NULL END, updated_at = now()
            WHERE id = $1 AND org_id = $2`,
          [projectSectionId, orgId, change.status, userId],
        );
        await tx.query(
          'section_status_events',
          `INSERT INTO section_status_events (org_id, project_section_id, event, from_status, to_status, note, actor_id)
           VALUES ($1, $2, 'status_changed', $3, $4, $5, $6)`,
          [orgId, projectSectionId, cur.status, change.status, change.note ?? null, userId],
        );
      }
      if (change.reviewerId !== undefined && change.reviewerId !== cur.reviewer_id) {
        await tx.query('project_sections', 'UPDATE project_sections SET reviewer_id = $3, updated_at = now() WHERE id = $1 AND org_id = $2', [
          projectSectionId,
          orgId,
          change.reviewerId,
        ]);
        await tx.query(
          'section_status_events',
          `INSERT INTO section_status_events (org_id, project_section_id, event, reviewer_id, note, actor_id) VALUES ($1, $2, $3, $4, $5, $6)`,
          [orgId, projectSectionId, change.reviewerId ? 'reviewer_assigned' : 'reviewer_removed', change.reviewerId ?? cur.reviewer_id, change.note ?? null, userId],
        );
      }
    });
    return this.get(orgId, projectSectionId);
  },

  /** What happened to a section, newest first. */
  async history(orgId: string, projectSectionId: string) {
    await this.get(orgId, projectSectionId);
    const rows = await dataService.query<{
      event: string;
      from_status: string | null;
      to_status: string | null;
      reviewer_name: string | null;
      note: string | null;
      actor_name: string | null;
      created_at: Date;
    }>(
      { orgId },
      'section_status_events',
      `SELECT e.event, e.from_status, e.to_status, r.full_name AS reviewer_name, e.note, a.full_name AS actor_name, e.created_at
         FROM section_status_events e
         LEFT JOIN user_profiles r ON r.user_id = e.reviewer_id
         LEFT JOIN user_profiles a ON a.user_id = e.actor_id
        WHERE e.org_id = $1 AND e.project_section_id = $2 ORDER BY e.created_at DESC LIMIT 100`,
      [orgId, projectSectionId],
    );
    return rows.map((r) => ({
      event: r.event,
      fromStatus: r.from_status,
      toStatus: r.to_status,
      reviewer: r.reviewer_name,
      note: r.note,
      actor: r.actor_name,
      at: r.created_at.toISOString(),
    }));
  },
};
