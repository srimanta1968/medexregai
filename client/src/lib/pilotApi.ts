import { ApiRequest } from './api';

/** F4.2 pilot report: server routes in server/src/routes/pilot.ts. */

export interface Comparison {
  actualHours: number;
  baselineHours: number | null;
  reduction: number | null;
  target: number;
  metTarget: boolean | null;
}

export interface PilotReport {
  projectId: string;
  projectName: string;
  clientName: string;
  deviceName: string;
  generatedAt: string;
  baseline: { basis: string | null; complete: boolean; totalHours: number };
  byActivity: { code: string; label: string; actualHours: number; baselineHours: number | null; reduction: number | null }[];
  wholeProject: Comparison;
  draftedSections: Comparison;
  acceptance: {
    sectionsReimported: number;
    draftedStatements: number;
    unchanged: number;
    edited: number;
    deleted: number;
    rate: number | null;
    target: number;
    metTarget: boolean | null;
  };
  timeEntries: number;
  people: number;
  signoffs: { id: string; signerName: string; signerTitle: string; note: string | null; signedAt: string; reportSha256: string; current: boolean }[];
  sha256: string;
}

export interface Baseline {
  basis: string | null;
  updatedAt: string | null;
  updatedByName: string | null;
  activities: { code: string; label: string; hours: number | null }[];
  totalHours: number;
  complete: boolean;
}

type Request = <T>(path: string, init?: Omit<ApiRequest, 'token'>) => Promise<T>;

export function pilotApi(request: Request, projectId: string) {
  const base = `/api/projects/${encodeURIComponent(projectId)}/pilot-report`;
  return {
    report: () => request<PilotReport>(base),
    pdf: () => request<Blob>(`${base}/pdf`, { responseType: 'blob' }),
    csv: () => request<Blob>(`${base}/csv`, { responseType: 'blob' }),
    signOff: (body: { signerTitle: string; note?: string | null }) => request<PilotReport>(`${base}/sign-off`, { method: 'POST', body }),
    baseline: () => request<Baseline>('/api/pilot/baseline'),
    setBaseline: (body: { basis?: string | null; hours: Record<string, number> }) => request<Baseline>('/api/pilot/baseline', { method: 'PUT', body }),
  };
}

export const percent = (n: number | null): string => (n === null ? '—' : `${Math.round(n * 100)}%`);
export const hrs = (n: number | null): string => (n === null ? '—' : `${n.toFixed(1)} h`);
