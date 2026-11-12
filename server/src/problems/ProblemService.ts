import { dataService } from '../services/DataService';
import { auditService } from '../services/AuditService';
import { AppError, ErrorCodes } from '../utils/AppError';
import { decodeCursor, Page, toPage } from '../utils/pagination';
import { problemEngine } from './ProblemEngine';

/**
 * F2.3 /problems: the list, one problem with both sources side by side, and the
 * consultant's decision. Nothing in the client's documents is ever changed.
 */

export type Decision = 'note_for_client' | 'request_data' | 'accepted' | 'add_to_request' | 'dismissed';
export const DECISIONS: readonly Decision[] = ['note_for_client', 'request_data', 'accepted', 'add_to_request', 'dismissed'];

export interface ProblemSummary {
  id: string;
  kind: 'contradiction' | 'gap';
  title: string;
  severity: 'high' | 'medium' | 'low';
  severityReason: string;
  status: 'open' | 'resolved' | 'dismissed';
  stillPresent: boolean;
  sectionId: string | null;
  createdAt: string;
}

export interface ProblemSource {
  factId: string;
  fileId: string;
  fileName: string;
  versionNo: number;
  current: boolean;
  revisionLabel: string | null;
  where: string;
  label: string;
  value: string;
  quote: string;
}

export interface ProblemDetail extends ProblemSummary {
  detail: string | null;
  sources: ProblemSource[];
  decision: Decision | null;
  decisionNote: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  requestItemId: string | null;
}

interface Row {
  id: string;
  kind: ProblemSummary['kind'];
  title: string;
  severity: ProblemSummary['severity'];
  severity_reason: string;
  status: ProblemSummary['status'];
  still_present: boolean;
  section_id: string | null;
  created_at: Date;
}

const toSummary = (r: Row): ProblemSummary => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  severity: r.severity,
  severityReason: r.severity_reason,
  status: r.status,
  stillPresent: r.still_present,
  sectionId: r.section_id,
  createdAt: r.created_at.toISOString(),
});

async function assertProject(orgId: string, projectId: string): Promise<void> {
  const [p] = await dataService.query<{ id: string }>({ orgId }, 'projects', 'SELECT id FROM projects WHERE id = $1 AND org_id = $2', [projectId, orgId]);
  if (!p) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
}

