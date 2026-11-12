import { ApiRequest } from './api';

/** F3.1 review board: server routes in server/src/routes/sections.ts. */

export type SectionStatus = 'not_started' | 'drafting' | 'in_review' | 'approved';

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

export interface SectionHistoryItem {
  event: 'status_changed' | 'reviewer_assigned' | 'reviewer_removed';
  fromStatus: SectionStatus | null;
  toStatus: SectionStatus | null;
  reviewer: string | null;
  note: string | null;
  actor: string | null;
  at: string;
}

type Request = <T>(path: string, init?: Omit<ApiRequest, 'token'>) => Promise<T>;

export function sectionsApi(request: Request, projectId: string) {
  return {
    board: () => request<{ sections: BoardSection[]; reviewers: Reviewer[] }>(`/api/projects/${encodeURIComponent(projectId)}/sections`),
    update: (id: string, change: { status?: SectionStatus; reviewerId?: string | null; note?: string }) =>
      request<BoardSection>(`/api/project-sections/${encodeURIComponent(id)}`, { method: 'PATCH', body: change }),
    history: (id: string) => request<SectionHistoryItem[]>(`/api/project-sections/${encodeURIComponent(id)}/history`),
  };
}
