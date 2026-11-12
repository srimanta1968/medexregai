import { ApiRequest } from './api';

/** F3.2 section drafts: server routes in server/src/routes/drafts.ts. */

export type DraftStatus = 'queued' | 'generating' | 'ready' | 'failed';

export interface DraftStatement {
  id: string;
  ordinal: number;
  paragraph: number;
  kind: 'heading' | 'statement';
  text: string;
  citations: { marker: string; label: string }[];
  warnings: string[];
  origin: 'generated' | 'human_edited' | 'human_added';
  humanApproved: boolean;
  approvedBy: string | null;
}

export interface DraftVersion {
  id: string;
  versionNo: number;
  origin: 'generated' | 'imported';
  status: DraftStatus;
  createdAt: string;
}

export interface Draft extends DraftVersion {
  sectionId: string;
  sectionTitle: string;
  basedOnVersion: number | null;
  model: string | null;
  error: string | null;
  createdBy: string | null;
  finishedAt: string | null;
  statements: DraftStatement[];
  removed: { text: string; code: string; reason: string }[];
  importSummary: { unchanged: number; edited: number; added: number; deleted: string[] } | null;
  /** F3.5: predicate K-numbers checked against FDA data; null until the draft is ready. */
  fdaCheck: DraftFdaCheck | null;
}

export type ReferenceStatus = 'verified' | 'not_found' | 'unavailable';

export interface ReferenceCheck {
  kNumber: string;
  status: ReferenceStatus;
  statementOrdinals: number[];
  clearance: {
    applicant: string | null;
    deviceName: string | null;
    productCode: string | null;
    decisionDate: string | null;
    decisionDescription: string | null;
    clearanceType: string | null;
    fdaUrl: string;
  } | null;
  flags: {
    recalls: { total: number; open: number; items: { productResNumber: string; recallStatus: string | null; dateInitiated: string | null; reasonForRecall: string | null; fdaUrl: string | null }[] };
    maude: { scope: 'product_code'; productCode: string | null; tracked: boolean; reportsLast12Months: number | null; note: string };
  } | null;
  notes: string[];
  dataAsOf: string | null;
  checkedAt: string;
}

export interface DraftFdaCheck {
  status: 'pending' | 'checking' | 'done' | 'failed';
  checkedAt: string | null;
  error: string | null;
  references: ReferenceCheck[];
  counts: { references: number; verified: number; notFound: number; unavailable: number; withRecalls: number };
}

type Request = <T>(path: string, init?: Omit<ApiRequest, 'token'>) => Promise<T>;

/** Calls for one section's drafts. */
export function draftsApi(request: Request, projectSectionId: string) {
  const base = `/api/project-sections/${encodeURIComponent(projectSectionId)}/draft`;
  return {
    current: (version?: number) => request<{ draft: Draft | null; versions: DraftVersion[] }>(version ? `${base}?version=${version}` : base),
    request: () => request<Draft>(base, { method: 'POST', body: {} }),
    exportDocx: (version?: number) => request<Blob>(version ? `${base}/export?version=${version}` : `${base}/export`, { responseType: 'blob' }),
    recheckFda: (version?: number) => request<Draft>(version ? `${base}/fda-check?version=${version}` : `${base}/fda-check`, { method: 'POST', body: {} }),
    importDocx: (fileName: string, contentBase64: string) => request<Draft>(`${base}/import`, { method: 'POST', body: { fileName, contentBase64 } }),
  };
}

/** A file's bytes as base64, for JSON upload bodies. */
export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
