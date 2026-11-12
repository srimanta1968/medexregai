import { dataService, Tx } from '../services/DataService';
import { AppError, ErrorCodes } from '../utils/AppError';
import { decodeCursor, Page, pageSize, toPage } from '../utils/pagination';

/**
 * F4.1 time capture (PRD v2.0 FR-14.20): optional, editable, one click per entry, logged
 * against the A3 activity codes (time_activities). Each person sees and edits only their own
 * entries; every query is scoped to the caller's firm and user.
 *
 * Starting a timer stops the one already running, so switching activity is one click.
 */

export interface Ctx {
  orgId: string;
  userId: string;
}

export interface Activity {
  code: string;
  label: string;
  description: string;
}

export interface TimeEntry {
  id: string;
  activityCode: string;
  activityLabel: string;
  projectId: string | null;
  projectName: string | null;
  startedAt: string;
  endedAt: string | null;
  running: boolean;
  /** Whole seconds; for a running entry, up to now. */
  seconds: number;
  source: 'timer' | 'manual';
  note: string | null;
  editedAt: string | null;
}

export interface WeekSummary {
  weekStart: string;
  weekEnd: string;
  totalSeconds: number;
  byDay: { date: string; seconds: number }[];
  byActivity: { code: string; label: string; seconds: number }[];
  byProject: { projectId: string | null; projectName: string; seconds: number }[];
  entryCount: number;
}

interface EntryRow {
  id: string;
  activity_code: string;
  activity_label: string;
  project_id: string | null;
  project_name: string | null;
  started_at: Date;
  ended_at: Date | null;
  seconds: number;
  source: 'timer' | 'manual';
  note: string | null;
  edited_at: Date | null;
  created_at: Date;
}

/** Longest single entry (migration 038 time_entries_length_chk). */
export const MAX_ENTRY_HOURS = 36;

const ENTRY_COLS = `e.id, e.activity_code, a.label AS activity_label, e.project_id, p.name AS project_name, e.started_at, e.ended_at,
  floor(extract(epoch FROM (COALESCE(e.ended_at, now()) - e.started_at)))::int AS seconds, e.source, e.note, e.edited_at, e.started_at AS created_at`;
const ENTRY_FROM = `time_entries e JOIN time_activities a ON a.code = e.activity_code
  LEFT JOIN projects p ON p.id = e.project_id AND p.org_id = e.org_id`;

const toEntry = (r: EntryRow): TimeEntry => ({
  id: r.id,
  activityCode: r.activity_code,
  activityLabel: r.activity_label,
  projectId: r.project_id,
  projectName: r.project_name,
  startedAt: new Date(r.started_at).toISOString(),
  endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : null,
  running: r.ended_at === null,
  seconds: Math.max(0, Number(r.seconds)),
  source: r.source,
  note: r.note,
  editedAt: r.edited_at ? new Date(r.edited_at).toISOString() : null,
});

const notFound = () => new AppError(404, ErrorCodes.NOT_FOUND, 'Time entry not found');

async function activityExists(code: string): Promise<void> {
  const [a] = await dataService.query<{ code: string }>({}, 'time_activities', 'SELECT code FROM time_activities WHERE code = $1', [code]);
  if (!a) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'activityCode is not an activity code', [{ field: 'activityCode', message: 'Unknown activity code' }]);
}

async function projectInFirm(ctx: Ctx, projectId: string | null | undefined): Promise<void> {
  if (!projectId) return;
  const [p] = await dataService.query<{ id: string }>(ctx, 'projects', 'SELECT id FROM projects WHERE id = $1 AND org_id = $2', [projectId, ctx.orgId]);
  if (!p) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
}

/** Stop the caller's running entry, if any, at `at`; an entry shorter than a second is dropped. */
async function stopRunning(tx: Tx, ctx: Ctx, at: string): Promise<string | null> {
  const [row] = await tx.query<{ id: string }>(
    'time_entries',
    `UPDATE time_entries SET ended_at = GREATEST($3::timestamptz, started_at + interval '1 second')
      WHERE org_id = $1 AND user_id = $2 AND ended_at IS NULL RETURNING id`,
    [ctx.orgId, ctx.userId, at],
  );
  return row?.id ?? null;
}