export const problemService = {
  /** Problems of a project still found by the latest check; open first, then by severity. */
  async list(
    orgId: string,
    projectId: string,
    status: 'open' | 'resolved' | 'dismissed' | 'all',
    size: number,
    cursor?: string,
  ): Promise<Page<ProblemSummary> & { counts: { contradictions: number; gaps: number; open: number } }> {
    await assertProject(orgId, projectId);
    const c = decodeCursor(cursor);
    const rows = await dataService.query<Row>(
      { orgId },
      'problems',
      `SELECT id, kind, title, severity, severity_reason, status, still_present, section_id, created_at FROM problems
        WHERE org_id = $1 AND project_id = $2 AND still_present AND ($3 = 'all' OR status = $3)
          AND ($4::timestamptz IS NULL OR (created_at, id) < ($4::timestamptz, $5::uuid))
        ORDER BY created_at DESC, id DESC LIMIT $6`,
      [orgId, projectId, status, c.createdAt, c.id, size + 1],
    );
    const page = toPage(rows, size, toSummary);
    const rank = { high: 0, medium: 1, low: 2 } as const;
    page.items.sort((a, b) => Number(a.status !== 'open') - Number(b.status !== 'open') || rank[a.severity] - rank[b.severity]);
    const [n] = await dataService.query<{ contradictions: string; gaps: string; open: string }>(
      { orgId },
      'problems',
      `SELECT count(*) FILTER (WHERE kind = 'contradiction' AND status = 'open') AS contradictions,
              count(*) FILTER (WHERE kind = 'gap' AND status = 'open') AS gaps,
              count(*) FILTER (WHERE status = 'open') AS open
         FROM problems WHERE org_id = $1 AND project_id = $2 AND still_present`,
      [orgId, projectId],
    );
    return { ...page, counts: { contradictions: Number(n.contradictions), gaps: Number(n.gaps), open: Number(n.open) } };
  },

  /** One problem with both sources: file, version, page and the exact words. */
  async get(orgId: string, problemId: string): Promise<ProblemDetail> {
    const [p] = await dataService.query<
      Row & { detail: string | null; fact_a_id: string | null; fact_b_id: string | null; decision: Decision | null; decision_note: string | null; decided_by_name: string | null; decided_at: Date | null; item_id: string | null }
    >(
      { orgId },
      'problems',
      `SELECT p.id, p.kind, p.title, p.severity, p.severity_reason, p.status, p.still_present, p.section_id, p.created_at, p.detail,
              p.fact_a_id, p.fact_b_id, p.decision, p.decision_note, p.decided_at, up.full_name AS decided_by_name,
              (SELECT i.id FROM client_request_items i WHERE i.org_id = p.org_id AND i.gap_ref = 'problem:' || p.id LIMIT 1) AS item_id
         FROM problems p LEFT JOIN user_profiles up ON up.user_id = p.decided_by
        WHERE p.id = $1 AND p.org_id = $2`,
      [problemId, orgId],
    );
    if (!p) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Problem not found');
    const ids = [p.fact_a_id, p.fact_b_id].filter((x): x is string => !!x);
    const sources = ids.length
      ? await dataService.query<{
          id: string;
          file_id: string;
          name: string;
          version_no: number;
          current: boolean;
          revision_label: string | null;
          page: number | null;
          sheet: string | null;
          slide: number | null;
          section_path: string | null;
          label: string;
          value: string;
          quote: string;
        }>(
          { orgId },
          'facts',
          `SELECT ft.id, ft.file_id, f.name, v.version_no, (f.current_version_id = ft.version_id) AS current,
                  (SELECT m.revision_label FROM file_revision_members m WHERE m.file_id = f.id LIMIT 1) AS revision_label,
                  l.page, l.sheet, l.slide, l.section_path, ft.label, ft.value, ft.quote
             FROM facts ft
             JOIN files f ON f.id = ft.file_id AND f.org_id = ft.org_id
             JOIN file_versions v ON v.id = ft.version_id AND v.org_id = ft.org_id
             LEFT JOIN source_locations l ON l.id = ft.location_id
            WHERE ft.org_id = $1 AND ft.id = ANY($2::uuid[])`,
          [orgId, ids],
        )
      : [];
    const where = (s: (typeof sources)[number]) =>
      s.page ? `page ${s.page}` : s.sheet ? `sheet ${s.sheet}` : s.slide ? `slide ${s.slide}` : (s.section_path ?? 'text');
    return {
      ...toSummary(p),
      detail: p.detail,
      sources: ids
        .map((id) => sources.find((s) => s.id === id))
        .filter((s): s is (typeof sources)[number] => !!s)
        .map((s) => ({
          factId: s.id,
          fileId: s.file_id,
          fileName: s.name,
          versionNo: s.version_no,
          current: s.current,
          revisionLabel: s.revision_label,
          where: where(s),
          label: s.label,
          value: s.value,
          quote: s.quote,
        })),
      decision: p.decision,
      decisionNote: p.decision_note,
      decidedBy: p.decided_by_name,
      decidedAt: p.decided_at ? p.decided_at.toISOString() : null,
      requestItemId: p.item_id,
    };
  },

  /**
   * The consultant decides. Dismiss closes it as not a problem; every other choice
   * resolves it. "Request data" and "add to client request" also add an item to the
   * project's draft client request (created if there is none), linked to the problem;
   * nothing reaches the client until that request is approved.
   */
  async decide(orgId: string, userId: string, problemId: string, decision: Decision, note: string): Promise<ProblemDetail> {
    await dataService.transaction({ orgId, userId }, async (tx) => {
      const [p] = await tx.query<{ id: string; project_id: string; title: string; kind: string; section_id: string | null; status: string }>(
        'problems',
        'SELECT id, project_id, title, kind, section_id, status FROM problems WHERE id = $1 AND org_id = $2 FOR UPDATE',
        [problemId, orgId],
      );
      if (!p) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Problem not found');
      await tx.query(
        'problems',
        `UPDATE problems SET status = $3, decision = $4, decision_note = $5, decided_by = $6, decided_at = now(), updated_at = now()
          WHERE id = $1 AND org_id = $2`,
        [problemId, orgId, decision === 'dismissed' ? 'dismissed' : 'resolved', decision, note, userId],
      );
      if (decision === 'request_data' || decision === 'add_to_request') {
        const ref = `problem:${problemId}`;
        const [already] = await tx.query<{ id: string }>('client_request_items', 'SELECT id FROM client_request_items WHERE org_id = $1 AND gap_ref = $2', [orgId, ref]);
        if (!already) {
          let [draft] = await tx.query<{ id: string }>(
            'client_requests',
            "SELECT id FROM client_requests WHERE org_id = $1 AND project_id = $2 AND status = 'draft' ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
            [orgId, p.project_id],
          );
          if (!draft) {
            [draft] = await tx.query<{ id: string }>(
              'client_requests',
              `INSERT INTO client_requests (org_id, project_id, title, message, created_by) VALUES ($1, $2, 'Items from the problems review', '', $3) RETURNING id`,
              [orgId, p.project_id, userId],
            );
          }
          const [{ next }] = await tx.query<{ next: number }>(
            'client_request_items',
            'SELECT COALESCE(max(position), 0) + 1 AS next FROM client_request_items WHERE request_id = $1 AND org_id = $2',
            [draft.id, orgId],
          );
          await tx.query(
            'client_request_items',
            `INSERT INTO client_request_items (org_id, request_id, position, label, detail, section_id, gap_ref)
             VALUES ($1, $2, $3, left($4, 200), left($5, 1000), $6, $7)`,
            [orgId, draft.id, next, p.title, note, p.section_id, ref],
          );
        }
      }
      await auditService.record({
        orgId,
        actorUserId: userId,
        action: 'problem.decided',
        targetType: 'problem',
        targetId: problemId,
        projectId: p.project_id,
        metadata: { decision, kind: p.kind },
      });
    });
    return this.get(orgId, problemId);
  },

  /** Re-check the project now (rules only; quick) and return what is open. */
  async check(orgId: string, projectId: string): Promise<{ contradictions: number; gaps: number; open: ProblemSummary[] }> {
    await assertProject(orgId, projectId);
    const found = await problemEngine.detect(orgId, projectId);
    const page = await this.list(orgId, projectId, 'open', 50);
    return { ...found, open: page.items };
  },
};
