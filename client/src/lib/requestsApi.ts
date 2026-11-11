import { ApiRequest, apiRequest } from './api';

/** Client requests and no-login upload links (F2.4). */

export interface RequestItem {
  id: string;
  position: number;
  label: string;
  detail: string;
  sectionId: string | null;
  gapRef: string | null;
  status: 'requested' | 'received';
  receivedAt: string | null;
  receivedCount: number;
}

export interface LinkState {
  active: boolean;
  expiresAt: string;
  revokedAt: string | null;
  filesReceived: number;
  maxFiles: number;
  lastUsedAt: string | null;
}

export interface RequestSummary {
  id: string;
  projectId: string;
  title: string;
  status: 'draft' | 'open' | 'closed';
  recipientName: string | null;
  recipientEmail: string | null;
  itemCount: number;
  receivedCount: number;
  emailStatus: 'not_sent' | 'sent' | 'failed';
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RequestDetail extends RequestSummary {
  message: string;
  emailError: string | null;
  emailedAt: string | null;
  items: RequestItem[];
  link: LinkState | null;
}

export interface RequestInput {
  title: string;
  message?: string;
  recipientName?: string | null;
  recipientEmail?: string | null;
  items: { label: string; detail?: string; sectionId?: string | null }[];
}

export interface IssuedLink {
  request: RequestDetail;
  link: { url: string; expiresAt: string };
}

type Request = <T>(path: string, init?: Omit<ApiRequest, 'token'>) => Promise<T>;

export function requestsApi(request: Request) {
  const id = encodeURIComponent;
  return {
    list: (projectId: string) => request<{ items: RequestSummary[]; nextCursor: string | null }>(`/api/projects/${id(projectId)}/requests?limit=50`),
    create: (projectId: string, body: RequestInput) => request<RequestDetail>(`/api/projects/${id(projectId)}/requests`, { method: 'POST', body }),
    detail: (requestId: string) => request<RequestDetail>(`/api/requests/${id(requestId)}`),
    update: (requestId: string, body: Partial<RequestInput>) => request<RequestDetail>(`/api/requests/${id(requestId)}`, { method: 'PATCH', body }),
    approve: (requestId: string, expiresInDays: number) =>
      request<IssuedLink>(`/api/requests/${id(requestId)}/approve`, { method: 'POST', body: { expiresInDays } }),
    reissue: (requestId: string, expiresInDays: number) =>
      request<IssuedLink>(`/api/requests/${id(requestId)}/link`, { method: 'POST', body: { expiresInDays } }),
    revoke: (requestId: string) => request<RequestDetail>(`/api/requests/${id(requestId)}/link/revoke`, { method: 'POST', body: {} }),
  };
}

// ------------------------------------------------------------------ public (no account; the link is the credential)

export interface PublicRequest {
  firmName: string;
  title: string;
  message: string;
  items: { id: string; label: string; detail: string; status: 'requested' | 'received' }[];
  expiresAt: string;
  filesRemaining: number;
  maxFileBytes: number;
  accepted: { label: string; extensions: string[] };
}

export interface UploadReceipt {
  received: boolean;
  fileName: string;
  alreadyReceived: boolean;
  itemId: string | null;
}

export const publicRequestApi = {
  view: (token: string) => apiRequest<PublicRequest>(`/api/u/${encodeURIComponent(token)}`),
  upload: (token: string, file: File, itemId?: string) =>
    apiRequest<UploadReceipt>(`/api/u/${encodeURIComponent(token)}/files${itemId ? `?item=${encodeURIComponent(itemId)}` : ''}`, {
      method: 'POST',
      rawBody: file,
      headers: { 'X-File-Name': encodeURIComponent(file.name) },
    }),
};
