import { dataService, Tx } from '../services/DataService';
import { AppError, ErrorCodes } from '../utils/AppError';

/**
 * F4.3 usage per client workspace and project (PRD v2.0 FR-14.22), so a firm can rebill its
 * clients: files read (and the pages, sheets or slides in them) and section drafts generated.
 *
 * Events are appended where the work happens (IngestService.recordParse, SectionDrafter) inside
 * the same transaction, at most once per file version or draft. usage_daily is rebuilt from the
 * events per project and day (rollup): by the worker, and before a read for the days asked for,
 * so a report is never older than the events.
 */

export interface ProjectUsage {
  projectId: string;
  projectName: string;
  filesRead: number;
  unitsRead: number;
  draftsGenerated: number;
}

export interface ClientUsage {
  workspaceId: string;
  clientName: string;
  projects: ProjectUsage[];
  projectCount: number;
  filesRead: number;
  unitsRead: number;
  draftsGenerated: number;
}

export interface UsageSummary {
  from: string;
  to: string;
  clients: ClientUsage[];
  totals: { filesRead: number; unitsRead: number; draftsGenerated: number };
}

/** Within a transaction that just marked a file version parsed. */
export async function recordFileRead(tx: Tx, orgId: string, version: { id: string; workspace_id: string; project_id: string }, units: number | null): Promise<void> {
  await tx.query(
    'usage_events',
    `INSERT INTO usage_events (org_id, workspace_id, project_id, kind, units, ref_id) VALUES ($1, $2, $3, 'file_read', $4, $5)
     ON CONFLICT (kind, ref_id) DO NOTHING`,
    [orgId, version.workspace_id, version.project_id, Math.max(0, units ?? 0), version.id],
  );
}

