import { createHash } from 'crypto';
import { config } from '../config';
import { primaryPool, q } from '../db/pool';
import { DocumentStore, FsDocumentStore, S3DocumentStore, summaryKey } from './documentStore';
import { isKNumber, summaryUrls } from './summaryUrls';

/**
 * Polite fetcher for public 510(k) summary PDFs (F1.2, ADR-017). Runs in fda-worker.
 *
 * - Scope: K-numbers cleared under a product code the app tracks (tracked_product_codes).
 * - Once: a K-number that is `fetched` or `no_summary` is never requested again, and a
 *   PDF already in the bucket is adopted without a request.
 * - Politely: one request at a time, at least FDA_DOCS_MIN_INTERVAL_MS apart, a plain
 *   User-Agent naming the service, and backoff after 429/5xx/timeouts.
 * - "No summary on file": the FDA lists a 510(k) statement for the K-number, or no
 *   summary PDF exists at any published location (404 everywhere).
 */

const USER_AGENT = 'MedexRegAI-fda-data/0.1 (public 510(k) summary cache)';
const STALE_CLAIM_MINUTES = 30;
const MAX_BACKOFF_MINUTES = 24 * 60;

export type FetchOutcome = 'fetched' | 'cached' | 'no_summary' | 'failed';

export interface FetcherDeps {
  store?: DocumentStore;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface Claimed {
  k_number: string;
  attempts: number;
}

export function defaultDocumentStore(): DocumentStore {
  const d = config.docs;
  if (d.bucket) {
    return new S3DocumentStore({
      bucket: d.bucket,
      region: d.region,
      endpoint: d.endpoint ?? undefined,
      forcePathStyle: d.forcePathStyle,
      accessKeyId: d.accessKeyId ?? undefined,
      secretAccessKey: d.secretAccessKey ?? undefined,
    });
  }
  return new FsDocumentStore(d.dir);
}

/** Minutes to wait after failed attempt n: 15, 30, 60 ... capped at one day. */
export function backoffMinutes(attempts: number): number {
  return Math.min(2 ** Math.max(attempts - 1, 0) * 15, MAX_BACKOFF_MINUTES);
}

/** Why a K-number has no summary on file, worded for a consultant. */
export function noSummaryReason(kNumber: string, triedUrls: boolean): string {
  if (!triedUrls) return 'Not a 510(k) number';
  const yy = Number(kNumber.slice(1, 3));
  const before2002 = yy >= 76 || yy < 2;
  return before2002
    ? 'No summary PDF found on accessdata.fda.gov; summaries for clearances before 2002 are often not online'
    : 'No summary PDF is published on accessdata.fda.gov for this K-number';
}

const isPdf = (bytes: Buffer): boolean => bytes.length > 4 && bytes.subarray(0, 5).toString('latin1') === '%PDF-';

export class SummaryFetcher {
  private readonly store: DocumentStore;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private nextSlot = 0;

  constructor(deps: FetcherDeps = {}) {
    this.store = deps.store ?? defaultDocumentStore();
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? Date.now;
  }

  /**
   * Queue every K-number under a tracked product code that has no document row yet.
   * Records the FDA lists as a "Statement" are settled straight away as no summary.
   */
  async enqueueTracked(): Promise<{ queued: number; statements: number }> {
    const queued = await q<{ n: string }>(
      `WITH ins AS (
         INSERT INTO fda_510k_documents (k_number)
         SELECT k.k_number FROM fda_510k k
          WHERE k.k_number ~ '^K[0-9]{6}$'
            AND k.statement_or_summary IS DISTINCT FROM 'Statement'
            AND k.product_code IN (SELECT DISTINCT product_code FROM tracked_product_codes)
         ON CONFLICT (k_number) DO NOTHING RETURNING 1)
       SELECT count(*) AS n FROM ins`,
    );
    const statements = await q<{ n: string }>(
      `WITH ins AS (
         INSERT INTO fda_510k_documents (k_number, status, reason, checked_at)
         SELECT k.k_number, 'no_summary', 'The FDA lists a 510(k) statement, not a summary, for this clearance', now()
           FROM fda_510k k
          WHERE k.k_number ~ '^K[0-9]{6}$'
            AND k.statement_or_summary = 'Statement'
            AND k.product_code IN (SELECT DISTINCT product_code FROM tracked_product_codes)
         ON CONFLICT (k_number) DO NOTHING RETURNING 1)
       SELECT count(*) AS n FROM ins`,
    );
    return { queued: Number(queued[0]?.n ?? 0), statements: Number(statements[0]?.n ?? 0) };
  }

  /** Put claims left behind by a crashed worker back in the queue. */
  async requeueStale(): Promise<number> {
    const rows = await q(
      `UPDATE fda_510k_documents SET status = 'queued', claimed_at = NULL, updated_at = now()
        WHERE status = 'fetching' AND claimed_at < now() - make_interval(mins => $1) RETURNING 1`,
      [STALE_CLAIM_MINUTES],
    );
    return rows.length;
  }

