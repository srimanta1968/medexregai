import { CatalogTable } from '../db/tableCatalog';
import { dataService } from '../services/DataService';

/** Datasets we keep a copy of. */
export type FdaDataset = '510k' | 'classification' | 'recall' | 'udi' | 'event_counts';

type Raw = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []);
const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});

/** openFDA dates come as YYYY-MM-DD or YYYYMMDD; anything else becomes null. */
export function fdaDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** A dataset's mapping from an openFDA record to our row, and how to upsert it. */
interface DatasetSpec {
  table: CatalogTable;
  key: string;
  columns: Record<string, string>;
  map: (r: Raw) => Record<string, unknown> | null;
}

export const SPECS: Record<Exclude<FdaDataset, 'event_counts'>, DatasetSpec> = {
  '510k': {
    table: 'fda_510k',
    key: 'k_number',
    columns: {
      k_number: 'varchar', applicant: 'text', device_name: 'text', product_code: 'varchar', decision_date: 'date', decision_code: 'varchar',
      decision_description: 'text', clearance_type: 'varchar', date_received: 'date', advisory_committee: 'varchar',
      review_advisory_committee: 'varchar', statement_or_summary: 'varchar', third_party_flag: 'varchar', expedited_review_flag: 'varchar',
      device_class: 'varchar', regulation_number: 'varchar', raw: 'jsonb',
    },
    map: (r) => {
      const k = str(r.k_number);
      if (!k) return null;
      const o = obj(r.openfda);
      return {
        k_number: k.toUpperCase(), applicant: str(r.applicant), device_name: str(r.device_name), product_code: str(r.product_code),
        decision_date: fdaDate(r.decision_date), decision_code: str(r.decision_code), decision_description: str(r.decision_description),
        clearance_type: str(r.clearance_type), date_received: fdaDate(r.date_received), advisory_committee: str(r.advisory_committee),
        review_advisory_committee: str(r.review_advisory_committee), statement_or_summary: str(r.statement_or_summary),
        third_party_flag: str(r.third_party_flag), expedited_review_flag: str(r.expedited_review_flag),
        device_class: str(o.device_class), regulation_number: str(o.regulation_number), raw: r,
      };
    },
  },
  classification: {
    table: 'fda_classification',
    key: 'product_code',
    columns: {
      product_code: 'varchar', device_name: 'text', device_class: 'varchar', regulation_number: 'varchar', medical_specialty: 'varchar',
      medical_specialty_description: 'text', review_panel: 'varchar', submission_type_id: 'varchar', implant_flag: 'varchar',
      life_sustain_support_flag: 'varchar', definition: 'text', raw: 'jsonb',
    },
    map: (r) => {
      const code = str(r.product_code);
      if (!code) return null;
      return {
        product_code: code.toUpperCase(), device_name: str(r.device_name), device_class: str(r.device_class), regulation_number: str(r.regulation_number),
        medical_specialty: str(r.medical_specialty), medical_specialty_description: str(r.medical_specialty_description), review_panel: str(r.review_panel),
        submission_type_id: str(r.submission_type_id), implant_flag: str(r.implant_flag), life_sustain_support_flag: str(r.life_sustain_support_flag),
        definition: str(r.definition), raw: r,
      };
    },
  },
  recall: {
    table: 'fda_recall',
    key: 'product_res_number',
    columns: {
      product_res_number: 'varchar', cfres_id: 'varchar', res_event_number: 'varchar', product_code: 'varchar', k_numbers: 'text[]',
      recall_status: 'varchar', event_date_initiated: 'date', event_date_posted: 'date', event_date_terminated: 'date', recalling_firm: 'text',
      reason_for_recall: 'text', root_cause_description: 'text', raw: 'jsonb',
    },
    map: (r) => {
      const id = str(r.product_res_number);
      if (!id) return null;
      return {
        product_res_number: id, cfres_id: str(r.cfres_id), res_event_number: str(r.res_event_number), product_code: str(r.product_code),
        k_numbers: strs(r.k_numbers).map((k) => k.toUpperCase()), recall_status: str(r.recall_status),
        event_date_initiated: fdaDate(r.event_date_initiated), event_date_posted: fdaDate(r.event_date_posted),
        event_date_terminated: fdaDate(r.event_date_terminated), recalling_firm: str(r.recalling_firm), reason_for_recall: str(r.reason_for_recall),
        root_cause_description: str(r.root_cause_description), raw: r,
      };
    },
  },
  udi: {
    table: 'fda_udi',
    key: 'public_device_record_key',
    columns: {
      public_device_record_key: 'uuid', primary_di: 'varchar', brand_name: 'text', version_or_model_number: 'text', company_name: 'text',
      product_codes: 'text[]', premarket_submissions: 'text[]', commercial_distribution_status: 'text', public_version_date: 'date', raw: 'jsonb',
    },
    map: (r) => {
      const key = str(r.public_device_record_key);
      if (!key || !/^[0-9a-f-]{36}$/i.test(key)) return null;
      const ids = Array.isArray(r.identifiers) ? (r.identifiers as Raw[]) : [];
      const primary = ids.find((i) => str(i.type) === 'Primary') ?? ids[0];
      const codes = Array.isArray(r.product_codes) ? (r.product_codes as Raw[]).map((c) => str(c.code)).filter((c): c is string => !!c) : [];
      const subs = Array.isArray(r.premarket_submissions)
        ? (r.premarket_submissions as Raw[]).map((s) => str(s.submission_number)).filter((s): s is string => !!s)
        : [];
      return {
        public_device_record_key: key, primary_di: primary ? str(primary.id) : null, brand_name: str(r.brand_name),
        version_or_model_number: str(r.version_or_model_number), company_name: str(r.company_name), product_codes: codes,
        premarket_submissions: subs, commercial_distribution_status: str(r.commercial_distribution_status),
        public_version_date: fdaDate(r.public_version_date), raw: r,
      };
    },
  },
};