/** Within the transaction that marks a generated draft ready. */
export async function recordDraftGenerated(tx: Tx, orgId: string, draftId: string): Promise<void> {
  await tx.query(
    'usage_events',
    `INSERT INTO usage_events (org_id, workspace_id, project_id, kind, units, ref_id)
     SELECT d.org_id, p.workspace_id, p.id, 'draft_generated', 0, d.id
       FROM section_drafts d
       JOIN project_sections ps ON ps.id = d.project_section_id AND ps.org_id = d.org_id
       JOIN projects p ON p.id = ps.project_id AND p.org_id = ps.org_id
      WHERE d.id = $2 AND d.org_id = $1
     ON CONFLICT (kind, ref_id) DO NOTHING`,
    [orgId, draftId],
  );
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const usageService = {
  /** Rebuild usage_daily for the firm's days in [from, to] (UTC dates) from the events. */
  async rollup(orgId: string, from: string, to: string): Promise<number> {
    if (!DAY.test(from) || !DAY.test(to)) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'from and to must be dates (YYYY-MM-DD)');
    return dataService.transaction({ orgId }, async (tx) => {
      await tx.query('usage_daily', 'DELETE FROM usage_daily WHERE org_id = $1 AND day BETWEEN $2::date AND $3::date', [orgId, from, to]);
      const rows = await tx.query<{ n: number }>(
        'usage_daily',
        `WITH ins AS (
           INSERT INTO usage_daily (org_id, workspace_id, project_id, day, files_read, units_read, drafts_generated)
           SELECT org_id, workspace_id, project_id, (occurred_at AT TIME ZONE 'UTC')::date,
                  count(*) FILTER (WHERE kind = 'file_read'), COALESCE(sum(units) FILTER (WHERE kind = 'file_read'), 0),
                  count(*) FILTER (WHERE kind = 'draft_generated')
             FROM usage_events
            WHERE org_id = $1 AND occurred_at >= $2::date AND occurred_at < ($3::date + 1)
            GROUP BY org_id, workspace_id, project_id, (occurred_at AT TIME ZONE 'UTC')::date
           RETURNING 1)
         SELECT count(*)::int AS n FROM ins`,
        [orgId, from, to],
      );
      return Number(rows[0]?.n ?? 0);
    });
  },

  /** Worker pass: roll up the last two days of every active firm (events can arrive late in a day). */
  async rollupRecent(): Promise<number> {
    const orgs = await dataService.query<{ id: string }>({}, 'orgs', "SELECT id FROM orgs WHERE status = 'active' ORDER BY id");
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    let n = 0;
    for (const { id } of orgs) n += await this.rollup(id, yesterday, today);
    return n;
  },

  /** Usage per client workspace and project for the UTC days [from, to]; optionally one client. */
  async summary(orgId: string, opts: { from: string; to: string; workspaceId?: string }): Promise<UsageSummary> {
    if (opts.to < opts.from) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'to must not be before from', [{ field: 'to', message: 'Before from' }]);
    if (Date.parse(opts.to) - Date.parse(opts.from) > 400 * 86_400_000) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Ask for at most 400 days at a time', [{ field: 'to', message: 'At most 400 days after from' }]);
    }
    if (opts.workspaceId) {
      const [w] = await dataService.query<{ id: string }>({ orgId }, 'client_workspaces', 'SELECT id FROM client_workspaces WHERE id = $1 AND org_id = $2', [opts.workspaceId, orgId]);
      if (!w) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Client not found');
    }
    await this.rollup(orgId, opts.from, opts.to);
    // Every project of every client (in scope) appears, with zero usage when nothing happened.
    const rows = await dataService.query<{
      workspace_id: string;
      client_name: string;
      project_id: string | null;
      project_name: string | null;
      files_read: number;
      units_read: number;
      drafts_generated: number;
    }>(
      { orgId },
      'usage_daily',
      `SELECT w.id AS workspace_id, w.name AS client_name, p.id AS project_id, p.name AS project_name,
              COALESCE(sum(u.files_read), 0)::int AS files_read, COALESCE(sum(u.units_read), 0)::int AS units_read,
              COALESCE(sum(u.drafts_generated), 0)::int AS drafts_generated
         FROM client_workspaces w
         LEFT JOIN projects p ON p.workspace_id = w.id AND p.org_id = w.org_id
         LEFT JOIN usage_daily u ON u.project_id = p.id AND u.org_id = w.org_id AND u.day BETWEEN $2::date AND $3::date
        WHERE w.org_id = $1 AND ($4::uuid IS NULL OR w.id = $4::uuid)
        GROUP BY w.id, w.name, p.id, p.name
        ORDER BY w.name, p.name`,
      [orgId, opts.from, opts.to, opts.workspaceId ?? null],
    );
    const clients = new Map<string, ClientUsage>();
    for (const r of rows) {
      const c =
        clients.get(r.workspace_id) ??
        ({ workspaceId: r.workspace_id, clientName: r.client_name, projects: [], projectCount: 0, filesRead: 0, unitsRead: 0, draftsGenerated: 0 } as ClientUsage);
      if (r.project_id) {
        c.projects.push({ projectId: r.project_id, projectName: r.project_name ?? '', filesRead: r.files_read, unitsRead: r.units_read, draftsGenerated: r.drafts_generated });
        c.projectCount += 1;
        c.filesRead += r.files_read;
        c.unitsRead += r.units_read;
        c.draftsGenerated += r.drafts_generated;
      }
      clients.set(r.workspace_id, c);
    }
    const list = [...clients.values()];
    return {
      from: opts.from,
      to: opts.to,
      clients: list,
      totals: {
        filesRead: list.reduce((s, c) => s + c.filesRead, 0),
        unitsRead: list.reduce((s, c) => s + c.unitsRead, 0),
        draftsGenerated: list.reduce((s, c) => s + c.draftsGenerated, 0),
      },
    };
  },
};

/** One row per project (and a total per client), for Excel. Cells are never read as formulas. */
export function usageCsv(s: UsageSummary): string {
  const cell = (v: string | number): string => {
    let t = String(v);
    if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
    return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const rows: (string | number)[][] = [['Client', 'Project', 'Files read', 'Pages, sheets or slides read', 'Drafts generated', 'From', 'To']];
  for (const c of s.clients) {
    for (const p of c.projects) rows.push([c.clientName, p.projectName, p.filesRead, p.unitsRead, p.draftsGenerated, s.from, s.to]);
    rows.push([c.clientName, `All ${c.projectCount} project${c.projectCount === 1 ? '' : 's'}`, c.filesRead, c.unitsRead, c.draftsGenerated, s.from, s.to]);
  }
  return String.fromCharCode(0xfeff) + `${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}
