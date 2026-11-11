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
