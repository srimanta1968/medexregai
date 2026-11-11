import { config } from './config/env';
import { pushTrackedProductCodes } from './fda/fdaService';
import { processQueued, sweep } from './ingest/IngestService';
import { embedPendingAll } from './retrieval/embeddings';
import { closePool } from './services/DataService';

/**
 * Background worker (ECS service "worker", Terraform runs `node dist/worker.js`).
 * FDA data now lives in the fda-data service (ADR-017); this worker only keeps it
 * told which product codes our firms work with (at start and every 6 hours; device
 * changes also push within seconds from the API).
 *
 * F7.2 ingest: parses queued file versions through the docproc sidecar and sweeps
 * stuck claims and leftover linked copies. The queued-version pass is the interim
 * dispatcher until the F8.2 job framework; it only runs when DOCPROC_API_KEY is set.
 */

const PUSH_EVERY_MS = 6 * 60 * 60 * 1000;
const INGEST_EVERY_MS = 10 * 1000;
const SWEEP_EVERY_MS = 10 * 60 * 1000;
const timers: NodeJS.Timeout[] = [];
let ingestRunning = false;

async function ingestPass(): Promise<void> {
  if (ingestRunning) return;
  ingestRunning = true;
  try {
    const counts = await processQueued();
    const done = counts.parsed + counts.failed + counts.unsupported + counts.retry;
    if (done) console.info(`[worker] ingest: ${JSON.stringify(counts)}`);
  } catch (err) {
    console.error(`[worker] ingest pass failed: ${(err as Error).message}`);
  } finally {
    ingestRunning = false;
  }
}

let embedRunning = false;
let embedFailures = 0;

/** Embed new chunks; after a failure (model down) wait progressively longer, up to 5 minutes. */
async function embedPass(): Promise<void> {
  if (embedRunning) return;
  embedRunning = true;
  try {
    const n = await embedPendingAll();
    if (n) console.info(`[worker] embedded ${n} chunk(s)`);
    embedFailures = 0;
  } catch (err) {
    embedFailures += 1;
    if (embedFailures === 1 || embedFailures % 10 === 0) console.error(`[worker] embedding failed (${embedFailures}x): ${(err as Error).message}`);
  } finally {
    embedRunning = false;
  }
}

async function sweepPass(): Promise<void> {
  try {
    const r = await sweep();
    if (r.requeued || r.gaveUp || r.discarded || r.errors) console.info(`[worker] ingest sweep: ${JSON.stringify(r)}`);
  } catch (err) {
    console.error(`[worker] ingest sweep failed: ${(err as Error).message}`);
  }
}

async function push(reason: string): Promise<void> {
  try {
    const r = await pushTrackedProductCodes();
    if (r) console.info(`[worker] tracked product codes pushed (${reason}): ${r.tracked} tracked, ${r.added} new`);
    else console.warn('[worker] FDA_SERVICE_KEY is empty: tracked product codes not pushed');
  } catch (err) {
    console.error(`[worker] tracked product codes push failed (${reason}): ${(err as Error).message}`);
  }
}

async function shutdown(signal: string): Promise<void> {
  timers.forEach(clearInterval);
  console.info(`[worker] ${signal}: stopping`);
  await closePool();
  process.exit(0);
}

if (require.main === module) {
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  void push('start');
  timers.push(setInterval(() => void push('schedule'), PUSH_EVERY_MS));
  void sweepPass();
  timers.push(setInterval(() => void sweepPass(), SWEEP_EVERY_MS));
  // Embeddings back off on failure: skip ticks until 2^failures ticks (max 30 = 5 min) have passed.
  let tick = 0;
  timers.push(
    setInterval(() => {
      tick += 1;
      if (tick >= Math.min(2 ** embedFailures, 30)) {
        tick = 0;
        void embedPass();
      }
    }, INGEST_EVERY_MS),
  );
  if (config.docproc.serviceKey) {
    timers.push(setInterval(() => void ingestPass(), INGEST_EVERY_MS));
  } else {
    console.warn('[worker] DOCPROC_API_KEY is empty: file versions are not parsed');
  }
}
