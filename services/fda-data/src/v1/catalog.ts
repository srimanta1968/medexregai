import { qRead } from '../db/pool';
import { Codes, ServiceError } from '../errors';
import { FdaDataset } from '../sync/records';

/**
 * fda-data /v1 queries beyond the F1.3 lookups: freshness, 510(k) search, recalls,
 * UDI and MAUDE day counts. Lists use keyset (cursor) pagination so deep pages
 * stay as fast as the first, and every query runs on the read pool.
 */

export const DATASETS: FdaDataset[] = ['classification', '510k', 'recall', 'udi', 'event_counts'];
const TABLES: Record<FdaDataset, string> = {
  '510k': 'fda_510k',
  classification: 'fda_classification',
  recall: 'fda_recall',
  udi: 'fda_udi',
  event_counts: 'fda_event_counts',
};

const iso = (d: Date | string | null): string | null => (d === null ? null : typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const encodeCursor = (v: unknown[]): string => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
function decodeCursor(c: string | undefined, arity: number): unknown[] | null {
  if (!c) return null;
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(v) && v.length === arity) return v;
  } catch {
    /* fall through */
  }
  throw new ServiceError(400, Codes.VALIDATION_ERROR, 'cursor is invalid');
}

/** Per-dataset freshness. dataAsOf is the OLDEST source date of loaded datasets, so callers never overstate freshness. */
export async function meta() {
  const runs = await qRead<{
    dataset: FdaDataset;
    source_last_updated: string | null;
    last_synced_at: Date | null;
    last_status: 'running' | 'succeeded' | 'failed' | null;
  }>(
    `SELECT d.dataset,
            (SELECT source_last_updated::text FROM fda_sync_runs r WHERE r.dataset = d.dataset AND r.status = 'succeeded'
               AND r.source_last_updated IS NOT NULL ORDER BY r.started_at DESC LIMIT 1) AS source_last_updated,
            (SELECT max(finished_at) FROM fda_sync_runs r WHERE r.dataset = d.dataset AND r.status = 'succeeded') AS last_synced_at,
            (SELECT status FROM fda_sync_runs r WHERE r.dataset = d.dataset ORDER BY r.started_at DESC LIMIT 1) AS last_status
       FROM unnest($1::text[]) AS d(dataset)`,
    [DATASETS],
  );
  const est = await qRead<{ relname: string; n: string }>(`SELECT relname, greatest(reltuples, 0)::bigint AS n FROM pg_class WHERE relname = ANY($1::text[])`, [
    Object.values(TABLES),
  ]);
  const estimate = new Map(est.map((e) => [e.relname, Number(e.n)]));
  const datasets = [];
  for (const r of runs) {
    let records = estimate.get(TABLES[r.dataset]) ?? 0;
    // Planner estimates are exact enough for large tables; count small ones.
    if (records < 100_000) records = Number((await qRead<{ n: string }>(`SELECT count(*) AS n FROM ${TABLES[r.dataset]}`))[0].n);
    datasets.push({
      dataset: r.dataset,
      sourceLastUpdated: r.source_last_updated,
      lastSyncedAt: r.last_synced_at ? r.last_synced_at.toISOString() : null,
      lastRunStatus: r.last_status,
      records,
    });
  }
  const loaded = datasets.filter((d) => d.sourceLastUpdated && d.records > 0).map((d) => d.sourceLastUpdated as string);
  return { dataAsOf: loaded.length ? loaded.sort()[0] : null, datasets };
}

export interface Search510kInput {
  productCode?: string;
  applicant?: string;
  q?: string;
  decidedFrom?: string;
  decidedTo?: string;
  limit: number;
  cursor?: string;
}

/** 510(k) search, newest decision first. applicant and q are case-insensitive substring matches (trigram-indexed). */
export async function search510k(input: Search510kInput): Promise<Page<Record<string, unknown>>> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (input.productCode) add('product_code = ?', input.productCode);
  if (input.applicant) add('applicant ILIKE ?', `%${input.applicant.replace(/[%_\\]/g, '\\$&')}%`);
  if (input.q) add('device_name ILIKE ?', `%${input.q.replace(/[%_\\]/g, '\\$&')}%`);
  if (input.decidedFrom) add('decision_date >= ?', input.decidedFrom);
  if (input.decidedTo) add('decision_date <= ?', input.decidedTo);
  const cur = decodeCursor(input.cursor, 2);
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(`(coalesce(decision_date, '0001-01-01'), k_number) < ($${params.length - 1}::date, $${params.length})`);
  }
  params.push(input.limit + 1);
  const rows = await qRead<{
    k_number: string;
    applicant: string | null;
    device_name: string | null;
    product_code: string | null;
    decision_date: Date | null;
    decision_description: string | null;
    clearance_type: string | null;
    statement_or_summary: string | null;
  }>(
    `SELECT k_number, applicant, device_name, product_code, decision_date, decision_description, clearance_type, statement_or_summary
       FROM fda_510k ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY coalesce(decision_date, '0001-01-01') DESC, k_number DESC
      LIMIT $${params.length}`,
    params,
  );
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      kNumber: r.k_number,
      applicant: r.applicant,
      deviceName: r.device_name,
      productCode: r.product_code,
      decisionDate: iso(r.decision_date),
      decisionDescription: r.decision_description,
      clearanceType: r.clearance_type,
      statementOrSummary: r.statement_or_summary,
    })),
    nextCursor: rows.length > input.limit && last ? encodeCursor([iso(last.decision_date) ?? '0001-01-01', last.k_number]) : null,
  };
}

