import { ApiRequest } from './api';

/** Read-only folder connections (F2.1): server routes in server/src/routes/connections.ts. */

export type ConnectionProviderId = 'dropbox' | 'box' | 'onedrive' | 'google_drive';

export interface ProviderInfo {
  id: ConnectionProviderId;
  label: string;
  /** False until the provider's OAuth app is set up on this server. */
  available: boolean;
  readOnlyScopes: string[];
  /** The read-only scope in plain words, shown before connecting. */
  plainWords: string;
  canRevokeAtProvider: boolean;
}

export interface Connection {
  id: string;
  provider: ConnectionProviderId;
  accountLabel: string;
  scopes: string[];
  status: 'active' | 'needs_reauth' | 'revoked';
  tokenExpiresAt: string | null;
  lastError: string | null;
  activeLinks: number;
  createdAt: string;
  revokedAt: string | null;
}

export interface FolderLink {
  id: string;
  projectId: string;
  connectionId: string;
  provider: ConnectionProviderId;
  folderPath: string;
  status: 'active' | 'paused' | 'unlinked';
  lastSyncAt: string | null;
  lastSweepAt: string | null;
  nextSyncAt: string;
  lastError: string | null;
  fileCount: number;
  createdAt: string;
}

export interface DisconnectResult {
  id: string;
  revokedAtProvider: boolean;
  note: string | null;
  unlinkedFolders: number;
}

interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

type Request = <T>(path: string, init?: Omit<ApiRequest, 'token'>) => Promise<T>;

export function connectionsApi(request: Request, projectId: string) {
  const links = `/api/projects/${encodeURIComponent(projectId)}/folder-links`;
  return {
    providers: () => request<ProviderInfo[]>('/api/connections/providers'),
    connections: () => request<Page<Connection>>('/api/connections?limit=50'),
    /** Where to send the browser to sign in; the provider sends it back to returnPath. */
    start: (provider: ConnectionProviderId, returnPath: string) =>
      request<{ authorizeUrl: string; expiresAt: string }>(`/api/connections/oauth/${provider}/start`, { method: 'POST', body: { returnPath } }),
    disconnect: (connectionId: string) => request<DisconnectResult>(`/api/connections/${encodeURIComponent(connectionId)}`, { method: 'DELETE' }),
    links: () => request<Page<FolderLink>>(`${links}?limit=50`),
    link: (connectionId: string, folder: string) => request<FolderLink>(links, { method: 'POST', body: { connectionId, folder } }),
    unlink: (linkId: string) => request<FolderLink>(`${links}/${encodeURIComponent(linkId)}`, { method: 'DELETE' }),
  };
}
