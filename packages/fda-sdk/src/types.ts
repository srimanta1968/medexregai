/**
 * Response types of the fda-data /v1 API. They mirror services/fda-data/openapi.json
 * (the contract); keep them in step when the contract changes.
 */

export type FdaDataset = 'classification' | '510k' | 'recall' | 'udi' | 'event_counts';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Meta {
  /** Oldest source date across loaded datasets (never overstates freshness). */
  dataAsOf: string | null;
  datasets: {
    dataset: FdaDataset;
    sourceLastUpdated: string | null;
    lastSyncedAt: string | null;
    lastRunStatus: 'running' | 'succeeded' | 'failed' | null;
    records: number;
  }[];
}

export interface Clearance {
  kNumber: string;
  verified: true;
  applicant: string | null;
  deviceName: string | null;
  productCode: string | null;
  deviceClass: string | null;
  regulationNumber: string | null;
  decisionCode: string | null;
  decisionDescription: string | null;
  decisionDate: string | null;
  dateReceived: string | null;
  clearanceType: string | null;
  statementOrSummary: string | null;
  thirdPartyReview: boolean;
  fdaUrl: string;
  /** Our cached copy of the public 510(k) summary PDF (F1.2); null until the fetcher has seen this K-number. */
  summaryDocument: SummaryDocument | null;
  dataAsOf: string | null;
}

/** "no_summary" means no summary on file: the FDA lists a statement, or publishes no summary PDF. */
export type SummaryDocumentStatus = 'queued' | 'fetching' | 'fetched' | 'no_summary' | 'failed';

export interface SummaryDocument {
  status: SummaryDocumentStatus;
  reason: string | null;
  sourceUrl: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  fetchedAt: string | null;
  checkedAt: string | null;
}

export interface ClearanceSummary {
  kNumber: string;
  applicant: string | null;
  deviceName: string | null;
  productCode: string | null;
  decisionDate: string | null;
  decisionDescription: string | null;
  clearanceType: string | null;
  statementOrSummary: string | null;
}

export interface ProductCode {
  productCode: string;
  deviceName: string | null;
  deviceClass: string | null;
  regulationNumber: string | null;
  medicalSpecialty: string | null;
  medicalSpecialtyDescription: string | null;
  reviewPanel: string | null;
  submissionTypeId: string | null;
  implant: boolean;
  lifeSustainSupport: boolean;
  definition: string | null;
  clearances: { total: number; latestDecisionDate: string | null };
  fdaUrl: string;
  dataAsOf: string | null;
  clearancesAsOf: string | null;
}

/** GET /v1/product-codes/:code/stats: FDA data only, over a window of `years`. */
export interface ProductCodeStats {
  productCode: string;
  deviceName: string | null;
  deviceClass: string | null;
  regulationNumber: string | null;
  window: { years: number; from: string; to: string };
  clearances: {
    total: number;
    thirdPartyReviewed: number;
    byYear: { year: number; count: number }[];
    byType: { type: string | null; count: number }[];
    /** Calendar days from FDA receipt to decision, including time on hold; not FDA review days. */
    receiptToDecisionDays: { basis: string; n: number; p25: number | null; median: number | null; p75: number | null };
    latest: { kNumber: string; applicant: string | null; deviceName: string | null; decisionDate: string | null; clearanceType: string | null; fdaUrl: string }[];
  };
  recalls: {
    /** Recall events (FDA res_event_number); one event can cover many recalled products. */
    total: number;
    /** Recalled product rows. */
    products: number;
    /** Events whose FDA recall status starts with "Open". */
    open: number;
    topRootCauses: { cause: string; count: number }[];
    latest: {
      productResNumber: string;
      recallStatus: string | null;
      dateInitiated: string | null;
      recallingFirm: string | null;
      reasonForRecall: string | null;
      rootCause: string | null;
      fdaUrl: string | null;
    }[];
  };
  sources: {
    classification: { dataAsOf: string | null; fdaUrl: string };
    clearances: { dataAsOf: string | null; dataset: string };
    recalls: { dataAsOf: string | null; dataset: string };
  };
}

export interface Recall {
  productResNumber: string;
  productCode?: string | null;
  kNumbers?: string[];
  recallStatus: string | null;
  dateInitiated: string | null;
  datePosted: string | null;
  dateTerminated: string | null;
  recallingFirm: string | null;
  reasonForRecall: string | null;
  fdaUrl: string | null;
}

export interface Flags {
  kNumber: string;
  productCode: string | null;
  recalls: { total: number; open: number; shown: number; items: Recall[]; dataAsOf: string | null };
  maude: {
    scope: 'product_code';
    tracked: boolean;
    reportsLast12Months: number | null;
    reportsInCopy: number | null;
    firstReportDate: string | null;
    lastReportDate: string | null;
    note: string;
    dataAsOf: string | null;
  };
}

export interface UdiDevice {
  primaryDi: string;
  brandName: string | null;
  versionOrModelNumber: string | null;
  companyName: string | null;
  productCodes: string[];
  premarketSubmissions: string[];
  commercialDistributionStatus: string | null;
  publicVersionDate: string | null;
}

export interface EventCounts {
  productCode: string;
  tracked: boolean;
  from: string;
  to: string;
  total: number | null;
  days: { date: string; reports: number }[];
}

export interface Search510kParams {
  productCode?: string;
  applicant?: string;
  q?: string;
  decidedFrom?: string;
  decidedTo?: string;
  limit?: number;
  cursor?: string;
}

export interface RecallParams {
  kNumber?: string;
  productCode?: string;
  limit?: number;
  cursor?: string;
}

export interface TrackedCodesResult {
  /** Codes this client now tracks. */
  tracked: number;
  /** Codes no client tracked before. */
  added: number;
  /** A MAUDE count sync was queued for the new codes. */
  syncQueued: boolean;
}

/** One passage of a public 510(k) summary (F1.2). `ref` is what F7.3 cites as [R:<ref>]. */
export interface SummaryPassage {
  ref: string;
  kNumber: string;
  ordinal: number;
  page: number | null;
  sectionPath: string | null;
  text: string;
}

export interface SummaryPassages {
  kNumber: string;
  /** fetched | no_summary | queued | fetching | failed; null = not looked at yet. */
  summaryStatus: SummaryDocumentStatus | null;
  /** indexed | pending | indexing | needs_ocr | failed; null when there is no PDF. */
  indexStatus: 'pending' | 'indexing' | 'indexed' | 'needs_ocr' | 'failed' | null;
  reason: string | null;
  sourceUrl: string | null;
  pageCount: number | null;
  passageCount: number;
  indexedAt: string | null;
  embeddingModel: string | null;
  passages: SummaryPassage[];
  nextOffset: number | null;
}

export interface SearchSummariesParams {
  q: string;
  productCode?: string;
  kNumber?: string;
  limit?: number;
}

export interface SummarySearchHit extends SummaryPassage {
  score: number;
  keywordRank: number | null;
  semanticRank: number | null;
  applicant: string | null;
  deviceName: string | null;
  productCode: string | null;
  decisionDate: string | null;
  sourceUrl: string | null;
}

export interface SummarySearchResult {
  query: string;
  /** hybrid, or keyword when the embedding model is unavailable (see note). */
  mode: 'hybrid' | 'keyword';
  note: string | null;
  hits: SummarySearchHit[];
}
