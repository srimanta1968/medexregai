import { config } from '../config/env';
import { dataService } from '../services/DataService';
import { auditService } from '../services/AuditService';
import { AppError, ErrorCodes } from '../utils/AppError';
import { decodeCursor, Page, toPage } from '../utils/pagination';
import { ConnectionProvider, ConnectionView, connectionStore } from './ConnectionStore';
import {
  FolderProvider,
  ProviderAuthError,
  ProviderError,
  getProvider,
  isConnectionProvider,
  listProviders,
  pkcePair,
  redirectUri,
  scopesBeyondReadOnly,
} from './providers';

/**
 * F2.1 read-only folder connections: the OAuth round trip, keeping tokens fresh,
 * disconnecting, and linking a client folder to a project. Listing and fetching
 * the files themselves is the sync job's work (worker), never done in a request.
 */

/** What the firm is shown before connecting (AC: the read-only scope in plain words). */
const PLAIN_WORDS: Record<ConnectionProvider, string> = {
  dropbox: 'MedexRegAI can see the names of your Dropbox files and folders and open the files to read them. It cannot edit, move, share or delete anything.',
  box: 'MedexRegAI can read the Box files and folders you can see. It cannot upload, edit, share or delete anything.',
  onedrive:
    'MedexRegAI can read files in SharePoint and OneDrive that you can open, and see your name and email. It cannot edit, upload, share or delete anything.',
  google_drive: 'MedexRegAI can see and download your Google Drive files. It cannot edit, upload, share or delete anything.',
};

export interface ProviderInfo {
  id: ConnectionProvider;
  label: string;
  available: boolean;
  readOnlyScopes: string[];
  plainWords: string;
  canRevokeAtProvider: boolean;
}

export interface FolderLinkView {
  id: string;
  projectId: string;
  connectionId: string;
  provider: ConnectionProvider;
  folderPath: string;
  status: 'active' | 'paused' | 'unlinked';
  lastSyncAt: string | null;
  lastSweepAt: string | null;
  nextSyncAt: string;
  lastError: string | null;
  fileCount: number;
  createdAt: string;
}

interface LinkRow {
  id: string;
  project_id: string;
  connection_id: string;
  provider: ConnectionProvider;
  folder_path: string;
  status: FolderLinkView['status'];
  last_sync_at: Date | null;
  last_sweep_at: Date | null;
  next_sync_at: Date;
  last_error: string | null;
  file_count: string | number;
  created_at: Date;
}

const LINK_COLUMNS = `l.id, l.project_id, l.connection_id, c.provider, l.folder_path, l.status, l.last_sync_at, l.last_sweep_at, l.next_sync_at,
  l.last_error, l.created_at,
  (SELECT count(*) FROM files f WHERE f.folder_link_id = l.id AND f.org_id = l.org_id) AS file_count`;

const toLink = (r: LinkRow): FolderLinkView => ({
  id: r.id,
  projectId: r.project_id,
  connectionId: r.connection_id,
  provider: r.provider,
  folderPath: r.folder_path,
  status: r.status,
  lastSyncAt: r.last_sync_at ? r.last_sync_at.toISOString() : null,
  lastSweepAt: r.last_sweep_at ? r.last_sweep_at.toISOString() : null,
  nextSyncAt: r.next_sync_at.toISOString(),
  lastError: r.last_error,
  fileCount: Number(r.file_count),
  createdAt: r.created_at.toISOString(),
});

/** Why a callback failed, as a stable code for the screen (never the provider's raw text). */
export type ConnectFailure = 'denied' | 'invalid_state' | 'not_read_only' | 'provider_error' | 'not_configured';

export class ConnectError extends Error {
  constructor(
    readonly reason: ConnectFailure,
    message: string,
    readonly returnPath = '/app/connections',
  ) {
    super(message);
    this.name = 'ConnectError';
  }
}

const RETURN_PATH = /^\/app(\/[A-Za-z0-9/_-]*)?$/;

