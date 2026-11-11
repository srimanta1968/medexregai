import { config } from './config';
import { DATASETS, FdaSyncService } from './sync/FdaSyncService';
import { closePools as closePool, q } from './db/pool';
import { runNextSyncRequest } from './sync/requestQueue';
import { SummaryFetcher } from './docs/SummaryFetcher';

/**
 * fda-data worker (ADR-017): the only writer to the FDA database. Runs the daily
 * openFDA sync, catches up at start, and runs syncs queued through
 * POST /v1/admin/syncs (polled every QUEUE_POLL_MS). Several instances are safe: each dataset
 * sync takes a Postgres advisory lock, so only one runs at a time.
 *
 * F1.2: every DOCS_POLL_MS it queues the 510(k) summaries of tracked product codes and
 * fetches a batch politely into the FDA document bucket (FDA_DOCS_ENABLED=false turns it off).
 */

const sync = new FdaSyncService();
let timer: NodeJS.Timeout | undefined;
let stopping = false;
let queueTimer: NodeJS.Timeout | undefined;
const QUEUE_POLL_MS = 15_000;
const DOCS_POLL_MS = 60_000;
let docsTimer: NodeJS.Timeout | undefined;
let fetcher: SummaryFetcher | undefined;

/** Milliseconds until the next FDA_SYNC_HOUR_UTC:00. */
export function msUntilNextRun(now: Date, hourUtc: number): number {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

async function runSync(reason: string): Promise<void> {
  console.info(`[worker] FDA sync starting (${reason})`);
  for (const r of await sync.runAll()) {
    const line = `[worker] fda ${r.dataset}: ${r.status}, ${r.upserted} upserted${r.windowFrom ? `, window ${r.windowFrom}..${r.windowTo}` : ''}${
      r.sourceLastUpdated ? `, source as of ${r.sourceLastUpdated}` : ''
    }${r.error ? ` (${r.error})` : ''}`;
    if (r.status === 'failed') console.error(line);
    else console.info(line);
  }
}

function schedule(): void {
  if (stopping) return;
  const wait = msUntilNextRun(new Date(), config.openFda.syncHourUtc);
  console.info(`[worker] next FDA sync in ${Math.round(wait / 60000)} min`);
  timer = setTimeout(() => {
    runSync('daily schedule')
      .catch((err: unknown) => console.error(`[worker] FDA sync crashed: ${(err as Error).message}`))
      .finally(schedule);
  }, wait);
}

/** On start, catch up if any dataset has no successful sync in the last 24 hours. */
async function catchUpIfStale(): Promise<void> {
  const rows = await q<{ dataset: string }>(
    `SELECT dataset FROM fda_sync_runs WHERE status = 'succeeded' AND finished_at > now() - interval '24 hours' GROUP BY dataset`,
    [],
  );
  const fresh = new Set(rows.map((r) => r.dataset));
  if (DATASETS.some((d) => !fresh.has(d))) await runSync('catch-up at start');
}

/** Drain queued sync requests, then check again in QUEUE_POLL_MS. */
function pollQueue(): void {
  if (stopping) return;
  (async () => {
    while (!stopping && (await runNextSyncRequest(sync))) {
      /* keep draining */
    }
  })()
    .catch((err: unknown) => console.error(`[worker] sync queue failed: ${(err as Error).message}`))
    .finally(() => {
      if (!stopping) queueTimer = setTimeout(pollQueue, QUEUE_POLL_MS);
    });
}

/** Queue tracked K-numbers, fetch one batch of summary PDFs, then wait DOCS_POLL_MS. */
function pollDocs(): void {
  if (stopping || !config.docs.enabled) return;
  fetcher ??= new SummaryFetcher();
  const f = fetcher;
  (async () => {
    const added = await f.enqueueTracked();
    if (added.queued || added.statements)
      console.info(`[worker] 510(k) summaries: ${added.queued} queued, ${added.statements} statements (no summary on file)`);
    const r = await f.runPass();
    if (r.fetched + r.cached + r.no_summary + r.failed) console.info(`[worker] 510(k) summaries: ${JSON.stringify(r)}`);
  })()
    .catch((err: unknown) => console.error(`[worker] 510(k) summary pass failed: ${(err as Error).message}`))
    .finally(() => {
      if (!stopping) docsTimer = setTimeout(pollDocs, DOCS_POLL_MS);
    });
}

async function shutdown(signal: string): Promise<void> {
  stopping = true;
  if (timer) clearTimeout(timer);
  if (queueTimer) clearTimeout(queueTimer);
  if (docsTimer) clearTimeout(docsTimer);
  console.info(`[worker] ${signal}: stopping`);
  await closePool();
  process.exit(0);
}

if (require.main === module) {
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  pollQueue();
  pollDocs();
  catchUpIfStale()
    .catch((err: unknown) => console.error(`[worker] catch-up failed: ${(err as Error).message}`))
    .finally(schedule);
}
