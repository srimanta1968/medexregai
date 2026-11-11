import { createHash, randomBytes, randomUUID } from 'crypto';
import { dataService } from '../services/DataService';
import { AppError, ErrorCodes } from '../utils/AppError';
import { decodeCursor, Page, toPage } from '../utils/pagination';
import { openSecret, sealSecret } from '../utils/secretBox';

/**
 * Persistence for read-only folder connections (F2.1, migration 023).
 *
 * Tokens are sealed with AES-256-GCM and the connection's own id as associated data,
 * so a ciphertext only opens on its own firm and row. They never leave this module
 * except through tokens(), which the provider adapters and the sync job call; every
 * other read returns ConnectionView, which has no token material.
 */

export type ConnectionProvider = 'dropbox' | 'box' | 'onedrive' | 'google_drive';
export const CONNECTION_PROVIDERS: readonly ConnectionProvider[] = ['dropbox', 'box', 'onedrive', 'google_drive'];
export type ConnectionStatus = 'active' | 'needs_reauth' | 'revoked';

export interface ConnectionView {
  id: string;
  provider: ConnectionProvider;
  accountLabel: string;
  scopes: string[];
  status: ConnectionStatus;
  tokenExpiresAt: string | null;
  lastError: string | null;
  activeLinks: number;
  createdAt: string;
  revokedAt: string | null;
}

export interface ConnectionTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
}

export interface NewConnection {
  provider: ConnectionProvider;
  accountLabel: string;
  externalAccountId: string;
  scopes: string[];
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
}

interface Row {
  id: string;
  provider: ConnectionProvider;
  account_label: string;
  scopes: string[];
  status: ConnectionStatus;
  token_expires_at: Date | null;
  last_error: string | null;
  active_links: string | number;
  created_at: Date;
  revoked_at: Date | null;
}

const COLUMNS = `c.id, c.provider, c.account_label, c.scopes, c.status, c.token_expires_at, c.last_error, c.created_at, c.revoked_at,
  (SELECT count(*) FROM project_folder_links l WHERE l.connection_id = c.id AND l.org_id = c.org_id AND l.status <> 'unlinked') AS active_links`;

const toView = (r: Row): ConnectionView => ({
  id: r.id,
  provider: r.provider,
  accountLabel: r.account_label,
  scopes: r.scopes,
  status: r.status,
  tokenExpiresAt: r.token_expires_at ? r.token_expires_at.toISOString() : null,
  lastError: r.last_error,
  activeLinks: Number(r.active_links),
  createdAt: r.created_at.toISOString(),
  revokedAt: r.revoked_at ? r.revoked_at.toISOString() : null,
});