/** Recalls naming a K-number, or recalls for a product code; most recently initiated first. */
export async function recalls(input: { kNumber?: string; productCode?: string; limit: number; cursor?: string }): Promise<Page<Record<string, unknown>>> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (input.kNumber) {
    params.push(input.kNumber);
    where.push(`k_numbers @> ARRAY[$${params.length}::text]`);
  }
  if (input.productCode) {
    params.push(input.productCode);
    where.push(`product_code_norm = $${params.length}`);
  }
  const cur = decodeCursor(input.cursor, 2);
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(`(coalesce(event_date_initiated, '0001-01-01'), product_res_number) < ($${params.length - 1}::date, $${params.length})`);
  }
  params.push(input.limit + 1);
  const rows = await qRead<{
    product_res_number: string;
    cfres_id: string | null;
    product_code_norm: string | null;
    k_numbers: string[];
    recall_status: string | null;
    event_date_initiated: Date | null;
    event_date_posted: Date | null;
    event_date_terminated: Date | null;
    recalling_firm: string | null;
    reason_for_recall: string | null;
  }>(
    `SELECT product_res_number, cfres_id, product_code_norm, k_numbers, recall_status, event_date_initiated, event_date_posted,
            event_date_terminated, recalling_firm, reason_for_recall
       FROM fda_recall WHERE ${where.join(' AND ')}
      ORDER BY coalesce(event_date_initiated, '0001-01-01') DESC, product_res_number DESC
      LIMIT $${params.length}`,
    params,
  );
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      productResNumber: r.product_res_number,
      productCode: r.product_code_norm,
      kNumbers: r.k_numbers,
      recallStatus: r.recall_status,
      dateInitiated: iso(r.event_date_initiated),
      datePosted: iso(r.event_date_posted),
      dateTerminated: iso(r.event_date_terminated),
      recallingFirm: r.recalling_firm,
      reasonForRecall: r.reason_for_recall,
      fdaUrl: r.cfres_id ? `https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfRES/res.cfm?id=${encodeURIComponent(r.cfres_id)}` : null,
    })),
    nextCursor: rows.length > input.limit && last ? encodeCursor([iso(last.event_date_initiated) ?? '0001-01-01', last.product_res_number]) : null,
  };
}

/** A device from the GUDID copy by its primary device identifier (UDI-DI). */
export async function udi(di: string) {
  const [r] = await qRead<{
    primary_di: string;
    brand_name: string | null;
    version_or_model_number: string | null;
    company_name: string | null;
    product_codes: string[];
    premarket_submissions: string[];
    commercial_distribution_status: string | null;
    public_version_date: Date | null;
  }>(
    `SELECT primary_di, brand_name, version_or_model_number, company_name, product_codes, premarket_submissions,
            commercial_distribution_status, public_version_date
       FROM fda_udi WHERE primary_di = $1 ORDER BY public_version_date DESC NULLS LAST LIMIT 1`,
    [di],
  );
  if (!r) throw new ServiceError(404, Codes.NOT_FOUND, `UDI-DI ${di} is not in our copy of the FDA GUDID data`);
  return {
    primaryDi: r.primary_di,
    brandName: r.brand_name,
    versionOrModelNumber: r.version_or_model_number,
    companyName: r.company_name,
    productCodes: r.product_codes,
    premarketSubmissions: r.premarket_submissions,
    commercialDistributionStatus: r.commercial_distribution_status,
    publicVersionDate: iso(r.public_version_date),
  };
}

/** MAUDE report counts per day for a product code in [from, to] (at most 3,660 days). */
export async function eventCounts(code: string, from: string, to: string) {
  if (from > to) throw new ServiceError(400, Codes.VALIDATION_ERROR, 'from must be on or before to');
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (days > 3660) throw new ServiceError(400, Codes.VALIDATION_ERROR, 'The date range may cover at most 3,660 days');
  const [tracked] = await qRead<{ tracked: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM tracked_product_codes WHERE product_code = $1) OR EXISTS (SELECT 1 FROM fda_event_counts WHERE product_code = $1) AS tracked`,
    [code],
  );
  const rows = await qRead<{ received_date: Date; report_count: number }>(
    `SELECT received_date, report_count FROM fda_event_counts WHERE product_code = $1 AND received_date BETWEEN $2 AND $3 ORDER BY received_date`,
    [code, from, to],
  );
  return {
    productCode: code,
    tracked: tracked.tracked,
    from,
    to,
    total: tracked.tracked ? rows.reduce((s, r) => s + r.report_count, 0) : null,
    days: rows.map((r) => ({ date: iso(r.received_date), reports: r.report_count })),
  };
}
