import { config } from '../config/env';
import { dataService, getPool } from '../services/DataService';
import { OpenFdaClient } from './OpenFdaClient';
import { FdaDataset, upsertBatch, upsertEventCounts } from './records';

export const DATASETS: readonly FdaDataset[] = ['classification', '510k', 'recall', 'udi', 'event_counts'];

/** Endpoint and the date field a delta window filters on (null = full refresh). */
const DELTA: Record<Exclude<FdaDataset, 'event_counts'>, { path: string; dateField: string | null }> = {
  classification: { path: '/device/classification.json', dateField: null },
  '510k': { path: '/device/510k.json', dateField: 'decision_date' },
  recall: { path: '/device/recall.json', dateField: 'event_date_posted' },
  udi: { path: '/device/udi.json', dateField: 'public_version_date' },
};

/** openFDA republishes late corrections, so each delta re-reads this many days. */
const OVERLAP_DAYS = 7;

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const compact = (isoDate: string): string => isoDate.replace(/-/g, '');
const addDays = (isoDate: string, n: number): string => iso(new Date(Date.parse(isoDate) + n * 86_400_000));

export interface SyncResult {
  dataset: FdaDataset;
  status: 'succeeded' | 'failed' | 'skipped';
  upserted: number;
  windowFrom: string | null;
  windowTo: string | null;
  sourceLastUpdated: string | null;
  error?: string;
}

export class FdaSyncService {
  constructor(private readonly client = new OpenFdaClient({ apiKey: config.fda.apiKey, maxPerMinute: config.fda.maxPerMinute })) {}

  /** Start date of the next delta: last successful window end minus the overlap. */
  async deltaStart(dataset: FdaDataset): Promise<string> {
    const [row] = await dataService.query<{ window_to: string | null }>(
      {},
      'fda_sync_runs',
      `SELECT window_to::text AS window_to FROM fda_sync_runs
        WHERE dataset = $1 AND status = 'succeeded' AND window_to IS NOT NULL
        ORDER BY started_at DESC LIMIT 1`,
      [dataset]
    );
    const today = iso(new Date());
    return row?.window_to ? addDays(row.window_to, -OVERLAP_DAYS) : addDays(today, -config.fda.initialLookbackDays);
  }

  /** Run one dataset's delta under a per-dataset advisory lock (one runner at a time). */
  async run(dataset: FdaDataset, opts: { from?: string; to?: string } = {}): Promise<SyncResult> {
    const client = await getPool().connect();
    try {
      const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [`fda-sync:${dataset}`]);
      if (!rows[0].ok) {
        return { dataset, status: 'skipped', upserted: 0, windowFrom: null, windowTo: null, sourceLastUpdated: null, error: 'another sync is running' };
      }
      try {
        return await this.runLocked(dataset, opts);
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`fda-sync:${dataset}`]);
      }
    } finally {
      client.release();
    }
  }

  private async runLocked(dataset: FdaDataset, opts: { from?: string; to?: string }): Promise<SyncResult> {
    const windowTo = opts.to ?? iso(new Date());
    const windowFrom = dataset === 'classification' || dataset === 'event_counts' ? null : opts.from ?? (await this.deltaStart(dataset));
    const [run] = await dataService.query<{ id: string }>(
      {},
      'fda_sync_runs',
      `INSERT INTO fda_sync_runs (dataset, mode, window_from, window_to) VALUES ($1, 'delta', $2, $3) RETURNING id`,
      [dataset, windowFrom, windowTo]
    );
    let upserted = 0;
    let lastUpdated: string | null = null;
    try {
      if (dataset === 'event_counts') {
        for (const code of await this.eventProductCodes()) {
          const { meta, results } = await this.client.count('/device/event.json', {
            search: `device.device_report_product_code:${code}`,
            count: 'date_received',
          });
          lastUpdated = meta.last_updated ?? lastUpdated;
          upserted += await upsertEventCounts(code, results);
        }
      } else {
        const { path, dateField } = DELTA[dataset];
        const search = dateField && windowFrom ? `${dateField}:[${compact(windowFrom)} TO ${compact(windowTo)}]` : undefined;
        for await (const page of this.client.pages<Record<string, unknown>>(path, {
          search,
          sort: dateField ? `${dateField}:asc` : undefined,
          limit: 1000,
        })) {
          lastUpdated = page.meta.last_updated ?? lastUpdated;
          upserted += await upsertBatch(dataset, page.results);
        }
      }
      await dataService.query(
        {},
        'fda_sync_runs',
        `UPDATE fda_sync_runs SET status = 'succeeded', finished_at = now(), records_upserted = $2, source_last_updated = $3 WHERE id = $1`,
        [run.id, upserted, lastUpdated]
      );
      return { dataset, status: 'succeeded', upserted, windowFrom, windowTo, sourceLastUpdated: lastUpdated };
    } catch (err) {
      const message = (err as Error).message.slice(0, 1000);
      await dataService.query(
        {},
        'fda_sync_runs',
        `UPDATE fda_sync_runs SET status = 'failed', finished_at = now(), records_upserted = $2, error = $3 WHERE id = $1`,
        [run.id, upserted, message]
      );
      return { dataset, status: 'failed', upserted, windowFrom, windowTo, sourceLastUpdated: lastUpdated, error: message };
    }
  }

  /** MAUDE counts are kept for product codes our firms work with (plus FDA_EVENT_PRODUCT_CODES). */
  private async eventProductCodes(): Promise<string[]> {
    const rows = await dataService.query<{ product_code: string }>({}, 'fda_tracked_product_codes', 'SELECT product_code FROM fda_tracked_product_codes', []);
    const codes = new Set([...rows.map((r) => r.product_code), ...config.fda.eventProductCodes]);
    return [...codes].filter((c) => /^[A-Z]{3}$/.test(c)).sort();
  }

  async runAll(): Promise<SyncResult[]> {
    const out: SyncResult[] = [];
    for (const d of DATASETS) out.push(await this.run(d));
    return out;
  }
}