export const timeService = {
  async activities(): Promise<Activity[]> {
    return dataService.query<Activity>({}, 'time_activities', 'SELECT code, label, description FROM time_activities ORDER BY ordinal');
  },

  async get(ctx: Ctx, id: string): Promise<TimeEntry> {
    const [row] = await dataService.query<EntryRow>(
      ctx,
      'time_entries',
      `SELECT ${ENTRY_COLS} FROM ${ENTRY_FROM} WHERE e.id = $1 AND e.org_id = $2 AND e.user_id = $3`,
      [id, ctx.orgId, ctx.userId],
    );
    if (!row) throw notFound();
    return toEntry(row);
  },

  /** The caller's running timer, or null. */
  async current(ctx: Ctx): Promise<TimeEntry | null> {
    const [row] = await dataService.query<EntryRow>(
      ctx,
      'time_entries',
      `SELECT ${ENTRY_COLS} FROM ${ENTRY_FROM} WHERE e.org_id = $1 AND e.user_id = $2 AND e.ended_at IS NULL`,
      [ctx.orgId, ctx.userId],
    );
    return row ? toEntry(row) : null;
  },

  /** Start a timer; the one already running (if any) stops at the same instant. */
  async start(ctx: Ctx, input: { activityCode: string; projectId?: string | null; note?: string | null }): Promise<{ entry: TimeEntry; stopped: TimeEntry | null }> {
    await activityExists(input.activityCode);
    await projectInFirm(ctx, input.projectId);
    const { id, stoppedId } = await dataService.transaction(ctx, async (tx) => {
      const now = new Date().toISOString();
      const stopped = await stopRunning(tx, ctx, now);
      const [row] = await tx.query<{ id: string }>(
        'time_entries',
        `INSERT INTO time_entries (org_id, user_id, project_id, activity_code, started_at, source, note)
         VALUES ($1, $2, $3, $4, $5, 'timer', $6) RETURNING id`,
        [ctx.orgId, ctx.userId, input.projectId ?? null, input.activityCode, now, input.note ?? null],
      );
      return { id: row.id, stoppedId: stopped };
    });
    return { entry: await this.get(ctx, id), stopped: stoppedId ? await this.get(ctx, stoppedId) : null };
  },

  /** Stop the running timer. 404 when none is running. */
  async stop(ctx: Ctx): Promise<TimeEntry> {
    const id = await dataService.transaction(ctx, (tx) => stopRunning(tx, ctx, new Date().toISOString()));
    if (!id) throw new AppError(404, ErrorCodes.NOT_FOUND, 'No timer is running');
    return this.get(ctx, id);
  },

  /** The caller's entries, newest first, optionally within [from, to) and for one project. */
  async list(ctx: Ctx, opts: { from?: string; to?: string; projectId?: string; limit?: number; cursor?: string }): Promise<Page<TimeEntry>> {
    const size = pageSize(opts.limit);
    const after = decodeCursor(opts.cursor);
    const rows = await dataService.query<EntryRow>(
      ctx,
      'time_entries',
      `SELECT ${ENTRY_COLS} FROM ${ENTRY_FROM}
        WHERE e.org_id = $1 AND e.user_id = $2
          AND ($3::timestamptz IS NULL OR e.started_at >= $3::timestamptz)
          AND ($4::timestamptz IS NULL OR e.started_at < $4::timestamptz)
          AND ($5::uuid IS NULL OR e.project_id = $5::uuid)
          AND ($6::timestamptz IS NULL OR (e.started_at, e.id) < ($6::timestamptz, $7::uuid))
        ORDER BY e.started_at DESC, e.id DESC LIMIT $8`,
      [ctx.orgId, ctx.userId, opts.from ?? null, opts.to ?? null, opts.projectId ?? null, after.createdAt, after.id, size + 1],
    );
    return toPage(rows, size, toEntry);
  },

  /** An entry typed in afterwards. */
  async add(ctx: Ctx, input: { activityCode: string; projectId?: string | null; startedAt: string; endedAt: string; note?: string | null }): Promise<TimeEntry> {
    await activityExists(input.activityCode);
    await projectInFirm(ctx, input.projectId);
    checkSpan(input.startedAt, input.endedAt);
    const [row] = await dataService.query<{ id: string }>(
      ctx,
      'time_entries',
      `INSERT INTO time_entries (org_id, user_id, project_id, activity_code, started_at, ended_at, source, note)
       VALUES ($1, $2, $3, $4, $5, $6, 'manual', $7) RETURNING id`,
      [ctx.orgId, ctx.userId, input.projectId ?? null, input.activityCode, input.startedAt, input.endedAt, input.note ?? null],
    );
    return this.get(ctx, row.id);
  },

  /** Edit one of the caller's entries; projectId null moves it to "No project". */
  async update(
    ctx: Ctx,
    id: string,
    input: { activityCode?: string; projectId?: string | null; startedAt?: string; endedAt?: string; note?: string | null },
  ): Promise<TimeEntry> {
    const cur = await this.get(ctx, id);
    if (input.activityCode) await activityExists(input.activityCode);
    if (input.projectId) await projectInFirm(ctx, input.projectId);
    const startedAt = input.startedAt ?? cur.startedAt;
    const endedAt = input.endedAt ?? cur.endedAt;
    if (cur.running && input.endedAt === undefined) {
      if (new Date(startedAt).getTime() > Date.now()) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'A running timer cannot start in the future');
    } else if (endedAt) {
      checkSpan(startedAt, endedAt);
    }
    await dataService.query(
      ctx,
      'time_entries',
      `UPDATE time_entries SET activity_code = COALESCE($4, activity_code),
              project_id = CASE WHEN $5::boolean THEN $6::uuid ELSE project_id END,
              started_at = $7, ended_at = $8, note = CASE WHEN $9::boolean THEN $10 ELSE note END, edited_at = now()
        WHERE id = $1 AND org_id = $2 AND user_id = $3`,
      [
        id,
        ctx.orgId,
        ctx.userId,
        input.activityCode ?? null,
        input.projectId !== undefined,
        input.projectId ?? null,
        startedAt,
        endedAt,
        input.note !== undefined,
        input.note ?? null,
      ],
    );
    return this.get(ctx, id);
  },

  async remove(ctx: Ctx, id: string): Promise<void> {
    const [row] = await dataService.query<{ id: string }>(
      ctx,
      'time_entries',
      'DELETE FROM time_entries WHERE id = $1 AND org_id = $2 AND user_id = $3 RETURNING id',
      [id, ctx.orgId, ctx.userId],
    );
    if (!row) throw notFound();
  },

  /**
   * The caller's week: totals by day, activity and project. weekStart is the first day
   * (YYYY-MM-DD) in the caller's local time; tzOffsetMinutes is what the browser's
   * Date.getTimezoneOffset() returns (minutes to add to local time to get UTC). A running
   * timer counts up to now. Entries are attributed to the day they started.
   */
  async week(ctx: Ctx, weekStart: string, tzOffsetMinutes: number): Promise<WeekSummary> {
    const startUtc = new Date(Date.parse(`${weekStart}T00:00:00Z`) + tzOffsetMinutes * 60_000);
    const endUtc = new Date(startUtc.getTime() + 7 * 86_400_000);
    const rows = await dataService.query<{ day: string; activity_code: string; label: string; project_id: string | null; project_name: string | null; seconds: number }>(
      ctx,
      'time_entries',
      `SELECT to_char((e.started_at - make_interval(mins => $5)) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
              e.activity_code, a.label, e.project_id, p.name AS project_name,
              sum(floor(extract(epoch FROM (COALESCE(e.ended_at, now()) - e.started_at))))::int AS seconds
         FROM ${ENTRY_FROM}
        WHERE e.org_id = $1 AND e.user_id = $2 AND e.started_at >= $3 AND e.started_at < $4
        GROUP BY 1, 2, 3, 4, 5`,
      [ctx.orgId, ctx.userId, startUtc.toISOString(), endUtc.toISOString(), tzOffsetMinutes],
    );
    const [{ n }] = await dataService.query<{ n: number }>(
      ctx,
      'time_entries',
      'SELECT count(*)::int AS n FROM time_entries WHERE org_id = $1 AND user_id = $2 AND started_at >= $3 AND started_at < $4',
      [ctx.orgId, ctx.userId, startUtc.toISOString(), endUtc.toISOString()],
    );
    const days = Array.from({ length: 7 }, (_, i) => new Date(Date.parse(`${weekStart}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
    const sum = (pick: (r: (typeof rows)[number]) => boolean) => rows.filter(pick).reduce((s, r) => s + Number(r.seconds), 0);
    const activities: Activity[] = await this.activities();
    const projects = new Map<string, { projectId: string | null; projectName: string }>();
    for (const r of rows) projects.set(r.project_id ?? '', { projectId: r.project_id, projectName: r.project_name ?? 'No project' });
    return {
      weekStart,
      weekEnd: days[6],
      totalSeconds: sum(() => true),
      byDay: days.map((date) => ({ date, seconds: sum((r) => r.day === date) })),
      byActivity: activities.map((a) => ({ code: a.code, label: a.label, seconds: sum((r) => r.activity_code === a.code) })).filter((a) => a.seconds > 0),
      byProject: [...projects.entries()]
        .map(([key, p]) => ({ ...p, seconds: sum((r) => (r.project_id ?? '') === key) }))
        .sort((a, b) => b.seconds - a.seconds),
      entryCount: n,
    };
  },
};

function checkSpan(startedAt: string, endedAt: string): void {
  const s = Date.parse(startedAt);
  const e = Date.parse(endedAt);
  if (!(e > s)) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'endedAt must be after startedAt', [{ field: 'endedAt', message: 'Must be after startedAt' }]);
  if (e - s > MAX_ENTRY_HOURS * 3_600_000) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `An entry can be at most ${MAX_ENTRY_HOURS} hours`, [{ field: 'endedAt', message: `At most ${MAX_ENTRY_HOURS} hours after startedAt` }]);
  }
  if (e > Date.now() + 60_000) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'endedAt cannot be in the future', [{ field: 'endedAt', message: 'In the future' }]);
}

export interface TotalRow {
  projectId: string | null;
  projectName: string;
  clientName: string | null;
  activityCode: string;
  activityLabel: string;
  person: string | null;
  seconds: number;
  entries: number;
}

/** A CSV cell: quoted when needed, and never read by a spreadsheet as a formula. */
export function csvCell(v: string | number | null): string {
  if (v === null) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * F4.1 totals by project and activity (FR-14.20), for the CSV export. Finished entries only (a
 * running timer counts once it stops), within [from, to) on their start time. scope 'mine' is the
 * caller's own time; 'firm' is everyone's in the firm, one row per person.
 */
export async function timeTotals(ctx: Ctx, opts: { from: string; to: string; scope: 'mine' | 'firm' }): Promise<TotalRow[]> {
  const rows = await dataService.query<{
    project_id: string | null;
    project_name: string | null;
    client_name: string | null;
    activity_code: string;
    label: string;
    ordinal: number;
    person: string | null;
    seconds: number;
    entries: number;
  }>(
    ctx,
    'time_entries',
    `SELECT e.project_id, p.name AS project_name, w.name AS client_name, e.activity_code, a.label, a.ordinal,
            CASE WHEN $5 = 'firm' THEN COALESCE(up.full_name, u.email) END AS person,
            sum(floor(extract(epoch FROM (e.ended_at - e.started_at))))::int AS seconds, count(*)::int AS entries
       FROM time_entries e
       JOIN time_activities a ON a.code = e.activity_code
       LEFT JOIN projects p ON p.id = e.project_id AND p.org_id = e.org_id
       LEFT JOIN client_workspaces w ON w.id = p.workspace_id AND w.org_id = p.org_id
       JOIN users u ON u.id = e.user_id
       LEFT JOIN user_profiles up ON up.user_id = e.user_id
      WHERE e.org_id = $1 AND ($5 = 'firm' OR e.user_id = $2) AND e.ended_at IS NOT NULL
        AND e.started_at >= $3 AND e.started_at < $4
      GROUP BY e.project_id, p.name, w.name, e.activity_code, a.label, a.ordinal, 7
      ORDER BY p.name NULLS LAST, 7 NULLS FIRST, a.ordinal`,
    [ctx.orgId, ctx.userId, opts.from, opts.to, opts.scope],
  );
  return rows.map((r) => ({
    projectId: r.project_id,
    projectName: r.project_name ?? 'No project',
    clientName: r.client_name,
    activityCode: r.activity_code,
    activityLabel: r.label,
    person: r.person,
    seconds: Number(r.seconds),
    entries: Number(r.entries),
  }));
}

/** The totals as CSV: one row per project, activity (and person for the firm), hours to 2 decimals. */
export function totalsCsv(rows: TotalRow[], scope: 'mine' | 'firm'): string {
  const header = ['Client', 'Project', ...(scope === 'firm' ? ['Person'] : []), 'Activity code', 'Activity', 'Hours', 'Entries'];
  const lines = rows.map((r) =>
    [r.clientName, r.projectName, ...(scope === 'firm' ? [r.person] : []), r.activityCode, r.activityLabel, (r.seconds / 3600).toFixed(2), r.entries].map(csvCell).join(','),
  );
  // Excel opens a UTF-8 CSV correctly only with the byte order mark.
  return `﻿${[header.join(','), ...lines].join('\r\n')}\r\n`;
}
