/** Typed client for the FDA lookup API (server/src/routes/fda.ts, F1.3). */

type Request = <T>(path: string) => Promise<T>;

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
  /** Our copy of the public 510(k) summary PDF (F1.2); null until the FDA data service has looked at this K-number. */
  summaryDocument: SummaryDocument | null;
  dataAsOf: string | null;
}

/** "no_summary" = no summary on file: the FDA lists a statement, or publishes no summary PDF. */
export interface SummaryDocument {
  status: 'queued' | 'fetching' | 'fetched' | 'no_summary' | 'failed';
  reason: string | null;
  /** The FDA's own public PDF the copy was taken from. */
  sourceUrl: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  fetchedAt: string | null;
  checkedAt: string | null;
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

export const K_NUMBER = /^(K|DEN)\d{6}$/;
export const PRODUCT_CODE = /^[A-Z]{3}$/;

export const fdaApi = {
  clearance: (request: Request, k: string) => request<Clearance>(`/api/fda/510k/${encodeURIComponent(k)}`),
  productCode: (request: Request, code: string) => request<ProductCode>(`/api/fda/product-codes/${encodeURIComponent(code)}`),
  flags: (request: Request, k: string) => request<Flags>(`/api/fda/flags/${encodeURIComponent(k)}`),
};
