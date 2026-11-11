import type {
  Clearance,
  ClearanceSummary,
  EventCounts,
  Flags,
  Meta,
  Page,
  ProductCode,
  Recall,
  RecallParams,
  Search510kParams,
  SearchSummariesParams,
  SummaryPassages,
  SummarySearchResult,
  TrackedCodesResult,
  UdiDevice,
} from './types';

/**
 * Typed client for the fda-data /v1 API (ADR-017). The only way MedexRegAI code
 * reads FDA data. Server-side only: the API key must never reach a browser.
 */

export interface FdaClientOptions {
  /** e.g. http://fda-api.medexregai-prod.internal:4100 or http://localhost:4100 */
  baseUrl: string;
  /** Service key created with `npm run clients -- create <name> <scopes>` in fda-data. */
  apiKey: string;
  /** Per attempt. Default 5 s. */
  timeoutMs?: number;
  /** Retries after the first attempt for network errors, 429 and 5xx. Default 2. */
  retries?: number;
  /** Upper bound for one wait between attempts (also caps Retry-After). Default 2 s. */
  maxBackoffMs?: number;
  /** Max cached GET responses (LRU). 0 disables caching. Default 500. */
  cacheEntries?: number;
  fetchImpl?: typeof fetch;
}

/** Codes from the service, plus FDA_SERVICE_UNAVAILABLE / FDA_SERVICE_TIMEOUT / FDA_BAD_RESPONSE raised by the SDK. */
export class FdaServiceError extends Error {
  constructor(
    /** HTTP status from the service, or 503 when it could not be reached. */
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** Worth trying again later (unreachable, timeout, 429, 5xx). */
    public readonly retryable: boolean,
    public readonly retryAfterSeconds?: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'FdaServiceError';
  }
}

