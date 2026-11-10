import { NextFunction, Request, Response, Router } from 'express';
import { DATASETS } from '../fda/FdaSyncService';
import { authenticate } from '../middleware/authenticate';
import { dataService } from '../services/DataService';

export const fdaRouter = Router();

const TABLES: Record<string, string> = {
  '510k': 'fda_510k',
  classification: 'fda_classification',
  recall: 'fda_recall',
  udi: 'fda_udi',
  event_counts: 'fda_event_counts',
};

export interface FdaDatasetMeta {
  dataset: string;
  /** openFDA's own last_updated date for this dataset (what the UI calls "data as of"). */
  sourceLastUpdated: string | null;
  lastSyncedAt: string | null;
  lastRunStatus: 'running' | 'succeeded' | 'failed' | null;
  /** Approximate for large tables (planner statistics), exact when small. */
  records: number;
}

/**
 * FDA data freshness for every signed-in member: per dataset, the source date and
 * last sync; overall `dataAsOf` is the OLDEST source date across loaded datasets, so
 * the badge never overstates how current the copy is.
 */
fdaRouter.get('/api/fda/meta', authenticate, (_req: Request, res: Response, next: NextFunction): void => {
  (async () => {
    const runs = await dataService.query<{
      dataset: string;
      source_last_updated: string | null;
      last_synced_at: Date | null;
      last_status: FdaDatasetMeta['lastRunStatus'];
    }>(
      {},
      'fda_sync_runs',
      `SELECT d.dataset,
              (SELECT source_last_updated::text FROM fda_sync_runs r WHERE r.dataset = d.dataset AND r.status = 'succeeded'
                 AND r.source_last_updated IS NOT NULL ORDER BY r.started_at DESC LIMIT 1) AS source_last_updated,
              (SELECT max(finished_at) FROM fda_sync_runs r WHERE r.dataset = d.dataset AND r.status = 'succeeded') AS last_synced_at,
              (SELECT status FROM fda_sync_runs r WHERE r.dataset = d.dataset ORDER BY r.started_at DESC LIMIT 1) AS last_status
         FROM unnest($1::text[]) AS d(dataset)`,
      [DATASETS]
    );
    const counts = await dataService.query<{ relname: string; estimate: string }>(
      {},
      'fda_sync_runs',
      `SELECT c.relname, greatest(c.reltuples, 0)::bigint AS estimate FROM pg_class c WHERE c.relname = ANY($1::text[])`,
      [Object.values(TABLES)]
    );
    const estimate = new Map(counts.map((c) => [c.relname, Number(c.estimate)]));
    const datasets: FdaDatasetMeta[] = [];
    for (const r of runs) {
      const table = TABLES[r.dataset];
      let records = estimate.get(table) ?? 0;
      if (records < 100_000) {
        const [exact] = await dataService.query<{ n: string }>({}, table as 'fda_510k', `SELECT count(*) AS n FROM ${table}`, []);
        records = Number(exact.n);
      }
      datasets.push({
        dataset: r.dataset,
        sourceLastUpdated: r.source_last_updated,
        lastSyncedAt: r.last_synced_at ? new Date(r.last_synced_at).toISOString() : null,
        lastRunStatus: r.last_status,
        records,
      });
    }
    const loaded = datasets.filter((d) => d.sourceLastUpdated && d.records > 0).map((d) => d.sourceLastUpdated as string);
    res.status(200).json({ success: true, data: { dataAsOf: loaded.length ? loaded.sort()[0] : null, datasets } });
  })().catch(next);
});
