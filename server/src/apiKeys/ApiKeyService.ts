import { createHash, randomBytes } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { dataService } from '../services/DataService';
import { AppError, ErrorCodes } from '../utils/AppError';
import { decodeCursor, Page, toPage } from '../utils/pagination';

/**
 * F6.3 API keys: a firm's scoped keys for the public API under /api/v1. A key is "mrk_" plus 32
 * random bytes (base64url); only its SHA-256 is stored and the secret is shown once. Keys are
 * accepted ONLY by /api/v1 routes (never by the app's own routes), and each /api/v1 route names
 * the one scope it needs. Revoked or expired keys are refused.
 */

export const API_SCOPES = ['portfolio:read', 'fda:read'] as const;
export type ApiScope = (typeof API_SCOPES)[number];
export const SCOPE_LABEL: Record<ApiScope, string> = {
  'portfolio:read': "Read the firm's portfolio (projects, stages, due dates, risks)",
  'fda:read': 'Read FDA data (product codes, 510(k) clearances)',
};

const PREFIX = 'mrk_';
const hash = (secret: string) => createHash('sha256').update(secret, 'utf8').digest('hex');

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  createdAt: string;
  createdBy: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  status: 'active' | 'expired' | 'revoked';
}

interface Row {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  created_at: Date;
  created_by_name: string | null;
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

const toView = (r: Row): ApiKeyView => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  scopes: r.scopes,
  createdAt: r.created_at.toISOString(),
  createdBy: r.created_by_name,
  expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
  lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
  revokedAt: r.revoked_at ? r.revoked_at.toISOString() : null,
  status: r.revoked_at ? 'revoked' : r.expires_at && r.expires_at.getTime() <= Date.now() ? 'expired' : 'active',
});

const SELECT = `SELECT k.id, k.name, k.prefix, k.scopes, k.created_at, p.full_name AS created_by_name, k.expires_at, k.last_used_at, k.revoked_at
                  FROM api_keys k LEFT JOIN user_profiles p ON p.user_id = k.created_by`;

export interface ApiKeyAuth {
  keyId: string;
  orgId: string;
  scopes: ApiScope[];
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by requireApiKey on /api/v1 routes. */
    apiKey?: ApiKeyAuth;
  }
}

export const apiKeyService = {
  async create(orgId: string, userId: string, input: { name: string; scopes: ApiScope[]; expiresInDays?: number }): Promise<{ key: ApiKeyView; secret: string }> {
    const secret = PREFIX + randomBytes(32).toString('base64url');
    const [row] = await dataService.query<{ id: string }>(
      { orgId, userId },
      'api_keys',
      `INSERT INTO api_keys (org_id, name, prefix, token_hash, scopes, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::int IS NULL THEN NULL ELSE now() + make_interval(days => $7::int) END) RETURNING id`,
      [orgId, input.name, secret.slice(0, 10), hash(secret), [...new Set(input.scopes)].sort(), userId, input.expiresInDays ?? null],
    );
    return { key: await this.get(orgId, row.id), secret };
  },

  async get(orgId: string, id: string): Promise<ApiKeyView> {
    const [r] = await dataService.query<Row>({ orgId }, 'api_keys', `${SELECT} WHERE k.id = $1 AND k.org_id = current_setting('app.org_id')::uuid`, [id]);
    if (!r) throw new AppError(404, ErrorCodes.NOT_FOUND, 'API key not found');
    return toView(r);
  },

  async list(orgId: string, opts: { limit: number; cursor?: string }): Promise<Page<ApiKeyView>> {
    const c = decodeCursor(opts.cursor);
    const rows = await dataService.query<Row & { id: string }>(
      { orgId },
      'api_keys',
      `${SELECT} WHERE k.org_id = current_setting('app.org_id')::uuid
          AND ($1::timestamptz IS NULL OR (k.created_at, k.id) < ($1::timestamptz, $2::uuid))
        ORDER BY k.created_at DESC, k.id DESC LIMIT $3`,
      [c.createdAt, c.id, opts.limit + 1],
    );
    return toPage(rows, opts.limit, toView);
  },

  /** Revoke at once; revoking an already revoked key changes nothing. */
  async revoke(orgId: string, userId: string, id: string): Promise<void> {
    await this.get(orgId, id); // 404 when not this firm's
    await dataService.query(
      { orgId, userId },
      'api_keys',
      `UPDATE api_keys SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND org_id = current_setting('app.org_id')::uuid AND revoked_at IS NULL`,
      [id, userId],
    );
  },

  /** Resolve a presented secret to its key, or refuse it. */
  async verify(secret: string): Promise<ApiKeyAuth> {
    const invalid = new AppError(401, ErrorCodes.INVALID_API_KEY, 'API key is missing, revoked, expired or not recognised');
    if (!secret.startsWith(PREFIX) || secret.length > 100) throw invalid;
    return dataService.transaction({}, async (tx) => {
      const [k] = await tx.lookupByToken<{ id: string; org_id: string; scopes: ApiScope[]; revoked_at: Date | null; expires_at: Date | null; last_used_at: Date | null }>(
        'api_keys',
        'SELECT id, org_id, scopes, revoked_at, expires_at, last_used_at FROM api_keys WHERE token_hash = $1',
        [hash(secret)],
      );
      if (!k || k.revoked_at || (k.expires_at && k.expires_at.getTime() <= Date.now())) throw invalid;
      // Record use at most once a minute per key.
      if (!k.last_used_at || Date.now() - k.last_used_at.getTime() > 60_000) {
        await tx.setOrg(k.org_id);
        await tx.query('api_keys', 'UPDATE api_keys SET last_used_at = now() WHERE id = $1', [k.id]);
      }
      return { keyId: k.id, orgId: k.org_id, scopes: k.scopes };
    });
  },
};

/** /api/v1 guard: a valid API key (Authorization: Bearer mrk_... or X-Api-Key) holding `scope`. */
export function requireApiKey(scope: ApiScope) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const header = req.headers.authorization || '';
    const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
    const secret = bearer || (typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'].trim() : '');
    if (!secret) {
      next(new AppError(401, ErrorCodes.INVALID_API_KEY, 'API key is missing, revoked, expired or not recognised'));
      return;
    }
    apiKeyService
      .verify(secret)
      .then((auth) => {
        if (!auth.scopes.includes(scope)) throw new AppError(403, ErrorCodes.INSUFFICIENT_SCOPE, `This API key does not have the ${scope} scope`);
        req.apiKey = auth;
        next();
      })
      .catch(next);
  };
}
