import { evalStore } from './ai/eval/EvalStore';
import { config } from './config/env';
import { pushTrackedProductCodes } from './fda/fdaService';
import { processQueued, queueDepth, sweep } from './ingest/IngestService';
import { embedPendingAll } from './retrieval/embeddings';
import { closePool } from './services/DataService';
import { inboundEmailService } from './inbound/InboundEmailService';
import { folderSync } from './connections/FolderSync';
import { sectionClassifier } from './sorting/SectionClassifier';
import { revisionDetector } from './sorting/RevisionDetector';
import { problemEngine } from './problems/ProblemEngine';
import { checkPendingDrafts } from './drafting/DraftChecker';
import { usageService } from './usage/UsageService';
import { draftPending } from './drafting/SectionDrafter';
import { trustService } from './trust/TrustService';

/**
 * Background worker (ECS service "worker", Terraform runs `node dist/worker.js`).
 * FDA data now lives in the fda-data service (ADR-017); this worker only keeps it
 * told which product codes our firms work with (at start and every 6 hours; device
 * changes also push within seconds from the API).
 *
 * F7.2 ingest: parses queued file versions through the docproc sidecar and sweeps
 * stuck claims and leftover linked copies. The queued-version pass is the interim
 * dispatcher until the F8.2 job framework; it only runs when DOCPROC_API_KEY is set.
 *
 * F7.4: runs queued evaluations of firms' own models (one at a time; each makes
 * about 50 model calls) and closes runs that lost their worker.
 *
 * F2.5: finishes project deletions (removes stored file objects, issues the
 * certificate). The API starts this right after a deletion; this pass retries.
 *
 * F2.1: processes emails forwarded to project addresses (every 15 s, so attachments
 * land well within the 2 minutes FR-14.2 allows, also when the API's own attempt failed).
 */

const PUSH_EVERY_MS = 6 * 60 * 60 * 1000;
const INGEST_EVERY_MS = 10 * 1000;
const SWEEP_EVERY_MS = 10 * 60 * 1000;
const EVAL_EVERY_MS = 30 * 1000;
const DELETION_EVERY_MS = 60 * 1000;
const INBOUND_EVERY_MS = 15 * 1000;
/** How often due folder links are looked for; each link is itself due every 15 minutes (FolderSync). */
const FOLDER_SYNC_EVERY_MS = 60 * 1000;
/** F2.2: sort newly read files into eSTAR sections. */
const SORT_EVERY_MS = 15 * 1000;
/** Section drafts (F3.2) wait for a model call; check the queue often. */
const DRAFT_EVERY_MS = 10 * 1000;
const timers: NodeJS.Timeout[] = [];
let ingestRunning = false;
let evalRunning = false;

async function evalPass(): Promise<void> {
  if (evalRunning) return;
  evalRunning = true;
  try {
    const r = await evalStore.processQueued();
    if (r.ran || r.stale) console.info(`[worker] evaluations: ${JSON.stringify(r)}`);
  } catch (err) {
    console.error(`[worker] evaluation pass failed: ${(err as Error).message}`);
  } finally {
    evalRunning = false;
  }
}

let deletionRunning = false;

async function deletionPass(): Promise<void> {
  if (deletionRunning) return;
  deletionRunning = true;
  try {
    const r = await trustService.processPending();
    if (r.completed || r.pending) console.info(`[worker] project deletions: ${JSON.stringify(r)}`);
  } catch (err) {
    console.error(`[worker] project deletion pass failed: ${(err as Error).message}`);
  } finally {
    deletionRunning = false;
  }
}

let folderSyncRunning = false;

/** F2.1 linked folders: change feeds every 15 minutes per link, full hash sweep daily. */
async function folderSyncPass(): Promise<void> {
  if (folderSyncRunning) return;
  folderSyncRunning = true;
  try {
    const r = await folderSync.processDue();
    if (r.links) console.info(`[worker] folder sync: ${JSON.stringify(r)}`);
  } catch (err) {
    console.error(`[worker] folder sync pass failed: ${(err as Error).message}`);
  } finally {
    folderSyncRunning = false;
  }
}

let sortRunning = false;

async function sortPass(): Promise<void> {
  if (sortRunning) return;
  sortRunning = true;
  try {
    const r = await sectionClassifier.sortPending();
    if (r.sorted || r.errors) console.info(`[worker] sorting: ${JSON.stringify(r)}`);
    const v = await revisionDetector.detectChanged();
    if (v.projects) console.info(`[worker] version groups: ${JSON.stringify(v)}`);
    const p = await problemEngine.detectChanged();
    if (p.projects) console.info(`[worker] problems re-checked: ${JSON.stringify(p)}`);
  } catch (err) {
    console.error(`[worker] sorting pass failed: ${(err as Error).message}`);
  } finally {
    sortRunning = false;
  }
}

let draftRunning = false;

async function draftPass(): Promise<void> {
  if (draftRunning) return;
  draftRunning = true;
  try {
    const n = await draftPending();
    if (n) console.info(`[worker] section drafts: ${n}`);
    // F3.5: predicate K-numbers in ready drafts, checked against FDA data.
    const c = await checkPendingDrafts();
    if (c) console.info(`[worker] draft FDA checks: ${c}`);
    // F4.3: daily usage per client and project, from the usage events of the last two days.
    await usageService.rollupRecent();
  } catch (err) {
    console.error(`[worker] drafting pass failed: ${(err as Error).message}`);
  } finally {
    draftRunning = false;
  }
}

let inboundRunning = false;

async function inboundPass(): Promise<void> {
  if (inboundRunning) return;
  inboundRunning = true;
  try {
    const r = await inboundEmailService.processQueued();
    if (Object.keys(r).length) console.info(`[worker] forwarded emails: ${JSON.stringify(r)}`);
  } catch (err) {
    console.error(`[worker] forwarded email pass failed: ${(err as Error).message}`);
  } finally {
    inboundRunning = false;
  }
}

/**
 * One CloudWatch Embedded Metric Format line: under the awslogs driver CloudWatch turns it
 * into MedexRegAI/Ingest QueueDepth, which scales the sandboxed docproc pool (no SDK needed).
 */
async function publishQueueDepth(): Promise<void> {
  try {
    const depth = await queueDepth();
    console.info(
      JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [{ Namespace: 'MedexRegAI/Ingest', Dimensions: [['Environment']], Metrics: [{ Name: 'QueueDepth', Unit: 'Count' }] }],
        },
        Environment: process.env.APP_ENVIRONMENT ?? 'development',
        QueueDepth: depth,
      }),
    );
  } catch (err) {
    console.error(`[worker] queue depth metric failed: ${(err as Error).message}`);
  }
}

async function ingestPass(): Promise<void> {
  if (ingestRunning) return;
  ingestRunning = true;
  try {
    if (config.docproc.queueMetric) await publishQueueDepth();
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
  timers.push(setInterval(() => void evalPass(), EVAL_EVERY_MS));
  void deletionPass();
  timers.push(setInterval(() => void deletionPass(), DELETION_EVERY_MS));
  timers.push(setInterval(() => void inboundPass(), INBOUND_EVERY_MS));
  timers.push(setInterval(() => void folderSyncPass(), FOLDER_SYNC_EVERY_MS));
  timers.push(setInterval(() => void sortPass(), SORT_EVERY_MS));
  timers.push(setInterval(() => void draftPass(), DRAFT_EVERY_MS));
  if (config.docproc.serviceKey) {
    timers.push(setInterval(() => void ingestPass(), INGEST_EVERY_MS));
  } else {
    console.warn('[worker] DOCPROC_API_KEY is empty: file versions are not parsed');
  }
}
