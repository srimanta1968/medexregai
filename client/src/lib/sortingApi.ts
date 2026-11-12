import { ApiRequest } from './api';

/** F2.2 sorted folder: server routes in server/src/routes/sorting.ts and files.ts (unreadable). */

export interface EstarSection {
  id: string;
  ordinal: number;
  title: string;
  description: string;
  appliesTo: 'all' | 'special_510k';
  takesEvidence: boolean;
  edition: string;
  source: string;
}

export interface Assignment {
  sectionId: string | null;
  sectionTitle: string | null;
  confidence: number;
  source: 'rules' | 'embedding' | 'llm' | 'consultant';
  /** Why this section; shown on hover. */
  reason: string;
  needsReview: boolean;
  decidedAt: string;
}

export interface SortedFile {
  id: string;
  name: string;
  source: string;
  path: string | null;
  versionCount: number;
  parseStatus: string | null;
  unreadable: boolean;
  assignment: Assignment | null;
  createdAt: string;
}

export interface CoverageSection {
  id: string;
  title: string;
  ordinal: number;
  fileCount: number;
  empty: boolean;
}

export interface ChecklistStep {
  key: string;
  label: string;
  done: boolean;
  detail: string;
}

export interface Coverage {
  sections: CoverageSection[];
  checklist: ChecklistStep[];
  totals: Record<string, number>;
}

export interface VersionGroup {
  id: string;
  status: 'clear' | 'unclear' | 'confirmed';
  needsDecision: boolean;
  currentFileId: string | null;
  reason: string;
  members: { fileId: string; name: string; revisionLabel: string | null; revisionFrom: string | null; role: 'current' | 'superseded' | 'duplicate' | 'candidate' }[];
}

export interface UnreadableFile {
  id: string;
  name: string;
  source: string;
  path: string | null;
  kind: string | null;
  label: string;
  reason: string;
  advice: string;
  listedOnly: boolean;
  versionNo: number | null;
}

interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

type Request = <T>(path: string, init?: Omit<ApiRequest, 'token'>) => Promise<T>;

export function sortingApi(request: Request, projectId: string) {
  const p = `/api/projects/${encodeURIComponent(projectId)}`;
  return {
    sections: () => request<EstarSection[]>('/api/estar-sections'),
    files: (cursor?: string) => request<Page<SortedFile>>(`${p}/sorted-files?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
    coverage: () => request<Coverage>(`${p}/estar-coverage`),
    assign: (fileId: string, sectionId: string | null) =>
      request<{ fileId: string; assignment: Assignment }>(`/api/files/${encodeURIComponent(fileId)}/assignment`, { method: 'PUT', body: { sectionId } }),
    versionGroups: () => request<VersionGroup[]>(`${p}/version-groups`),
    confirmCurrent: (groupId: string, fileId: string) =>
      request<VersionGroup>(`${p}/version-groups/${encodeURIComponent(groupId)}/current`, { method: 'POST', body: { fileId } }),
    unreadable: () => request<Page<UnreadableFile>>(`${p}/files/unreadable?limit=50`),
  };
}
