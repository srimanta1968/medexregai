import { primaryPool } from '../db/pool';
import { FdaSyncService } from './FdaSyncService';
import { FdaDataset } from './records';

/**
 * Worker side of POST /v1/admin/syncs: claim the oldest queued request (SKIP LOCKED,
 * so several workers never take the same one), run it, record the outcome.
 * Returns false when nothing was queued.
 */
export async function runNextSyncRequest(sync: FdaSyncService): Promise<boolean> {
  const client = await primaryPool().connect();
  let claimed:
    | {
        id: string;
        dataset: FdaDataset;
        window_from: string | null;
        window_to: string | null;
      }
    | undefined;
  try {
    const { rows } = await client.query<{
      id: string;
      dataset: FdaDataset;
      window_from: string | null;
      window_to: string | null;
    }>(
      `UPDATE sync_requests SET status = 'running', picked_at = now()
        WHERE id = (SELECT id FROM sync_requests WHERE status = 'queued' ORDER BY requested_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id, dataset, window_from::text, window_to::text`,
    );
    claimed = rows[0];
  } finally {
    client.release();
  }
  if (!claimed) return false;
  let status: 'done' | 'failed' = 'failed';
  let runId: number | null = null;
  try {
    const r = await sync.run(claimed.dataset, {
      from: claimed.window_from ?? undefined,
      to: claimed.window_to ?? undefined,
    });
    status = r.status === 'succeeded' ? 'done' : 'failed';
    runId = r.runId ?? null;
    console.info(`[worker] sync request ${claimed.id} (${claimed.dataset}): ${r.status}, ${r.upserted} upserted${r.error ? ` (${r.error})` : ''}`);
  } catch (err) {
    console.error(`[worker] sync request ${claimed.id} crashed: ${(err as Error).message}`);
  }
  await primaryPool().query('UPDATE sync_requests SET status = $2, run_id = $3 WHERE id = $1', [claimed.id, status, runId]);
  return true;
}
