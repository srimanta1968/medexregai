import { apiRequest } from './api';

/** F6.1 public product-code pages: server routes in server/src/routes/publicCodes.ts (no sign-in). */

export interface CodeStats {
  window: { years: number; from: string; to: string };
  clearances: {
    total: number;
    thirdPartyReviewed: number;
    byYear: { year: number; count: number }[];
    byType: { type: string | null; count: number }[];
    receiptToDecisionDays: { basis: string; n: number; p25: number | null; median: number | null; p75: number | null };
    latest: { kNumber: string; applicant: string | null; deviceName: string | null; decisionDate: string | null; clearanceType: string | null; fdaUrl: string }[];
  };
  recalls: {
    /** Recall events; one event can cover many recalled products. */
    total: number;
    products: number;
    open: number;
    topRootCauses: { cause: string; count: number }[];
    latest: { productResNumber: string; recallStatus: string | null; dateInitiated: string | null; recallingFirm: string | null; reasonForRecall: string | null; rootCause: string | null; fdaUrl: string | null }[];
  };
  sources: {
    classification: { dataAsOf: string | null; fdaUrl: string };
    clearances: { dataAsOf: string | null; dataset: string };
    recalls: { dataAsOf: string | null; dataset: string };
  };
}

export interface CodePage {
  productCode: string;
  deviceName: string | null;
  deviceClass: string | null;
  classLabel: string | null;
  regulationNumber: string | null;
  medicalSpecialty: string | null;
  pathway: { label: string; note: string } | null;
  implant: boolean;
  lifeSustainSupport: boolean;
  definition: string | null;
  clearancesAllTime: number;
  stats: CodeStats;
}

export interface CheckResult {
  checkId: string;
  productCode: string;
  deviceName: string | null;
  classLabel: string | null;
  regulationNumber: string | null;
  pathway: { label: string; note: string } | null;
  similarClearances: { kNumber: string; deviceName: string | null; applicant: string | null; decisionDate: string | null; match: 'high' | 'medium' | 'low'; fdaUrl: string }[];
  recalls: { total: number; open: number; topRootCauses: { cause: string; count: number }[] };
  receiptToDecisionDays: CodeStats['clearances']['receiptToDecisionDays'];
  window: CodeStats['window'];
  sources: CodeStats['sources'];
  contacted: boolean;
}

export const publicCodesApi = {
  page: (code: string) => apiRequest<CodePage>(`/api/public/product-codes/${encodeURIComponent(code)}`),
  check: (body: { productCode: string; description: string; contactConsent: boolean; email?: string; website?: string }) =>
    apiRequest<CheckResult>('/api/public/device-checks', { method: 'POST', body }),
};
