import { qRead } from '../db/pool';
import { Codes, ServiceError } from '../errors';
import { FdaDataset } from '../sync/records';

/**
 * Read-only lookups over the FDA corpus in fda_db (F1.3, served by fda-data /v1, ADR-017). Every answer
 * carries the as-of date of the dataset it came from, and links to the FDA's
 * own public record so a consultant can check it at the source.
 */

const PMN_URL = 'https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfpmn/pmn.cfm?ID=';
const DENOVO_URL = 'https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfpmn/denovo.cfm?ID=';
const CLASSIFICATION_URL = 'https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfPCD/classification.cfm?ID=';
const RECALL_URL = 'https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfRES/res.cfm?id=';

const RECALL_LIMIT = 20;

const iso = (d: Date | string | null): string | null => (d === null ? null : typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));

/** openFDA's own last_updated date of the most recent successful load of each dataset. */
async function asOf(datasets: FdaDataset[]): Promise<Record<string, string | null>> {
  const rows = await qRead<{ dataset: string; as_of: string | null }>(
    `SELECT d.dataset,
            (SELECT source_last_updated::text FROM fda_sync_runs r
              WHERE r.dataset = d.dataset AND r.status = 'succeeded' AND r.source_last_updated IS NOT NULL
              ORDER BY r.source_last_updated DESC LIMIT 1) AS as_of
       FROM unnest($1::text[]) AS d(dataset)`,
    [datasets],
  );
  return Object.fromEntries(rows.map((r) => [r.dataset, r.as_of]));
}

interface ClearanceRow {
  k_number: string;
  applicant: string | null;
  device_name: string | null;
  product_code: string | null;
  decision_date: Date | null;
  decision_code: string | null;
  decision_description: string | null;
  clearance_type: string | null;
  date_received: Date | null;
  statement_or_summary: string | null;
  third_party_flag: string | null;
  device_class: string | null;
  regulation_number: string | null;
}

/** Summary PDF status (F1.2): null when the K-number has not been looked at yet. */
async function summaryDocument(kNumber: string) {
  const [d] = await qRead<{ status: string; reason: string | null; source_url: string | null; sha256: string | null; size_bytes: number | null; fetched_at: Date | null; checked_at: Date | null }>(
    `SELECT status, reason, source_url, sha256, size_bytes, fetched_at, checked_at FROM fda_510k_documents WHERE k_number = $1`,
    [kNumber],
  );
  if (!d) return null;
  return {
    /** queued | fetching | fetched | no_summary | failed ("no_summary" = no summary on file). */
    status: d.status,
    reason: d.reason,
    sourceUrl: d.source_url,
    sha256: d.sha256,
    sizeBytes: d.size_bytes,
    fetchedAt: d.fetched_at ? d.fetched_at.toISOString() : null,
    checkedAt: d.checked_at ? d.checked_at.toISOString() : null,
  };
}

async function clearance(kNumber: string): Promise<ClearanceRow> {
  const [row] = await qRead<ClearanceRow>(
    `SELECT k_number, applicant, device_name, product_code, decision_date, decision_code, decision_description,
            clearance_type, date_received, statement_or_summary, third_party_flag, device_class, regulation_number
       FROM fda_510k WHERE k_number = $1`,
    [kNumber],
  );
  if (!row) throw new ServiceError(404, Codes.NOT_FOUND, `${kNumber} is not in our copy of the FDA 510(k) database`);
  return row;
}

