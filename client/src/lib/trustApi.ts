import { ApiRequest } from './api';

/** Trust pack (F2.5): packs, client clause, data-use settings, project deletion. */

export type PackKey = 'validation' | 'data-handling';

export interface DataUse {
  aiTraining: 'never';
  productImprovement: boolean;
  updatedAt: string | null;
  updatedByName: string | null;
}

export interface TrustPackSummary {
  release: string;
  contentVersion: string;
  packs: { key: PackKey; title: string; summary: string; fileName: string; format: 'pdf' }[];
  clause: { text: string; status: string };
  dataUse: DataUse;
  deletionDays: number;
  backupRetentionDays: number;
}

export interface ProjectDeletion {
  id: string;
  projectId: string;
  projectName: string;
  clientName: string;
  deviceName: string;
  status: 'removing_files' | 'completed';
  counts: Record<string, number>;
  objectsTotal: number;
  objectsRemoved: number;
  requestedByName: string;
  requestedAt: string;
  dueBy: string;
  rowsDeletedAt: string;
  completedAt: string | null;
  certificateSha256: string | null;
  lastError: string | null;
}

type Request = <T>(path: string, init?: Omit<ApiRequest, 'token'>) => Promise<T>;
const id = (v: string) => encodeURIComponent(v);

export function trustApi(request: Request) {
  return {
    summary: () => request<TrustPackSummary>('/api/trust-pack'),
    pack: (key: PackKey) => request<Blob>(`/api/trust-pack/documents/${id(key)}`, { responseType: 'blob' }),
    setProductImprovement: (productImprovement: boolean) => request<DataUse>('/api/settings/data-use', { method: 'PATCH', body: { productImprovement } }),
    deleteProject: (projectId: string, confirmName: string) =>
      request<ProjectDeletion>(`/api/projects/${id(projectId)}/deletion`, { method: 'POST', body: { confirmName } }),
    deletions: () => request<{ items: ProjectDeletion[]; nextCursor: string | null }>('/api/project-deletions?limit=50'),
    certificate: (deletionId: string) => request<Blob>(`/api/project-deletions/${id(deletionId)}/certificate`, { responseType: 'blob' }),
  };
}

/** Hand a downloaded file to the browser as a download. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
