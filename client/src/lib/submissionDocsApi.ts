import { ApiRequest } from './api';

/** F3.6 summary tables and administrative documents: server routes in server/src/routes/submissionDocs.ts. */

export type ReportResult = 'pass' | 'fail' | 'not_stated';

export interface Mismatch {
  kind: 'EDITION' | 'RESULT' | 'OUTDATED';
  detail: string;
  section: string;
  statement: string;
}

export interface SummaryRow {
  fileId: string;
  report: string;
  versionNo: number;
  sectionId: string;
  section: string;
  standards: string[];
  acceptanceCriteria: string | null;
  result: ReportResult;
  mismatches: Mismatch[];
}

export interface SummaryTable {
  projectId: string;
  projectName: string;
  generatedAt: string;
  rows: SummaryRow[];
  reportCount: number;
  mismatchCount: number;
}

export type AdminDocKind = 'summary_510k' | 'cover_letter' | 'fda_3601' | 'truthful_accurate';
export const ADMIN_DOC_KINDS: AdminDocKind[] = ['summary_510k', 'cover_letter', 'fda_3601', 'truthful_accurate'];

export interface AdminDocSummary {
  title: string;
  openItems: string[];
  openItemCount: number;
  signatureFields: string[];
  signaturesBlank: boolean;
}

export interface AdminDocs {
  projectId: string;
  preparedOn: string;
  classification: { name: string | null; regulationNumber: string | null; deviceClass: string | null; panel: string | null } | null;
  predicateCount: number;
  docs: Record<AdminDocKind, AdminDocSummary>;
}

type Request = <T>(path: string, init?: Omit<ApiRequest, 'token'>) => Promise<T>;

/** Calls for a project's summary of testing and administrative documents. */
export function submissionDocsApi(request: Request, projectId: string) {
  const base = `/api/projects/${encodeURIComponent(projectId)}`;
  return {
    summaryTable: () => request<SummaryTable>(`${base}/summary-tables`),
    summaryTableXlsx: () => request<Blob>(`${base}/summary-tables/export`, { responseType: 'blob' }),
    adminDocs: () => request<AdminDocs>(`${base}/admin-docs`),
    adminDocDocx: (kind: AdminDocKind) => request<Blob>(`${base}/admin-docs/${kind}`, { responseType: 'blob' }),
  };
}