export const lookups = {
  /** Verify a K-number (or DEN number) against our copy of the FDA 510(k) database. */
  async verify510k(kNumber: string) {
    const [row, dates, summary] = await Promise.all([clearance(kNumber), asOf(['510k']), summaryDocument(kNumber)]);
    return {
      kNumber: row.k_number,
      verified: true,
      applicant: row.applicant,
      deviceName: row.device_name,
      productCode: row.product_code,
      deviceClass: row.device_class,
      regulationNumber: row.regulation_number,
      decisionCode: row.decision_code,
      decisionDescription: row.decision_description,
      decisionDate: iso(row.decision_date),
      dateReceived: iso(row.date_received),
      clearanceType: row.clearance_type,
      /** "Summary" or "Statement" as filed with the FDA. */
      statementOrSummary: row.statement_or_summary,
      thirdPartyReview: row.third_party_flag === 'Y',
      fdaUrl: (row.k_number.startsWith('DEN') ? DENOVO_URL : PMN_URL) + encodeURIComponent(row.k_number),
      /** Our cached copy of the public summary PDF (F1.2); null until the fetcher has seen this K-number. */
      summaryDocument: summary,
      dataAsOf: dates['510k'] ?? null,
    };
  },

  /** Device class and regulation number for a product code, plus how often it has been cleared. */
  async productCode(code: string) {
    const [rows, counts, dates] = await Promise.all([
      qRead<{
        product_code: string;
        device_name: string | null;
        device_class: string | null;
        regulation_number: string | null;
        medical_specialty: string | null;
        medical_specialty_description: string | null;
        review_panel: string | null;
        submission_type_id: string | null;
        implant_flag: string | null;
        life_sustain_support_flag: string | null;
        definition: string | null;
      }>(
        `SELECT product_code, device_name, device_class, regulation_number, medical_specialty, medical_specialty_description,
                review_panel, submission_type_id, implant_flag, life_sustain_support_flag, definition
           FROM fda_classification WHERE product_code = $1`,
        [code],
      ),
      qRead<{ cleared: string; latest: Date | null }>(`SELECT count(*) AS cleared, max(decision_date) AS latest FROM fda_510k WHERE product_code = $1`, [code]),
      asOf(['classification', '510k']),
    ]);
    const row = rows[0];
    if (!row) throw new ServiceError(404, Codes.NOT_FOUND, `Product code ${code} is not in our copy of the FDA classification database`);
    return {
      productCode: row.product_code,
      deviceName: row.device_name,
      deviceClass: row.device_class,
      regulationNumber: row.regulation_number,
      medicalSpecialty: row.medical_specialty,
      medicalSpecialtyDescription: row.medical_specialty_description,
      reviewPanel: row.review_panel,
      submissionTypeId: row.submission_type_id,
      implant: row.implant_flag === 'Y',
      lifeSustainSupport: row.life_sustain_support_flag === 'Y',
      definition: row.definition,
      clearances: { total: Number(counts[0]?.cleared ?? 0), latestDecisionDate: iso(counts[0]?.latest ?? null) },
      fdaUrl: CLASSIFICATION_URL + encodeURIComponent(row.product_code),
      dataAsOf: dates.classification ?? null,
      clearancesAsOf: dates['510k'] ?? null,
    };
  },

  /**
   * Recall and adverse-event (MAUDE) flags for a K-number. Recalls are those whose
   * FDA record names this K-number. MAUDE counts are reported by FDA per product
   * code, not per K-number, and our copy holds them only for tracked product codes,
   * so the answer says which one applies rather than implying "no events".
   */
  async flags(kNumber: string) {
    const row = await clearance(kNumber);
    const code = row.product_code;
    const [recalls, recallTotals, maude, dates] = await Promise.all([
      qRead<{
        product_res_number: string;
        cfres_id: string | null;
        recall_status: string | null;
        event_date_initiated: Date | null;
        event_date_posted: Date | null;
        event_date_terminated: Date | null;
        recalling_firm: string | null;
        reason_for_recall: string | null;
      }>(
        `SELECT product_res_number, cfres_id, recall_status, event_date_initiated, event_date_posted, event_date_terminated,
                recalling_firm, reason_for_recall
           FROM fda_recall WHERE k_numbers @> ARRAY[$1::text]
          ORDER BY event_date_initiated DESC NULLS LAST, product_res_number
          LIMIT ${RECALL_LIMIT}`,
        [kNumber],
      ),
      qRead<{ total: string; open: string }>(
        `SELECT count(*) AS total, count(*) FILTER (WHERE recall_status ILIKE 'open%') AS open
           FROM fda_recall WHERE k_numbers @> ARRAY[$1::text]`,
        [kNumber],
      ),
      code
        ? qRead<{ days: string; total: string | null; last12: string | null; first: Date | null; last: Date | null }>(
            `SELECT count(*) AS days, sum(report_count) AS total,
                    sum(report_count) FILTER (WHERE received_date > (SELECT max(received_date) FROM fda_event_counts WHERE product_code = $1) - interval '12 months') AS last12,
                    min(received_date) AS first, max(received_date) AS last
               FROM fda_event_counts WHERE product_code = $1`,
            [code],
          )
        : Promise.resolve([]),
      asOf(['recall', 'event_counts']),
    ]);
    const m = maude[0];
    const tracked = Boolean(m && Number(m.days) > 0);
    return {
      kNumber: row.k_number,
      productCode: code,
      recalls: {
        total: Number(recallTotals[0]?.total ?? 0),
        open: Number(recallTotals[0]?.open ?? 0),
        shown: recalls.length,
        items: recalls.map((r) => ({
          productResNumber: r.product_res_number,
          recallStatus: r.recall_status,
          dateInitiated: iso(r.event_date_initiated),
          datePosted: iso(r.event_date_posted),
          dateTerminated: iso(r.event_date_terminated),
          recallingFirm: r.recalling_firm,
          reasonForRecall: r.reason_for_recall,
          fdaUrl: r.cfres_id ? RECALL_URL + encodeURIComponent(r.cfres_id) : null,
        })),
        dataAsOf: dates.recall ?? null,
      },
      maude: {
        scope: 'product_code' as const,
        tracked,
        reportsLast12Months: tracked ? Number(m?.last12 ?? 0) : null,
        reportsInCopy: tracked ? Number(m?.total ?? 0) : null,
        firstReportDate: tracked ? iso(m?.first ?? null) : null,
        lastReportDate: tracked ? iso(m?.last ?? null) : null,
        note: tracked
          ? 'MAUDE counts are per product code, not per K-number, and include reports for every device with this code.'
          : 'MAUDE counts are not tracked for this product code yet.',
        dataAsOf: tracked ? (dates.event_counts ?? null) : null,
      },
    };
  },
};
