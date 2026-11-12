import { ApiRequest } from './api';

/** F2.3 problems: server routes in server/src/routes/problems.ts. */

export type Severity = 'high' | 'medium' | 'low';
export type ProblemStatus = 'open' | 'resolved' | 'dismissed';
export type Decision = 'note_for_client' | 'request_data' | 'accepted' | 'add_to_request' | 'dismissed';

export interface ProblemSummary {
  id: string;
  kind: 'contradiction' | 'gap';
  title: string;
  severity: Severity;
  severityReason: string;
  status: ProblemStatus;
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

export interface ProblemPage {
  items: ProblemSummary[];
  nextCursor: string | null;
  counts: { contradictions: number; gaps: number; open: number };
}

type Request = <T>(path: string, init?: Omit<ApiRequest, 'token'>) => Promise<T>;

export function problemsApi(request: Request, projectId: string) {
  const p = `/api/projects/${encodeURIComponent(projectId)}`;
  return {
    list: (status: ProblemStatus | 'all' = 'open') => request<ProblemPage>(`${p}/problems?status=${status}&limit=50`),
    check: () => request<{ contradictions: number; gaps: number; open: ProblemSummary[] }>(`${p}/problems/check`, { method: 'POST', body: {} }),
    get: (problemId: string) => request<ProblemDetail>(`/api/problems/${encodeURIComponent(problemId)}`),
    decide: (problemId: string, decision: Decision, note: string) =>
      request<ProblemDetail>(`/api/problems/${encodeURIComponent(problemId)}/decision`, { method: 'POST', body: { decision, note } }),
  };
}
