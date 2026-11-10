import { createHash, randomBytes } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { q } from '../db/pool';
import { Codes, ServiceError } from '../errors';

/**
 * Service-to-service authentication (ADR-017). Each caller (main app, worker,
 * later the public pages) is an API client with a key and scopes. The key is
 * shown once; only its SHA-256 hash is stored. Keys travel in `X-Api-Key`.
 */
export type Scope = 'fda:read' | 'fda:track' | 'fda:admin';
export const SCOPES: Scope[] = ['fda:read', 'fda:track', 'fda:admin'];

export interface ApiClient {
  id: string;
  name: string;
  scopes: Scope[];
  ratePerMinute: number;
}

declare module 'express-serve-static-core' {
  interface Request {
    apiClient?: ApiClient;
  }
}

export const hashKey = (key: string): string => createHash('sha256').update(key, 'utf8').digest('hex');

/** New key: "fdk_" + 8-char public prefix + "_" + 43 chars of secret (256 bits). */
export function newKey(): { key: string; prefix: string } {
  const prefix = randomBytes(6).toString('base64url');
  return { key: `fdk_${prefix}_${randomBytes(32).toString('base64url')}`, prefix };
}

/** Short-lived lookup cache so every request does not hit the database. Revocation takes effect within CACHE_MS. */
const CACHE_MS = 30_000;
const cache = new Map<string, { client: ApiClient | null; at: number }>();
const lastUsedWrite = new Map<string, number>();

async function findClient(keyHash: string): Promise<ApiClient | null> {
  const hit = cache.get(keyHash);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.client;
  const [row] = await q<{ id: string; name: string; scopes: Scope[]; rate_per_minute: number }>(
    'SELECT id, name, scopes, rate_per_minute FROM api_clients WHERE key_hash = $1 AND revoked_at IS NULL',
    [keyHash],
  );
  const client = row ? { id: row.id, name: row.name, scopes: row.scopes, ratePerMinute: row.rate_per_minute } : null;
  cache.set(keyHash, { client, at: Date.now() });
  return client;
}

/** Fixed one-minute windows per client, per API instance (limits scale with instances; fine for service callers). */
const windows = new Map<string, { start: number; count: number }>();
function overLimit(client: ApiClient): number | null {
  const now = Date.now();
  const w = windows.get(client.id);
  if (!w || now - w.start >= 60_000) {
    windows.set(client.id, { start: now, count: 1 });
    return null;
  }
  w.count += 1;
  return w.count > client.ratePerMinute ? Math.ceil((w.start + 60_000 - now) / 1000) : null;
}

/** Require a valid service key holding `scope`. 401 without or with a bad key; 403 without the scope; 429 over the client's rate. */
export function requireScope(scope: Scope) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.header('x-api-key');
    if (!key) return next(new ServiceError(401, Codes.UNAUTHORIZED, 'Missing X-Api-Key header'));
    findClient(hashKey(key))
      .then((client) => {
        if (!client) throw new ServiceError(401, Codes.UNAUTHORIZED, 'Invalid or revoked API key');
        if (!client.scopes.includes(scope)) throw new ServiceError(403, Codes.FORBIDDEN, `This API key does not have the ${scope} scope`);
        const retryAfter = overLimit(client);
        if (retryAfter !== null) {
          res.set('Retry-After', String(retryAfter));
          throw new ServiceError(429, Codes.RATE_LIMITED, `Rate limit of ${client.ratePerMinute} requests per minute exceeded`);
        }
        req.apiClient = client;
        // Record use at most once a minute per client.
        if (Date.now() - (lastUsedWrite.get(client.id) ?? 0) > 60_000) {
          lastUsedWrite.set(client.id, Date.now());
          q('UPDATE api_clients SET last_used_at = now() WHERE id = $1', [client.id]).catch(() => undefined);
        }
        next();
      })
      .catch(next);
  };
}

export async function createClient(name: string, scopes: Scope[], ratePerMinute = 1200): Promise<{ key: string; client: ApiClient }> {
  const bad = scopes.filter((s) => !SCOPES.includes(s));
  if (!scopes.length || bad.length) throw new Error(`Scopes must be some of ${SCOPES.join(', ')}${bad.length ? ` (unknown: ${bad.join(', ')})` : ''}`);
  const { key, prefix } = newKey();
  const [row] = await q<{ id: string }>(
    'INSERT INTO api_clients (name, key_prefix, key_hash, scopes, rate_per_minute) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [name, prefix, hashKey(key), scopes, ratePerMinute],
  );
  return { key, client: { id: row.id, name, scopes, ratePerMinute } };
}

export async function revokeClient(name: string): Promise<boolean> {
  const rows = await q('UPDATE api_clients SET revoked_at = now() WHERE name = $1 AND revoked_at IS NULL RETURNING id', [name]);
  cache.clear();
  return rows.length > 0;
}
