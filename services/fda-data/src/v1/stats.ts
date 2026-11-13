import { qRead } from '../db/pool';
import { Codes, ServiceError } from '../errors';
import { asOf, CLASSIFICATION_URL, DENOVO_URL, PMN_URL, RECALL_URL } from './lookups';

/**
 * Public statistics for one product code over the last N years (F6.1 public product-code pages),
 * computed only from FDA's own records in this database:
 *   - clearances decided in the window: count, per year, per clearance type, third-party reviews;
 *   - time from FDA receipt to decision in calendar days (median and quartiles). This is NOT FDA's
 *     "FDA days" review clock: it includes time the submission was on hold waiting for the sponsor;
 *   - the most recent clearances;
 *   - recall events initiated in the window (openFDA has one row per product; an event can cover
 *     many): count, how many have an FDA status of open, the most common root causes, the latest.
 * Every figure carries the dataset date it was computed from.
 */

const iso = (d: Date | string | null): string | null => (d === null ? null : typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));
const n = (v: string | number | null): number => (v === null ? 0 : Number(v));
const recallUrl = (cfresId: string | null): string | null => (cfresId ? RECALL_URL + encodeURIComponent(cfresId) : null);
const decisionUrl = (k: string): string => (k.startsWith('DEN') ? DENOVO_URL : PMN_URL) + encodeURIComponent(k);

