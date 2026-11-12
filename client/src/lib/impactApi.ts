import { ApiRequest } from './api';

/** F3.3 revision impact: server routes in server/src/routes/impact.ts. */

export type ImpactAction = 'redraft' | 'recheck' | 'mark_received' | 'keep';
export type ImpactKind = 'draft' | 'problem' | 'request_item';

export interface VersionRef {
  id: string;
  versionNo: number;
  createdAt: string;
}

export interface Revision {
  fileId: string;
  fileName: string;
  version: VersionRef;
  previousVersionNo: number;
  affectedStatements: number;
  handled: number;
}

export interface ImpactItem {
  key: string;
  kind: ImpactKind;
  title: string;
  detail: string;
  suggested: ImpactAction;
  actions: ImpactAction[];
  statements?: { statementId: string; ordinal: number; text: string; citedVersionNo: number; locator: string }[];
  projectSectionId?: string;
  handled: { action: ImpactAction; by: string | null; at: string; result: Record<string, unknown> } | null;
  stillAffected: boolean;
}

export interface Impact {
  fileId: string;
  fileName: string;
  projectId: string;
  version: VersionRef;
  previous: VersionRef | null;
  changes: { topicKey: string; label: string; before: string | null; after: string | null }[];
  passages: { before: string | null; after: string | null }[];
  items: ImpactItem[];
}

type Request = <T>(path: string, init?: Omit<ApiRequest, 'token'>) => Promise<T>;

/** Calls for a project's revisions and their impact. */
export function impactApi(request: Request, projectId: string) {
  const id = encodeURIComponent;
  return {
    revisions: () => request<Revision[]>(`/api/projects/${id(projectId)}/revisions`),
    impact: (versionId: string) => request<Impact>(`/api/file-versions/${id(versionId)}/impact`),
    act: (versionId: string, itemKey: string, action: ImpactAction) =>
      request<ImpactItem>(`/api/file-versions/${id(versionId)}/impact/actions`, { method: 'POST', body: { itemKey, action } }),
  };
}

export const ACTION_LABEL: Record<ImpactAction, string> = {
  redraft: 'Re-draft',
  recheck: 'Re-check',
  mark_received: 'Mark received',
  keep: 'Keep as is',
};
