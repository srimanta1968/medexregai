import { dataService } from '../services/DataService';
import { AppError, ErrorCodes } from '../utils/AppError';

/**
 * F5.3 portfolio (UI 2.0 §7.3): every submission in the firm with its stage, the next action, the
 * due date that matters most (an open FDA letter's response date, otherwise the project's target
 * date) and its risks, plus firm-wide totals. Everything is counted from the firm's own records:
 * open client requests, open high problems still present, and open FDA letters (a running clock).
 * Sorted by due date, soonest first; projects with no date come last.
 */

export type ProjectStatus = 'active' | 'submitted' | 'cleared' | 'archived';
export type Stage = 'fda_letter' | 'waiting_on_client' | 'drafting' | 'submitted' | 'cleared' | 'archived';
export type StatusFilter = ProjectStatus | 'open' | 'all';

export interface PortfolioRow {
  projectId: string;
  projectName: string;
  clientId: string;
  clientName: string;
  deviceName: string;
  submissionType: string;
  status: ProjectStatus;
  stage: Stage;
  stageLabel: string;
  nextAction: string | null;
  due: { date: string; kind: 'fda_letter' | 'target_date'; daysLeft: number; overdue: boolean } | null;
  counts: { highProblems: number; mediumProblems: number; openRequests: number; openLetters: number; openDeficiencies: number };
  risks: string[];
  riskLevel: 'high' | 'medium' | 'low';
}

export interface Portfolio {
  totals: { activeProjects: number; openRequests: number; highProblems: number; fdaClocksRunning: number; overdue: number };
  items: PortfolioRow[];
  nextCursor: string | null;
}

interface Row {
  id: string;
  name: string;
  workspace_id: string;
  client_name: string;
  device_name: string;
  submission_type: string;
  status: ProjectStatus;
  problems_checked_at: Date | null;
  target_date: string | null;
  letter_due: string | null;
  due: string | null;
  due_kind: 'fda_letter' | 'target_date' | null;
  days_left: number | null;
  high_problems: number;
  medium_problems: number;
  top_high_problem: string | null;
  open_requests: number;
  open_letters: number;
  open_deficiencies: number;
  sort_due: string;
}

const STAGE_LABEL: Record<Stage, string> = {
  fda_letter: 'FDA letter',
  waiting_on_client: 'Waiting on client',
  drafting: 'Drafting',
  submitted: 'Submitted',
  cleared: 'Cleared',
  archived: 'Archived',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Keyset cursor over (due date or 9999-12-31, project id), base64url. */
const encode = (due: string, id: string) => Buffer.from(`${due}|${id}`).toString('base64url');
function decode(cursor: string | undefined): { due: string | null; id: string | null } {
  if (!cursor) return { due: null, id: null };
  const [due, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!due || !id || !/^\d{4}-\d{2}-\d{2}$/.test(due) || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'cursor is invalid');
  }
  return { due, id };
}

export function stageOf(r: Pick<Row, 'status' | 'open_letters' | 'open_requests' | 'high_problems'>): Stage {
  if (r.status === 'cleared' || r.status === 'archived') return r.status;
  if (r.open_letters > 0) return 'fda_letter';
  if (r.status === 'submitted') return 'submitted';
  if (r.open_requests > 0 && r.high_problems === 0) return 'waiting_on_client';
  return 'drafting';
}

function nextActionOf(r: Row, stage: Stage): string | null {
  switch (stage) {
    case 'fda_letter':
      return r.open_deficiencies
        ? `Respond to FDA: ${plural(r.open_deficiencies, 'deficiency', 'deficiencies')} not ready`
        : 'Send the FDA response';
    case 'waiting_on_client':
      return `Follow up ${plural(r.open_requests, 'open client request')}`;
    case 'drafting':
      if (r.high_problems) return `Resolve ${plural(r.high_problems, 'high problem')}${r.top_high_problem ? `: ${r.top_high_problem}` : ''}`;
      if (!r.problems_checked_at) return 'Run the problem check';
      return 'Check submission readiness';
    case 'submitted':
      return "Wait for FDA's decision";
    default:
      return null;
  }
}

function risksOf(r: Row): { risks: string[]; level: PortfolioRow['riskLevel'] } {
  const risks: string[] = [];
  let level: PortfolioRow['riskLevel'] = 'low';
  const bump = (l: 'high' | 'medium') => {
    if (l === 'high' || level === 'low') level = l;
  };
  if (r.due && r.days_left !== null && r.status !== 'cleared' && r.status !== 'archived') {
    const what = r.due_kind === 'fda_letter' ? 'FDA response' : 'Target date';
    if (r.days_left < 0) {
      risks.push(`${what} overdue by ${plural(-r.days_left, 'day')}`);
      bump('high');
    } else if (r.days_left <= (r.due_kind === 'fda_letter' ? 30 : 14)) {
      risks.push(`${what} in ${plural(r.days_left, 'day')}`);
      bump(r.days_left <= 7 ? 'high' : 'medium');
    }
  }
  if (r.high_problems) {
    risks.push(plural(r.high_problems, 'high problem'));
    bump('high');
  }
  if (r.medium_problems) {
    risks.push(plural(r.medium_problems, 'medium problem'));
    bump('medium');
  }
  if (r.open_requests) risks.push(plural(r.open_requests, 'open client request'));
  return { risks, level };
}