interface CacheEntry {
  etag: string | null;
  body: unknown;
  freshUntil: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FdaClient {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly maxBackoffMs: number;
  private readonly cacheEntries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly opts: FdaClientOptions) {
    if (!opts.baseUrl) throw new Error('FdaClient: baseUrl is required');
    if (!opts.apiKey) throw new Error('FdaClient: apiKey is required');
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.retries = opts.retries ?? 2;
    this.maxBackoffMs = opts.maxBackoffMs ?? 2000;
    this.cacheEntries = opts.cacheEntries ?? 500;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** True when the service and its database answer (GET /ready). Never cached, never retried, never throws. */
  async ready(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.base}/ready`, { signal: AbortSignal.timeout(Math.min(this.timeoutMs, 3000)) });
      return res.ok;
    } catch {
      return false;
    }
  }

  // --- /v1 reads (scope fda:read) -----------------------------------------------

  meta(): Promise<Meta> {
    return this.get('/v1/meta');
  }

  getClearance(kNumber: string): Promise<Clearance> {
    return this.get(`/v1/510k/${encodeURIComponent(kNumber)}`);
  }

  search510k(params: Search510kParams): Promise<Page<ClearanceSummary>> {
    return this.get(`/v1/510k${query(params)}`);
  }

  /** Passages of one 510(k) summary, in document order (F1.2). */
  getSummaryPassages(kNumber: string, params: { limit?: number; offset?: number } = {}): Promise<SummaryPassages> {
    return this.get(`/v1/510k/${encodeURIComponent(kNumber)}/passages${query(params)}`);
  }

  /** Hybrid keyword + semantic search across indexed 510(k) summaries (F1.2). */
  searchSummaries(params: SearchSummariesParams): Promise<SummarySearchResult> {
    return this.get(`/v1/search/summaries${query(params)}`);
  }

  getProductCode(code: string): Promise<ProductCode> {
    return this.get(`/v1/product-codes/${encodeURIComponent(code)}`);
  }

  getFlags(kNumber: string): Promise<Flags> {
    return this.get(`/v1/flags/${encodeURIComponent(kNumber)}`);
  }

  listRecalls(params: RecallParams): Promise<Page<Recall>> {
    return this.get(`/v1/recalls${query(params)}`);
  }

  getUdi(di: string): Promise<UdiDevice> {
    return this.get(`/v1/udi/${encodeURIComponent(di)}`);
  }

  getEventCounts(code: string, from: string, to: string): Promise<EventCounts> {
    return this.get(`/v1/event-counts/${encodeURIComponent(code)}${query({ from, to })}`);
  }

  // --- tracking (scope fda:track) ---------------------------------------------------

  /** Replace this client's set of product codes whose MAUDE counts the service follows. */
  putTrackedProductCodes(productCodes: string[]): Promise<TrackedCodesResult> {
    return this.send('PUT', '/v1/tracked-product-codes', { productCodes });
  }

  // --- transport -----------------------------------------------------------------------

  /** GET with an ETag-aware LRU cache: fresh -> local; stale -> If-None-Match, 304 reuses the body. */
  private async get<T>(path: string): Promise<T> {
    const cached = this.cache.get(path);
    if (cached && cached.freshUntil > Date.now()) {
      this.touch(path, cached);
      return cached.body as T;
    }
    const res = await this.request('GET', path, undefined, cached?.etag ?? undefined);
    if (res.status === 304 && cached) {
      cached.freshUntil = Date.now() + maxAgeMs(res.headers.get('cache-control'));
      this.touch(path, cached);
      return cached.body as T;
    }
    const body = (await this.parse(res)) as T;
    const ttl = maxAgeMs(res.headers.get('cache-control'));
    if (this.cacheEntries > 0 && (ttl > 0 || res.headers.get('etag'))) {
      this.touch(path, { etag: res.headers.get('etag'), body, freshUntil: Date.now() + ttl });
    }
    return body;
  }

  private async send<T>(method: 'PUT' | 'POST', path: string, body: unknown): Promise<T> {
    return (await this.parse(await this.request(method, path, body))) as T;
  }

  private touch(path: string, entry: CacheEntry): void {
    this.cache.delete(path);
    this.cache.set(path, entry);
    while (this.cache.size > this.cacheEntries) this.cache.delete(this.cache.keys().next().value as string);
  }

  /** One logical request with retries for network errors, timeouts, 429 and 5xx. */
  private async request(method: string, path: string, body?: unknown, etag?: string): Promise<Response> {
    let lastError: FdaServiceError | null = null;
    let serverRetryAfter = 0;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) {
        const backoff = Math.min(this.maxBackoffMs, 200 * 2 ** (attempt - 1));
        // Only a server's own Retry-After stretches the wait; the SDK's hint for callers does not.
        const hinted = serverRetryAfter ? Math.min(this.maxBackoffMs, serverRetryAfter * 1000) : 0;
        await sleep(Math.max(backoff, hinted));
      }
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.base}${path}`, {
          method,
          headers: {
            'X-Api-Key': this.opts.apiKey,
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(etag ? { 'If-None-Match': etag } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        serverRetryAfter = 0;
        const e = err as { name?: string; message?: string; cause?: { code?: string } };
        lastError =
          e?.name === 'TimeoutError' || e?.name === 'AbortError'
            ? new FdaServiceError(503, 'FDA_SERVICE_TIMEOUT', `FDA data service did not answer within ${this.timeoutMs} ms`, true, 5)
            : new FdaServiceError(
                503,
                'FDA_SERVICE_UNAVAILABLE',
                `FDA data service is not reachable (${e?.cause?.code ?? e?.message ?? 'network error'})`,
                true,
                5,
              );
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        serverRetryAfter = Number(res.headers.get('retry-after')) || 0;
        lastError = await this.toError(res);
        continue;
      }
      return res;
    }
    throw lastError ?? new FdaServiceError(503, 'FDA_SERVICE_UNAVAILABLE', 'FDA data service is not reachable', true, 5);
  }

  private async parse(res: Response): Promise<unknown> {
    if (!res.ok) throw await this.toError(res);
    let json: { success?: boolean; data?: unknown };
    try {
      json = (await res.json()) as { success?: boolean; data?: unknown };
    } catch {
      throw new FdaServiceError(502, 'FDA_BAD_RESPONSE', 'FDA data service returned a response that is not JSON', false);
    }
    if (json?.success !== true || !('data' in json)) throw new FdaServiceError(502, 'FDA_BAD_RESPONSE', 'FDA data service returned an unexpected body', false);
    return json.data;
  }

  private async toError(res: Response): Promise<FdaServiceError> {
    const retryAfter = Number(res.headers.get('retry-after'));
    let code = res.status >= 500 ? 'FDA_SERVICE_UNAVAILABLE' : 'FDA_SERVICE_ERROR';
    let message = `FDA data service answered HTTP ${res.status}`;
    let details: unknown;
    try {
      const j = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown } };
      if (j?.error?.code) code = j.error.code;
      if (j?.error?.message) message = j.error.message;
      details = j?.error?.details;
    } catch {
      /* non-JSON error body */
    }
    const retryable = res.status === 429 || res.status >= 500;
    return new FdaServiceError(
      res.status,
      code,
      message,
      retryable,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : retryable ? 5 : undefined,
      details,
    );
  }
}

function query(params: object): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** max-age from Cache-Control, in ms (0 when absent or no-store). */
function maxAgeMs(header: string | null): number {
  if (!header || /no-store/i.test(header)) return 0;
  const m = /max-age=(\d+)/i.exec(header);
  return m ? Number(m[1]) * 1000 : 0;
}