/** Associated data for a sealed token: it only opens on its own firm, row and kind. */
const tokenContext = (orgId: string, id: string, kind: 'access' | 'refresh'): string => `folder-connection:${orgId}:${id}:${kind}`;
const seal = (orgId: string, id: string, kind: 'access' | 'refresh', value: string | null): string | null =>
  value === null ? null : sealSecret(value, tokenContext(orgId, id, kind));

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export const connectionStore = {
  /**
   * Save a granted connection. Connecting the same provider account again replaces
   * its tokens and reactivates it, rather than creating a second connection.
   */
  async upsert(orgId: string, userId: string, c: NewConnection): Promise<ConnectionView> {
    return dataService.transaction({ orgId, userId }, async (tx) => {
      const [existing] = await tx.query<{ id: string }>(
        'folder_connections',
        `SELECT id FROM folder_connections
          WHERE org_id = current_setting('app.org_id')::uuid AND provider = $1 AND external_account_id = $2 AND status <> 'revoked'
          FOR UPDATE`,
        [c.provider, c.externalAccountId],
      );
      const id = existing?.id ?? randomUUID();
      const sealedAccess = seal(orgId, id, 'access', c.accessToken);
      const sealedRefresh = seal(orgId, id, 'refresh', c.refreshToken);
      if (existing) {
        await tx.query(
          'folder_connections',
          `UPDATE folder_connections SET account_label = $2, scopes = $3, status = 'active', access_token_sealed = $4,
                  refresh_token_sealed = $5, token_expires_at = $6, last_error = NULL, updated_at = now()
            WHERE id = $1 AND org_id = current_setting('app.org_id')::uuid`,
          [id, c.accountLabel, c.scopes, sealedAccess, sealedRefresh, c.expiresAt],
        );
        // Links paused while the grant was broken resume with the new one.
        await tx.query(
          'project_folder_links',
          `UPDATE project_folder_links SET status = 'active', next_sync_at = now(), last_error = NULL, updated_at = now()
            WHERE connection_id = $1 AND org_id = current_setting('app.org_id')::uuid AND status = 'paused'`,
          [id],
        );
      } else {
        await tx.query(
          'folder_connections',
          `INSERT INTO folder_connections (id, org_id, provider, account_label, external_account_id, scopes,
                  access_token_sealed, refresh_token_sealed, token_expires_at, created_by)
           VALUES ($1, current_setting('app.org_id')::uuid, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [id, c.provider, c.accountLabel, c.externalAccountId, c.scopes, sealedAccess, sealedRefresh, c.expiresAt, userId],
        );
      }
      const [row] = await tx.query<Row>(
        'folder_connections',
        `SELECT ${COLUMNS} FROM folder_connections c WHERE c.id = $1 AND c.org_id = current_setting('app.org_id')::uuid`,
        [id],
      );
      return toView(row);
    });
  },

  async list(orgId: string, size: number, cursor?: string): Promise<Page<ConnectionView>> {
    const c = decodeCursor(cursor);
    const rows = await dataService.query<Row>(
      { orgId },
      'folder_connections',
      `SELECT ${COLUMNS} FROM folder_connections c
        WHERE c.org_id = current_setting('app.org_id')::uuid
          AND ($1::timestamptz IS NULL OR (c.created_at, c.id) < ($1::timestamptz, $2::uuid))
        ORDER BY c.created_at DESC, c.id DESC LIMIT $3`,
      [c.createdAt, c.id, size + 1],
    );
    return toPage(rows, size, toView);
  },

  async get(orgId: string, id: string): Promise<ConnectionView> {
    const [row] = await dataService.query<Row>(
      { orgId },
      'folder_connections',
      `SELECT ${COLUMNS} FROM folder_connections c WHERE c.id = $1 AND c.org_id = current_setting('app.org_id')::uuid`,
      [id],
    );
    if (!row) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Connection not found');
    return toView(row);
  },

  /** Decrypted tokens, for the provider adapters and the sync job only. */
  async tokens(orgId: string, id: string): Promise<ConnectionTokens> {
    const [row] = await dataService.query<{ access_token_sealed: string | null; refresh_token_sealed: string | null; token_expires_at: Date | null }>(
      { orgId },
      'folder_connections',
      `SELECT access_token_sealed, refresh_token_sealed, token_expires_at FROM folder_connections
        WHERE id = $1 AND org_id = current_setting('app.org_id')::uuid`,
      [id],
    );
    // Another firm's connection is indistinguishable from one that does not exist.
    if (!row) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Connection not found');
    if (!row.access_token_sealed) throw new AppError(409, ErrorCodes.CONNECTION_REVOKED, 'This connection has been disconnected');
    return {
      accessToken: openSecret(row.access_token_sealed, tokenContext(orgId, id, 'access')),
      refreshToken: row.refresh_token_sealed ? openSecret(row.refresh_token_sealed, tokenContext(orgId, id, 'refresh')) : null,
      expiresAt: row.token_expires_at,
    };
  },

  /** Store refreshed tokens (a provider may rotate the refresh token too). */
  async updateTokens(orgId: string, id: string, t: { accessToken: string; refreshToken?: string | null; expiresAt: Date | null }): Promise<void> {
    await dataService.query(
      { orgId },
      'folder_connections',
      `UPDATE folder_connections SET access_token_sealed = $2,
              refresh_token_sealed = COALESCE($3, refresh_token_sealed), token_expires_at = $4, last_error = NULL, updated_at = now()
        WHERE id = $1 AND org_id = current_setting('app.org_id')::uuid AND status <> 'revoked'`,
      [id, seal(orgId, id, 'access', t.accessToken), t.refreshToken ? seal(orgId, id, 'refresh', t.refreshToken) : null, t.expiresAt],
    );
  },

  /** The grant stopped working (refresh refused): pause its links until the firm reconnects. */
  async markNeedsReauth(orgId: string, id: string, reason: string): Promise<void> {
    await dataService.transaction({ orgId }, async (tx) => {
      await tx.query(
        'folder_connections',
        `UPDATE folder_connections SET status = 'needs_reauth', last_error = left($2, 500), updated_at = now()
          WHERE id = $1 AND org_id = current_setting('app.org_id')::uuid AND status = 'active'`,
        [id, reason],
      );
      await tx.query(
        'project_folder_links',
        `UPDATE project_folder_links SET status = 'paused', last_error = left($2, 500), updated_at = now()
          WHERE connection_id = $1 AND org_id = current_setting('app.org_id')::uuid AND status = 'active'`,
        [id, reason],
      );
    });
  },

  /**
   * Disconnect: erase both tokens, mark the connection revoked and unlink every
   * folder that used it, so the sync job stops. The caller revokes the grant at the
   * provider first (with tokens()); this runs even if that call failed, because the
   * firm asked to disconnect and we must not keep the tokens either way.
   */
  async revoke(orgId: string, userId: string, id: string): Promise<{ unlinked: number }> {
    return dataService.transaction({ orgId, userId }, async (tx) => {
      const [row] = await tx.query<{ status: ConnectionStatus }>(
        'folder_connections',
        `SELECT status FROM folder_connections WHERE id = $1 AND org_id = current_setting('app.org_id')::uuid FOR UPDATE`,
        [id],
      );
      if (!row) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Connection not found');
      if (row.status === 'revoked') return { unlinked: 0 };
      await tx.query(
        'folder_connections',
        `UPDATE folder_connections SET status = 'revoked', access_token_sealed = NULL, refresh_token_sealed = NULL,
                token_expires_at = NULL, revoked_at = now(), revoked_by = $2, updated_at = now()
          WHERE id = $1 AND org_id = current_setting('app.org_id')::uuid`,
        [id, userId],
      );
      const unlinked = await tx.query(
        'project_folder_links',
        `UPDATE project_folder_links SET status = 'unlinked', unlinked_at = now(), sync_claimed_at = NULL, updated_at = now()
          WHERE connection_id = $1 AND org_id = current_setting('app.org_id')::uuid AND status <> 'unlinked' RETURNING id`,
        [id],
      );
      return { unlinked: unlinked.length };
    });
  },

  /** Start an OAuth round trip: a one-time state (returned once) and its sealed PKCE verifier. */
  async createOAuthState(
    orgId: string,
    userId: string,
    provider: ConnectionProvider,
    codeVerifier: string,
    returnPath = '/app/connections',
  ): Promise<{ state: string; expiresAt: string }> {
    const state = randomBytes(32).toString('base64url');
    const id = randomUUID();
    const [row] = await dataService.query<{ expires_at: Date }>(
      { orgId, userId },
      'connection_oauth_states',
      `INSERT INTO connection_oauth_states (id, org_id, user_id, provider, token_hash, code_verifier_sealed, return_path)
       VALUES ($1, current_setting('app.org_id')::uuid, $2, $3, $4, $5, $6) RETURNING expires_at`,
      [id, userId, provider, sha256(state), sealSecret(codeVerifier, `connection-oauth:${orgId}:${id}`), returnPath],
    );
    return { state, expiresAt: row.expires_at.toISOString() };
  },

  /**
   * Consume a state on the OAuth callback (which carries no session): single-use,
   * expires after 10 minutes, and must come back for the provider it was issued for.
   */
  async consumeOAuthState(
    state: string,
    provider: ConnectionProvider,
  ): Promise<{ orgId: string; userId: string; codeVerifier: string; returnPath: string }> {
    return dataService.transaction({}, async (tx) => {
      const [row] = await tx.lookupByToken<{
        id: string;
        org_id: string;
        user_id: string;
        provider: ConnectionProvider;
        code_verifier_sealed: string;
        return_path: string;
        expired: boolean;
        used: boolean;
      }>(
        'connection_oauth_states',
        `SELECT id, org_id, user_id, provider, code_verifier_sealed, return_path, expires_at < now() AS expired, used_at IS NOT NULL AS used
           FROM connection_oauth_states WHERE token_hash = $1 FOR UPDATE`,
        [sha256(state)],
      );
      if (!row || row.provider !== provider) throw new AppError(400, ErrorCodes.OAUTH_STATE_INVALID, 'This sign-in link is not valid. Start connecting again.');
      if (row.used || row.expired) throw new AppError(400, ErrorCodes.OAUTH_STATE_INVALID, 'This sign-in link has expired. Start connecting again.');
      await tx.setOrg(row.org_id);
      await tx.query('connection_oauth_states', 'UPDATE connection_oauth_states SET used_at = now() WHERE id = $1', [row.id]);
      return {
        orgId: row.org_id,
        userId: row.user_id,
        codeVerifier: openSecret(row.code_verifier_sealed, `connection-oauth:${row.org_id}:${row.id}`),
        returnPath: row.return_path,
      };
    });
  },
};
