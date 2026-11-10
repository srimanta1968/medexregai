import { pushTrackedProductCodes } from './fda/fdaService';
import { closePool } from './services/DataService';

/**
 * Background worker (ECS service "worker", Terraform runs `node dist/worker.js`).
 * FDA data now lives in the fda-data service (ADR-017); this worker only keeps it
 * told which product codes our firms work with (at start and every 6 hours; device
 * changes also push within seconds from the API). The Postgres job queue for client
 * work (ADR-005) arrives with E2/E8 and will run here too.
 */

const PUSH_EVERY_MS = 6 * 60 * 60 * 1000;
let timer: NodeJS.Timeout | undefined;

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
  if (timer) clearInterval(timer);
  console.info(`[worker] ${signal}: stopping`);
  await closePool();
  process.exit(0);
}

if (require.main === module) {
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  void push('start');
  timer = setInterval(() => void push('schedule'), PUSH_EVERY_MS);
}
