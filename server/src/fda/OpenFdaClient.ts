/**
 * openFDA client (https://open.fda.gov/apis/). Used only by the sync worker; user
 * requests never call openFDA (E1).
 *
 * - Rate: requests are spaced to stay within OPENFDA_MAX_PER_MINUTE (default and
 *   maximum 240, openFDA's per-minute limit).
 * - Retry: 429, 5xx and network errors back off exponentially (honouring
 *   Retry-After) up to `maxAttempts`.
 * - Paging: follows the `Link: <...search_after=...>; rel="next"` header openFDA
 *   returns, so result sets deeper than the 25,000 `skip` cap can be read.
 * - openFDA answers "no matches" with HTTP 404 NOT_FOUND; that is an empty result.
 */

export interface OpenFdaMeta {
  last_updated?: string;
  results?: { skip: number; limit: number; total: number };
}

export interface OpenFdaPage<T> {
  meta: OpenFdaMeta;
  results: T[];
  next: string | null;
}

export interface OpenFdaOptions {
  baseUrl?: string;
  apiKey?: string;
  maxPerMinute?: number;
  maxAttempts?: number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export class OpenFdaError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'OpenFdaError';
  }
}

const OPENFDA_MAX_PER_MINUTE = 240;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(part);
    if (m) return m[1];
  }
  return null;
}

export class OpenFdaClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly intervalMs: number;
  private readonly maxAttempts: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private nextSlot = 0;
  /** Requests actually sent (including retries), for logging and tests. */
  requestsSent = 0;

  constructor(opts: OpenFdaOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.fda.gov').replace(/\/+$/, '');
    this.apiKey = opts.apiKey || undefined;
    const perMinute = Math.min(Math.max(opts.maxPerMinute ?? OPENFDA_MAX_PER_MINUTE, 1), OPENFDA_MAX_PER_MINUTE);
    this.intervalMs = Math.ceil(60_000 / perMinute);
    this.maxAttempts = Math.max(opts.maxAttempts ?? 6, 1);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  /** Build an endpoint URL, e.g. url('/device/510k.json', { search, limit: 100 }). */
  url(path: string, params: Record<string, string | number | undefined>): string {
    const u = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  /** Wait for the next free request slot (one every intervalMs). */
  private async throttle(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.intervalMs;
    if (slot > now) await this.sleep(slot - now);
  }

  private withKey(url: string): string {
    if (!this.apiKey) return url;
    const u = new URL(url);
    if (!u.searchParams.has('api_key')) u.searchParams.set('api_key', this.apiKey);
    return u.toString();
  }

  /** One page, with throttling and retries. */
  async page<T>(url: string): Promise<OpenFdaPage<T>> {
    for (let attempt = 1; ; attempt++) {
      await this.throttle();
      this.requestsSent++;
      let res: Response;
      try {
        res = await this.fetchImpl(this.withKey(url), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (err) {
        if (attempt >= this.maxAttempts) throw new OpenFdaError(`openFDA unreachable: ${(err as Error).message}`, 0);
        await this.sleep(this.backoff(attempt, null));
        continue;
      }
      if (res.ok) {
        const body = (await res.json()) as { meta?: OpenFdaMeta; results?: T[] };
        return { meta: body.meta ?? {}, results: body.results ?? [], next: nextLink(res.headers.get('link')) };
      }
      if (res.status === 404) {
        const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
        if (body.error?.code === 'NOT_FOUND') return { meta: {}, results: [], next: null };
        throw new OpenFdaError('openFDA endpoint not found', 404, body.error?.code);
      }
      if (RETRYABLE.has(res.status) && attempt < this.maxAttempts) {
        await this.sleep(this.backoff(attempt, res.headers.get('retry-after')));
        continue;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
      throw new OpenFdaError(`openFDA ${res.status}: ${body.error?.message ?? res.statusText}`, res.status, body.error?.code);
    }
  }

  /** Every page of a query, following rel="next" links. */
  async *pages<T>(path: string, params: Record<string, string | number | undefined>): AsyncGenerator<OpenFdaPage<T>> {
    let url: string | null = this.url(path, { limit: 1000, ...params });
    while (url) {
      const p: OpenFdaPage<T> = await this.page<T>(url);
      yield p;
      url = p.results.length > 0 ? p.next : null;
    }
  }

  /** A `count=` query (e.g. MAUDE reports per day): [{ time|term, count }]. */
  async count(path: string, params: { search?: string; count: string }): Promise<{ meta: OpenFdaMeta; results: { time?: string; term?: string; count: number }[] }> {
    const p = await this.page<{ time?: string; term?: string; count: number }>(this.url(path, params));
    return { meta: p.meta, results: p.results };
  }

  /** Delay before retry n: Retry-After if given, else 1s, 2s, 4s ... (max 60s) plus jitter. */
  private backoff(attempt: number, retryAfter: string | null): number {
    const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : NaN;
    if (Number.isFinite(seconds)) return Math.min(seconds, 120) * 1000;
    return Math.min(1000 * 2 ** (attempt - 1), 60_000) + Math.floor(Math.random() * 250);
  }
}
