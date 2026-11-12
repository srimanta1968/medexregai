import { ApiRequest } from './api';

/** F4.1 time capture: server routes in server/src/routes/time.ts. */

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

type Request = <T>(path: string, init?: Omit<ApiRequest, 'token'>) => Promise<T>;

/** Fired on window after a timer starts or stops, so the top-bar timer and the time page agree. */
export const TIME_CHANGED = 'mx-time-changed';
export const announceTimeChange = (): void => void window.dispatchEvent(new Event(TIME_CHANGED));

/** Calls for the caller's own time. */
export function timeApi(request: Request) {
  return {
    activities: () => request<Activity[]>('/api/time/activities'),
    current: () => request<{ entry: TimeEntry | null }>('/api/time/current'),
    start: (body: { activityCode: string; projectId?: string | null; note?: string | null }) =>
      request<{ entry: TimeEntry; stopped: TimeEntry | null }>('/api/time/start', { method: 'POST', body }),
    stop: () => request<TimeEntry>('/api/time/stop', { method: 'POST', body: {} }),
    entries: (from: string, to: string) =>
      request<{ items: TimeEntry[]; nextCursor: string | null }>(`/api/time/entries?${new URLSearchParams({ from, to, limit: '50' }).toString()}`),
    add: (body: { activityCode: string; projectId?: string | null; startedAt: string; endedAt: string; note?: string | null }) =>
      request<TimeEntry>('/api/time/entries', { method: 'POST', body }),
    update: (id: string, body: { activityCode?: string; projectId?: string | null; startedAt?: string; endedAt?: string; note?: string | null }) =>
      request<TimeEntry>(`/api/time/entries/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    remove: (id: string) => request<void>(`/api/time/entries/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    week: (weekStart: string) => request<WeekSummary>(`/api/time/summary?weekStart=${weekStart}&tzOffset=${new Date().getTimezoneOffset()}`),
    exportCsv: (from: string, to: string, scope: 'mine' | 'firm') =>
      request<Blob>(`/api/time/export?${new URLSearchParams({ from, to, scope }).toString()}`, { responseType: 'blob' }),
  };
}

/** h:mm:ss for a running timer; "2 h 05 min" style for totals. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function hours(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** Monday of the week containing `d`, as a local YYYY-MM-DD. */
export function mondayOf(d: Date): string {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

/** Local midnight of a YYYY-MM-DD as an ISO instant. */
export function localStart(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toISOString();
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const x = new Date(y, m - 1, d + n);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