function toRow(r: Row): PortfolioRow {
  const stage = stageOf(r);
  const { risks, level } = risksOf(r);
  return {
    projectId: r.id,
    projectName: r.name,
    clientId: r.workspace_id,
    clientName: r.client_name,
    deviceName: r.device_name,
    submissionType: r.submission_type,
    status: r.status,
    stage,
    stageLabel: STAGE_LABEL[stage],
    nextAction: nextActionOf(r, stage),
    due:
      r.due && r.due_kind && r.days_left !== null
        ? { date: r.due, kind: r.due_kind, daysLeft: r.days_left, overdue: r.days_left < 0 && r.status !== 'cleared' && r.status !== 'archived' }
        : null,
    counts: {
      highProblems: r.high_problems,
      mediumProblems: r.medium_problems,
      openRequests: r.open_requests,
      openLetters: r.open_letters,
      openDeficiencies: r.open_deficiencies,
    },
    risks,
    riskLevel: level,
  };
}

/** The per-project aggregate; $1 status filter ('open' = active or submitted, 'all'), $2 client. */
const PROJECTS = `
  SELECT p.id, p.name, p.workspace_id, w.name AS client_name, d.name AS device_name, p.submission_type, p.status,
         p.problems_checked_at, to_char(p.target_date, 'YYYY-MM-DD') AS target_date,
         to_char(l.next_due, 'YYYY-MM-DD') AS letter_due,
         to_char(COALESCE(l.next_due, p.target_date), 'YYYY-MM-DD') AS due,
         CASE WHEN l.next_due IS NOT NULL THEN 'fda_letter' WHEN p.target_date IS NOT NULL THEN 'target_date' END AS due_kind,
         (COALESCE(l.next_due, p.target_date) - current_date)::int AS days_left,
         COALESCE(pr.high, 0)::int AS high_problems, COALESCE(pr.medium, 0)::int AS medium_problems, pr.top_high AS top_high_problem,
         COALESCE(rq.open, 0)::int AS open_requests, COALESCE(l.open, 0)::int AS open_letters, COALESCE(df.open, 0)::int AS open_deficiencies,
         to_char(COALESCE(l.next_due, p.target_date, DATE '9999-12-31'), 'YYYY-MM-DD') AS sort_due
    FROM projects p
    JOIN client_workspaces w ON w.id = p.workspace_id AND w.org_id = p.org_id
    JOIN devices d ON d.id = p.device_id AND d.org_id = p.org_id
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE severity = 'high') AS high, count(*) FILTER (WHERE severity = 'medium') AS medium,
             (array_agg(title ORDER BY created_at) FILTER (WHERE severity = 'high'))[1] AS top_high
        FROM problems WHERE org_id = p.org_id AND project_id = p.id AND status = 'open' AND still_present) pr ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS open FROM client_requests WHERE org_id = p.org_id AND project_id = p.id AND status = 'open') rq ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS open, min(due_on) AS next_due FROM fda_letters WHERE org_id = p.org_id AND project_id = p.id AND status = 'open') l ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS open FROM fda_deficiencies f JOIN fda_letters fl ON fl.id = f.letter_id AND fl.org_id = f.org_id
       WHERE f.org_id = p.org_id AND f.project_id = p.id AND fl.status = 'open' AND f.status NOT IN ('ready', 'answered')) df ON true
   WHERE p.org_id = current_setting('app.org_id')::uuid
     AND w.status = 'active'
     AND ($1::text = 'all' OR ($1::text = 'open' AND p.status IN ('active', 'submitted')) OR p.status = $1::text)
     AND ($2::uuid IS NULL OR p.workspace_id = $2::uuid)`;

export const portfolioService = {
  async get(orgId: string, opts: { status: StatusFilter; clientId?: string; limit: number; cursor?: string }): Promise<Portfolio> {
    const c = decode(opts.cursor);
    const [rows, totals] = await Promise.all([
      dataService.query<Row>(
        { orgId },
        'projects',
        `SELECT * FROM (${PROJECTS}) x
          WHERE ($3::text IS NULL OR (x.sort_due, x.id) > ($3::text, $4::uuid))
          ORDER BY x.sort_due, x.id LIMIT $5`,
        [opts.status, opts.clientId ?? null, c.due, c.id, opts.limit + 1],
      ),
      dataService.query<{ active: number; open_requests: number; high_problems: number; clocks: number; overdue: number }>(
        { orgId },
        'projects',
        `SELECT count(*) FILTER (WHERE x.status = 'active')::int AS active,
                COALESCE(sum(x.open_requests), 0)::int AS open_requests,
                COALESCE(sum(x.high_problems), 0)::int AS high_problems,
                COALESCE(sum(x.open_letters), 0)::int AS clocks,
                count(*) FILTER (WHERE x.days_left < 0 AND x.status IN ('active', 'submitted'))::int AS overdue
           FROM (${PROJECTS}) x`,
        ['open', opts.clientId ?? null],
      ),
    ]);
    const page = rows.slice(0, opts.limit);
    const last = page[page.length - 1];
    const t = totals[0];
    return {
      totals: {
        activeProjects: t?.active ?? 0,
        openRequests: t?.open_requests ?? 0,
        highProblems: t?.high_problems ?? 0,
        fdaClocksRunning: t?.clocks ?? 0,
        overdue: t?.overdue ?? 0,
      },
      items: page.map(toRow),
      nextCursor: rows.length > opts.limit && last ? encode(last.sort_due, last.id) : null,
    };
  },
};