export async function productCodeStats(code: string, years: number) {
  const to = new Date();
  const from = new Date(Date.UTC(to.getUTCFullYear() - years, to.getUTCMonth(), to.getUTCDate()));
  const range = [code, iso(from), iso(to)];

  const [cls, totals, byYear, byType, review, latest, recallTotals, causes, latestRecalls, dates] = await Promise.all([
    qRead<{ product_code: string; device_name: string | null; device_class: string | null; regulation_number: string | null }>(
      `SELECT product_code, device_name, device_class, regulation_number FROM fda_classification WHERE product_code = $1`,
      [code],
    ),
    qRead<{ total: string; third_party: string }>(
      `SELECT count(*) AS total, count(*) FILTER (WHERE third_party_flag = 'Y') AS third_party
         FROM fda_510k WHERE product_code = $1 AND decision_date BETWEEN $2 AND $3`,
      range,
    ),
    qRead<{ year: number; count: string }>(
      `SELECT extract(year FROM decision_date)::int AS year, count(*) AS count
         FROM fda_510k WHERE product_code = $1 AND decision_date BETWEEN $2 AND $3 GROUP BY 1 ORDER BY 1`,
      range,
    ),
    qRead<{ type: string | null; count: string }>(
      `SELECT clearance_type AS type, count(*) AS count
         FROM fda_510k WHERE product_code = $1 AND decision_date BETWEEN $2 AND $3 GROUP BY 1 ORDER BY 2 DESC, 1`,
      range,
    ),
    qRead<{ n: string; p25: number | null; median: number | null; p75: number | null }>(
      `SELECT count(*) AS n,
              percentile_cont(0.25) WITHIN GROUP (ORDER BY decision_date - date_received) AS p25,
              percentile_cont(0.5)  WITHIN GROUP (ORDER BY decision_date - date_received) AS median,
              percentile_cont(0.75) WITHIN GROUP (ORDER BY decision_date - date_received) AS p75
         FROM fda_510k
        WHERE product_code = $1 AND decision_date BETWEEN $2 AND $3
          AND date_received IS NOT NULL AND decision_date >= date_received`,
      range,
    ),
    qRead<{ k_number: string; applicant: string | null; device_name: string | null; decision_date: Date | null; clearance_type: string | null }>(
      `SELECT k_number, applicant, device_name, decision_date, clearance_type
         FROM fda_510k WHERE product_code = $1 AND decision_date BETWEEN $2 AND $3
        ORDER BY decision_date DESC, k_number DESC LIMIT 10`,
      range,
    ),
    // openFDA has one row per recalled product; one recall event (res_event_number) can cover many.
    qRead<{ events: string; products: string; open: string }>(
      `SELECT count(DISTINCT coalesce(res_event_number, product_res_number)) AS events, count(*) AS products,
              count(DISTINCT coalesce(res_event_number, product_res_number)) FILTER (WHERE recall_status ILIKE 'open%') AS open
         FROM fda_recall WHERE product_code_norm = $1 AND event_date_initiated BETWEEN $2 AND $3`,
      range,
    ),
    qRead<{ cause: string; count: string }>(
      `SELECT root_cause_description AS cause, count(DISTINCT coalesce(res_event_number, product_res_number)) AS count
         FROM fda_recall WHERE product_code_norm = $1 AND event_date_initiated BETWEEN $2 AND $3 AND root_cause_description IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 5`,
      range,
    ),
    qRead<{
      product_res_number: string;
      cfres_id: string | null;
      recall_status: string | null;
      event_date_initiated: Date | null;
      recalling_firm: string | null;
      reason_for_recall: string | null;
      root_cause_description: string | null;
    }>(
      `SELECT product_res_number, cfres_id, recall_status, event_date_initiated, recalling_firm, reason_for_recall, root_cause_description
         FROM fda_recall WHERE product_code_norm = $1 AND event_date_initiated BETWEEN $2 AND $3
        ORDER BY event_date_initiated DESC, product_res_number DESC LIMIT 5`,
      range,
    ),
    asOf(['classification', '510k', 'recall']),
  ]);

  const c = cls[0];
  if (!c) throw new ServiceError(404, Codes.NOT_FOUND, `Product code ${code} is not in our copy of the FDA classification database`);
  const r = review[0];
  const round = (v: number | null) => (v === null ? null : Math.round(v));
  return {
    productCode: c.product_code,
    deviceName: c.device_name,
    deviceClass: c.device_class,
    regulationNumber: c.regulation_number,
    window: { years, from: iso(from), to: iso(to) },
    clearances: {
      total: n(totals[0]?.total ?? 0),
      thirdPartyReviewed: n(totals[0]?.third_party ?? 0),
      byYear: byYear.map((y) => ({ year: y.year, count: n(y.count) })),
      byType: byType.map((t) => ({ type: t.type, count: n(t.count) })),
      receiptToDecisionDays: {
        basis: 'calendar days from FDA receipt to decision, including any time on hold; not FDA review days',
        n: n(r?.n ?? 0),
        p25: round(r?.p25 ?? null),
        median: round(r?.median ?? null),
        p75: round(r?.p75 ?? null),
      },
      latest: latest.map((x) => ({
        kNumber: x.k_number,
        applicant: x.applicant,
        deviceName: x.device_name,
        decisionDate: iso(x.decision_date),
        clearanceType: x.clearance_type,
        fdaUrl: decisionUrl(x.k_number),
      })),
    },
    recalls: {
      /** Recall events (FDA res_event_number); `products` counts the recalled product rows. */
      total: n(recallTotals[0]?.events ?? 0),
      products: n(recallTotals[0]?.products ?? 0),
      /** Events whose FDA recall status starts with "Open". */
      open: n(recallTotals[0]?.open ?? 0),
      topRootCauses: causes.map((x) => ({ cause: x.cause, count: n(x.count) })),
      latest: latestRecalls.map((x) => ({
        productResNumber: x.product_res_number,
        recallStatus: x.recall_status,
        dateInitiated: iso(x.event_date_initiated),
        recallingFirm: x.recalling_firm,
        reasonForRecall: x.reason_for_recall,
        rootCause: x.root_cause_description,
        fdaUrl: recallUrl(x.cfres_id),
      })),
    },
    sources: {
      classification: { dataAsOf: dates.classification ?? null, fdaUrl: CLASSIFICATION_URL + encodeURIComponent(c.product_code) },
      clearances: { dataAsOf: dates['510k'] ?? null, dataset: 'openFDA device/510k' },
      recalls: { dataAsOf: dates.recall ?? null, dataset: 'openFDA device/recall' },
    },
  };
}