  /**
   * Claim up to `limit` due K-numbers (SKIP LOCKED: several workers never share one).
   * Newest clearances first: they are the likely predicates.
   */
  private async claim(limit: number): Promise<Claimed[]> {
    const { rows } = await primaryPool().query<Claimed>(
      `UPDATE fda_510k_documents d SET status = 'fetching', claimed_at = now(), attempts = d.attempts + 1, updated_at = now()
        WHERE d.k_number IN (
          SELECT doc.k_number FROM fda_510k_documents doc
            LEFT JOIN fda_510k k ON k.k_number = doc.k_number
           WHERE doc.status IN ('queued', 'failed') AND doc.next_attempt_at <= now()
           ORDER BY k.decision_date DESC NULLS LAST, doc.k_number LIMIT $1 FOR UPDATE OF doc SKIP LOCKED)
        RETURNING d.k_number, d.attempts`,
      [limit],
    );
    return rows;
  }

  /** Fetch one pass: requeue stale claims, claim a batch, fetch each politely. */
  async runPass(limit = config.docs.batchSize): Promise<Record<FetchOutcome, number>> {
    const counts: Record<FetchOutcome, number> = { fetched: 0, cached: 0, no_summary: 0, failed: 0 };
    await this.requeueStale();
    for (const row of await this.claim(limit)) {
      counts[await this.fetchOne(row)] += 1;
    }
    return counts;
  }

  /** Wait for the next free request slot. */
  private async throttle(): Promise<void> {
    const now = this.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + config.docs.minIntervalMs;
    if (slot > now) await this.sleep(slot - now);
  }

  private async fetchOne({ k_number: kNumber, attempts }: Claimed): Promise<FetchOutcome> {
    const key = summaryKey(kNumber);
    try {
      // Never re-fetch: a PDF already in the bucket (e.g. a lost status update) is adopted.
      if ((await this.store.size(key)) !== null) {
        const bytes = await this.store.get(key);
        await this.markFetched(kNumber, null, key, bytes);
        return 'cached';
      }
      const urls = isKNumber(kNumber) ? summaryUrls(kNumber) : [];
      for (const url of urls) {
        const res = await this.request(url);
        if (res.status === 404 || res.status === 410) continue;
        if (res.status === 429 || res.status >= 500) return this.markFailed(kNumber, attempts, `accessdata.fda.gov answered ${res.status}`);
        if (res.status !== 200) return this.markFailed(kNumber, attempts, `Unexpected answer ${res.status} from accessdata.fda.gov`);
        const bytes = res.bytes;
        if (!bytes || !isPdf(bytes)) {
          // A 200 HTML page instead of a PDF is the site's "not found" page in another form.
          continue;
        }
        await this.store.put(key, bytes, 'application/pdf');
        await this.markFetched(kNumber, url, key, bytes);
        return 'fetched';
      }
      await q(
        `UPDATE fda_510k_documents SET status = 'no_summary', reason = $2, source_url = NULL, claimed_at = NULL,
                checked_at = now(), updated_at = now() WHERE k_number = $1`,
        [kNumber, noSummaryReason(kNumber, urls.length > 0)],
      );
      return 'no_summary';
    } catch (err) {
      return this.markFailed(kNumber, attempts, (err as Error).message);
    }
  }

  /** GET one URL politely. Bodies over FDA_DOCS_MAX_BYTES are refused. */
  private async request(url: string): Promise<{ status: number; bytes: Buffer | null }> {
    await this.throttle();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), config.docs.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/pdf' },
        redirect: 'follow',
        signal: ctl.signal,
      });
      if (res.status !== 200) {
        await res.body?.cancel();
        return { status: res.status, bytes: null };
      }
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > config.docs.maxBytes) {
        await res.body?.cancel();
        throw new Error(`The summary PDF is ${declared} bytes; the limit is ${config.docs.maxBytes}`);
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > config.docs.maxBytes) throw new Error(`The summary PDF is ${bytes.length} bytes; the limit is ${config.docs.maxBytes}`);
      return { status: 200, bytes };
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw new Error(`accessdata.fda.gov did not answer within ${config.docs.timeoutMs} ms`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async markFetched(kNumber: string, url: string | null, key: string, bytes: Buffer): Promise<void> {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await q(
      `UPDATE fda_510k_documents SET status = 'fetched', reason = NULL, source_url = COALESCE($2, source_url), storage_key = $3,
              sha256 = $4, size_bytes = $5, claimed_at = NULL, fetched_at = COALESCE(fetched_at, now()), checked_at = now(), updated_at = now()
        WHERE k_number = $1`,
      [kNumber, url, key, sha256, bytes.length],
    );
  }

  private async markFailed(kNumber: string, attempts: number, reason: string): Promise<'failed'> {
    await q(
      `UPDATE fda_510k_documents SET status = 'failed', reason = left($2, 500), claimed_at = NULL, checked_at = now(),
              next_attempt_at = now() + make_interval(mins => $3), updated_at = now()
        WHERE k_number = $1`,
      [kNumber, reason, backoffMinutes(attempts)],
    );
    return 'failed';
  }
}
