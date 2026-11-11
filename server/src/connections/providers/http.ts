/**
 * HTTP for provider adapters: one place that turns provider answers into typed
 * errors the OAuth flow and the sync job can act on.
 *
 *   ProviderAuthError   401 / invalid_grant: the token is dead; refresh or reconnect
 *   ProviderRateLimited 429 / 503: back off (retryAfterSeconds when the provider says)
 *   ProviderError       anything else, with the provider's status
 */

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export class ProviderAuthError extends ProviderError {
  constructor(message: string) {
    super(message, 401, false);
    this.name = 'ProviderAuthError';
  }
}

export class ProviderRateLimited extends ProviderError {
  constructor(
    message: string,
    readonly retryAfterSeconds: number | null,
  ) {
    super(message, 429, true);
    this.name = 'ProviderRateLimited';
  }
}

/** Injected in development checks; defaults to global fetch. */
export type FetchImpl = typeof fetch;
let fetchImpl: FetchImpl = (...a) => fetch(...a);
export function setProviderFetch(f: FetchImpl): void {
  fetchImpl = f;
}

const TIMEOUT_MS = 30_000;

async function call(url: string, init: RequestInit, what: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });
  } catch (err) {
    throw new ProviderError(`${what}: the provider did not answer (${(err as Error).name})`, 503, true);
  }
  if (res.ok) return res;
  const body = (await res.text().catch(() => '')).slice(0, 300);
  if (res.status === 401 || /invalid_grant|expired_access_token|invalid_access_token/i.test(body)) {
    throw new ProviderAuthError(`${what}: the provider rejected the token (${res.status})`);
  }
  if (res.status === 429 || res.status === 503) {
    const ra = Number(res.headers.get('retry-after'));
    throw new ProviderRateLimited(`${what}: rate limited (${res.status})`, Number.isFinite(ra) && ra > 0 ? ra : null);
  }
  throw new ProviderError(`${what}: provider answered ${res.status} ${body}`, res.status, res.status >= 500);
}

export async function getJson<T>(url: string, token: string, what: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await call(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...headers } }, what);
  return (await res.json()) as T;
}

export async function postJson<T>(url: string, token: string, body: unknown, what: string): Promise<T> {
  const res = await call(
    url,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === null ? 'null' : JSON.stringify(body),
    },
    what,
  );
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/** application/x-www-form-urlencoded POST (OAuth token endpoints), optionally with Basic auth. */
export async function postForm<T>(url: string, form: Record<string, string>, what: string, basicAuth?: { user: string; pass: string }): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (basicAuth) headers.Authorization = `Basic ${Buffer.from(`${basicAuth.user}:${basicAuth.pass}`).toString('base64')}`;
  const res = await call(url, { method: 'POST', headers, body: new URLSearchParams(form).toString() }, what);
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/** Download bytes, refusing more than maxBytes (declared length first, then the actual body). */
export async function getBytes(url: string, token: string, maxBytes: number, what: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Buffer> {
  const res = await call(url, { method, headers: { Authorization: `Bearer ${token}`, ...headers } }, what);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > maxBytes) {
    await res.body?.cancel();
    throw new ProviderError(`${what}: the file is ${declared} bytes; the limit is ${maxBytes}`, 413, false);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new ProviderError(`${what}: the file is ${buf.length} bytes; the limit is ${maxBytes}`, 413, false);
  return buf;
}

/** Seconds-from-now to an absolute expiry, a minute early so a token is never used at its edge. */
export const expiry = (expiresIn: number | undefined): Date | null =>
  typeof expiresIn === 'number' && expiresIn > 0 ? new Date(Date.now() + (expiresIn - 60) * 1000) : null;

/** Join a display path inside the linked folder. */
export const relPath = (full: string, folderPath: string): string => {
  const f = folderPath.replace(/\/+$/, '');
  return full.toLowerCase().startsWith(`${f.toLowerCase()}/`) ? full.slice(f.length + 1) : full.replace(/^\/+/, '');
};