/**
 * Upsert a batch in one statement: rows travel as one JSON array and are unpacked
 * by jsonb_to_recordset, so 1,000 records cost one round trip.
 */
export async function upsertBatch(dataset: Exclude<FdaDataset, 'event_counts'>, records: Raw[]): Promise<number> {
  const spec = SPECS[dataset];
  const byKey = new Map<string, Record<string, unknown>>();
  for (const r of records) {
    const row = spec.map(r);
    if (row) byKey.set(String(row[spec.key]), row); // last one wins within a batch
  }
  if (byKey.size === 0) return 0;
  const cols = Object.keys(spec.columns);
  const typed = cols.map((c) => `${c} ${spec.columns[c]}`).join(', ');
  const updates = cols.filter((c) => c !== spec.key).map((c) => `${c} = EXCLUDED.${c}`).join(', ');
  await dataService.query(
    {},
    spec.table,
    `INSERT INTO ${spec.table} (${cols.join(', ')})
     SELECT ${cols.join(', ')} FROM jsonb_to_recordset($1::jsonb) AS x(${typed})
     ON CONFLICT (${spec.key}) DO UPDATE SET ${updates}, synced_at = now()`,
    [JSON.stringify([...byKey.values()])]
  );
  return byKey.size;
}

/** Replace a product code's MAUDE daily counts with the latest openFDA counts. */
export async function upsertEventCounts(productCode: string, rows: { time?: string; count: number }[]): Promise<number> {
  const data = rows.map((r) => ({ received_date: fdaDate(r.time), report_count: r.count })).filter((r) => r.received_date);
  if (data.length === 0) return 0;
  await dataService.query(
    {},
    'fda_event_counts',
    `INSERT INTO fda_event_counts (product_code, received_date, report_count)
     SELECT $1, received_date, report_count FROM jsonb_to_recordset($2::jsonb) AS x(received_date date, report_count int)
     ON CONFLICT (product_code, received_date) DO UPDATE SET report_count = EXCLUDED.report_count, synced_at = now()`,
    [productCode.toUpperCase(), JSON.stringify(data)]
  );
  return data.length;
}
