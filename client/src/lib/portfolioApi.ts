import { ApiRequest } from './api';

/** F5.3 portfolio: server route in server/src/routes/portfolio.ts. */

export type StatusFilter = 'open' | 'active' | 'submitted' | 'cleared' | 'archived' | 'all';
export type Stage = 'fda_letter' | 'waiting_on_client' | 'drafting' | 'submitted' | 'cleared' | 'archived';

export interface PortfolioRow {
  projectId: string;
  projectName: string;
  clientId: string;
  clientName: string;
  deviceName: string;
  submissionType: string;
  status: 'active' | 'submitted' | 'cleared' | 'archived';
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

type Request = <T>(path: string, init?: Omit<ApiRequest, 'token'>) => Promise<T>;

export function portfolioApi(request: Request) {
  return {
    get: (params: { status: StatusFilter; clientId?: string; cursor?: string }) => {
      const qs = new URLSearchParams({ status: params.status, limit: '25' });
      if (params.clientId) qs.set('clientId', params.clientId);
      if (params.cursor) qs.set('cursor', params.cursor);
      return request<Portfolio>(`/api/portfolio?${qs.toString()}`);
    },
  };
}

export const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'open', label: 'In progress' },
  { key: 'active', label: 'Active' },
  { key: 'submitted', label: 'Submitted' },
  { key: 'cleared', label: 'Cleared' },
  { key: 'archived', label: 'Archived' },
  { key: 'all', label: 'All' },
];

/** "11 Nov" style, read as a calendar date (no time-zone shift). */
export function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export function dueText(due: PortfolioRow['due']): string {
  if (!due) return 'No date';
  const when = due.overdue ? `${-due.daysLeft} days overdue` : due.daysLeft === 0 ? 'today' : `in ${due.daysLeft} day${due.daysLeft === 1 ? '' : 's'}`;
  return `${shortDate(due.date)} · ${when}${due.kind === 'fda_letter' ? ' · FDA response' : ''}`;
}