export const connectionService = {
  providers(): ProviderInfo[] {
    return listProviders().map((p) => ({
      id: p.id,
      label: p.label,
      available: p.configured,
      readOnlyScopes: [...p.scopes],
      plainWords: PLAIN_WORDS[p.id],
      canRevokeAtProvider: p.canRevokeAtProvider,
    }));
  },

  list(orgId: string, size: number, cursor?: string): Promise<Page<ConnectionView>> {
    return connectionStore.list(orgId, size, cursor);
  },

  get(orgId: string, id: string): Promise<ConnectionView> {
    return connectionStore.get(orgId, id);
  },

  /** Begin connecting: a one-time state + PKCE pair, and where to send the browser. */
  async start(orgId: string, userId: string, providerId: string, returnPath?: string): Promise<{ authorizeUrl: string; expiresAt: string }> {
    const provider = getProvider(providerId);
    if (returnPath !== undefined && !RETURN_PATH.test(returnPath)) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'returnPath must be an app path such as /app/connections', [
        { field: 'returnPath', message: 'returnPath must start with /app' },
      ]);
    }
    const { verifier, challenge } = pkcePair();
    const { state, expiresAt } = await connectionStore.createOAuthState(orgId, userId, provider.id, verifier, returnPath);
    return { authorizeUrl: provider.authorizeUrl({ state, codeChallenge: challenge, redirectUri: redirectUri(provider.id) }), expiresAt };
  },

  /**
   * The provider sent the browser back. Exchange the code, refuse anything wider
   * than read-only, record the account and save the sealed tokens.
   */
  async callback(providerId: string, query: Record<string, unknown>): Promise<{ connection: ConnectionView; returnPath: string }> {
    if (!isConnectionProvider(providerId)) throw new ConnectError('invalid_state', 'Unknown provider');
    const state = typeof query.state === 'string' ? query.state : '';
    const code = typeof query.code === 'string' ? query.code : '';
    if (!state) throw new ConnectError('invalid_state', 'The sign-in link is missing its state');

    let pending: Awaited<ReturnType<typeof connectionStore.consumeOAuthState>>;
    try {
      // Consumed even when the user declined, so the state can never be replayed.
      pending = await connectionStore.consumeOAuthState(state, providerId);
    } catch {
      throw new ConnectError('invalid_state', 'The sign-in link is not valid or has expired');
    }
    if (query.error !== undefined || !code) throw new ConnectError('denied', 'Access was not granted', pending.returnPath);

    let provider: FolderProvider;
    try {
      provider = getProvider(providerId);
    } catch {
      throw new ConnectError('not_configured', 'This provider is not set up', pending.returnPath);
    }
    try {
      const { tokens, scopes } = await provider.exchangeCode({ code, codeVerifier: pending.codeVerifier, redirectUri: redirectUri(provider.id) });
      const beyond = scopesBeyondReadOnly(provider.id, scopes);
      if (beyond.length) {
        await provider.revoke({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
        await auditService.record({
          orgId: pending.orgId,
          actorUserId: pending.userId,
          action: 'connection.refused',
          targetType: 'connection',
          metadata: { provider: provider.id, reason: 'not_read_only', scopes: beyond },
        });
        throw new ConnectError('not_read_only', `The grant included more than read access (${beyond.join(', ')})`, pending.returnPath);
      }
      const account = await provider.account(tokens.accessToken);
      const connection = await connectionStore.upsert(pending.orgId, pending.userId, {
        provider: provider.id,
        accountLabel: account.label.slice(0, 320),
        externalAccountId: account.externalAccountId.slice(0, 255),
        scopes,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
      });
      await auditService.record({
        orgId: pending.orgId,
        actorUserId: pending.userId,
        action: 'connection.connected',
        targetType: 'connection',
        targetId: connection.id,
        metadata: { provider: provider.id, account: connection.accountLabel, scopes },
      });
      return { connection, returnPath: pending.returnPath };
    } catch (err) {
      if (err instanceof ConnectError) throw err;
      console.warn(`[connections] ${providerId} callback failed: ${(err as Error).message}`);
      throw new ConnectError('provider_error', 'The provider did not complete the connection', pending.returnPath);
    }
  },

  /**
   * A usable access token, refreshed when it is about to expire. A refresh the
   * provider refuses marks the connection needs_reauth (its links pause).
   */
  async accessToken(orgId: string, connectionId: string): Promise<{ provider: FolderProvider; accessToken: string }> {
    const view = await connectionStore.get(orgId, connectionId);
    if (view.status === 'revoked') throw new AppError(409, ErrorCodes.CONNECTION_REVOKED, 'This connection has been disconnected');
    if (view.status === 'needs_reauth') throw new AppError(409, ErrorCodes.CONNECTION_NEEDS_REAUTH, 'Reconnect this account to resume syncing');
    const provider = getProvider(view.provider);
    const t = await connectionStore.tokens(orgId, connectionId);
    if (!t.expiresAt || t.expiresAt.getTime() > Date.now()) return { provider, accessToken: t.accessToken };
    if (!t.refreshToken) {
      await connectionStore.markNeedsReauth(orgId, connectionId, 'The access token expired and the provider issued no refresh token');
      throw new AppError(409, ErrorCodes.CONNECTION_NEEDS_REAUTH, 'Reconnect this account to resume syncing');
    }
    try {
      const fresh = await provider.refresh(t.refreshToken);
      await connectionStore.updateTokens(orgId, connectionId, fresh);
      return { provider, accessToken: fresh.accessToken };
    } catch (err) {
      if (err instanceof ProviderAuthError) {
        await connectionStore.markNeedsReauth(orgId, connectionId, 'The provider refused to refresh access');
        throw new AppError(409, ErrorCodes.CONNECTION_NEEDS_REAUTH, 'Reconnect this account to resume syncing');
      }
      throw err;
    }
  },

  /**
   * Disconnect: revoke the grant at the provider where it allows that, then erase
   * our tokens and unlink every folder (sync stops). Files already imported stay.
   */
  async disconnect(orgId: string, userId: string, connectionId: string): Promise<{ id: string; revokedAtProvider: boolean; note: string | null; unlinkedFolders: number }> {
    const view = await connectionStore.get(orgId, connectionId);
    if (view.status === 'revoked') return { id: connectionId, revokedAtProvider: false, note: 'Already disconnected.', unlinkedFolders: 0 };
    let revokedAtProvider = false;
    let note: string | null = null;
    const provider = listProviders().find((p) => p.id === view.provider)!;
    if (provider.configured) {
      const t = await connectionStore.tokens(orgId, connectionId);
      ({ revoked: revokedAtProvider, note } = await provider.revoke({ accessToken: t.accessToken, refreshToken: t.refreshToken }));
    } else {
      note = `${provider.label} is no longer set up on this server, so the grant could not be revoked there. Remove MedexRegAI from the account's connected apps.`;
    }
    const { unlinked } = await connectionStore.revoke(orgId, userId, connectionId);
    return { id: connectionId, revokedAtProvider, note, unlinkedFolders: unlinked };
  },

  /** Link a folder (picked by provider id or path) to a project. The worker syncs it. */
  async linkFolder(orgId: string, userId: string, projectId: string, connectionId: string, folder: string): Promise<FolderLinkView> {
    const [project] = await dataService.query<{ id: string }>({ orgId }, 'projects', 'SELECT id FROM projects WHERE id = $1 AND org_id = $2', [projectId, orgId]);
    if (!project) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
    const { provider, accessToken } = await this.accessToken(orgId, connectionId);
    let ref;
    try {
      ref = await provider.folder(accessToken, folder);
    } catch (err) {
      if (err instanceof ProviderAuthError) {
        await connectionStore.markNeedsReauth(orgId, connectionId, `${provider.label} rejected the stored access`);
        throw new AppError(409, ErrorCodes.CONNECTION_NEEDS_REAUTH, 'Reconnect this account to resume syncing');
      }
      // 429 / 5xx / no answer: the provider is having trouble, not the request.
      if (err instanceof ProviderError && err.retryable) throw new AppError(502, ErrorCodes.PROVIDER_UNAVAILABLE, `${provider.label} did not answer; try again`);
      // Not found, not a folder, or a path this account cannot read (Dropbox answers 409 path/not_found).
      throw new AppError(404, ErrorCodes.NOT_FOUND, `${provider.label} has no folder "${folder.slice(0, 200)}" that this account can read`);
    }
    try {
      const [row] = await dataService.query<{ id: string }>(
        { orgId, userId },
        'project_folder_links',
        `INSERT INTO project_folder_links (org_id, project_id, connection_id, folder_id, folder_path, created_by)
         VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5) RETURNING id`,
        [projectId, connectionId, ref.id.slice(0, 512), ref.path.slice(0, 1024), userId],
      );
      return this.getLink(orgId, projectId, row.id);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new AppError(409, ErrorCodes.FOLDER_ALREADY_LINKED, 'That folder is already linked to this project');
      throw err;
    }
  },

  async getLink(orgId: string, projectId: string, linkId: string): Promise<FolderLinkView> {
    const [row] = await dataService.query<LinkRow>(
      { orgId },
      'project_folder_links',
      `SELECT ${LINK_COLUMNS} FROM project_folder_links l JOIN folder_connections c ON c.id = l.connection_id AND c.org_id = l.org_id
        WHERE l.id = $1 AND l.project_id = $2 AND l.org_id = current_setting('app.org_id')::uuid`,
      [linkId, projectId],
    );
    if (!row) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Folder link not found');
    return toLink(row);
  },

  async listLinks(orgId: string, projectId: string, size: number, cursor?: string): Promise<Page<FolderLinkView>> {
    const c = decodeCursor(cursor);
    const rows = await dataService.query<LinkRow>(
      { orgId },
      'project_folder_links',
      `SELECT ${LINK_COLUMNS} FROM project_folder_links l JOIN folder_connections c ON c.id = l.connection_id AND c.org_id = l.org_id
        WHERE l.project_id = $1 AND l.org_id = current_setting('app.org_id')::uuid AND l.status <> 'unlinked'
          AND ($2::timestamptz IS NULL OR (l.created_at, l.id) < ($2::timestamptz, $3::uuid))
        ORDER BY l.created_at DESC, l.id DESC LIMIT $4`,
      [projectId, c.createdAt, c.id, size + 1],
    );
    return toPage(rows, size, toLink);
  },

  /** Stop syncing a folder. Files already imported stay in the project. */
  async unlinkFolder(orgId: string, projectId: string, linkId: string): Promise<FolderLinkView> {
    const rows = await dataService.query<{ id: string }>(
      { orgId },
      'project_folder_links',
      `UPDATE project_folder_links SET status = 'unlinked', unlinked_at = now(), sync_claimed_at = NULL, updated_at = now()
        WHERE id = $1 AND project_id = $2 AND org_id = current_setting('app.org_id')::uuid AND status <> 'unlinked' RETURNING id`,
      [linkId, projectId],
    );
    if (!rows.length) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Folder link not found');
    return this.getLink(orgId, projectId, linkId);
  },
};

/** Where the browser lands after a callback. */
export const connectResultUrl = (returnPath: string, result: { connected: string } | { error: ConnectFailure }): string => {
  const q = 'connected' in result ? `connected=${encodeURIComponent(result.connected)}` : `connection_error=${result.error}`;
  return `${config.appBaseUrl}${RETURN_PATH.test(returnPath) ? returnPath : '/app/connections'}?${q}`;
};
