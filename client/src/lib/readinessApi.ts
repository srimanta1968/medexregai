import { ApiRequest } from './api';

/** F3.4 readiness and records: server routes in server/src/routes/readiness.ts and records.ts. */

export interface CheckIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  basis: 'fda' | 'interpretation';
}

export interface AttachmentCheck {
  fileId: string;
  name: string;
  nameLength: number;
  extension: string | null;
  sizeBytes: number | null;
  sectionId: string;
  sectionTitle: string;
  runningTotalBytes: number;
  issues: CheckIssue[];
}

export interface Readiness {
  projectId: string;
  template: { key: string; label: string };
  rules: { maxNameChars: number; maxAttachmentBytes: number; maxTotalBytes: number; rejectedExtensions: string[]; source: { url: string; contentAsOf: string; readOn: string } };
  attachments: AttachmentCheck[];
  totalBytes: number;
  totalLimitBytes: number;
  totalPercent: number;
  counts: { attachments: number; errors: number; warnings: number };
  ready: boolean;
  checkedAt: string;
}

export interface EstarTemplate {
  key: string;
  label: string;
}

export type RecordKind = 'project_record' | 'problem_log' | 'request_log';
export type RecordFormat = 'pdf' | 'docx';

export interface RecordExport {
  id: string;
  kind: RecordKind;
  format: RecordFormat;
  sha256: string;
  sizeBytes: number;
  estarTemplate: string;
  createdBy: string | null;
  createdAt: string;
}

export const RECORD_LABEL: Record<RecordKind, string> = { project_record: 'Project record', problem_log: 'Problem log', request_log: 'Client request log' };

type Request = <T>(path: string, init?: Omit<ApiRequest, 'token'>) => Promise<T>;

/** Calls for a project's readiness checks and dated records. */
export function readinessApi(request: Request, projectId: string) {
  const p = encodeURIComponent(projectId);
  return {
    templates: () => request<EstarTemplate[]>('/api/estar-templates'),
    check: () => request<Readiness>(`/api/projects/${p}/readiness`),
    setTemplate: (template: string) => request<Readiness>(`/api/projects/${p}/estar-template`, { method: 'PUT', body: { template } }),
    record: (kind: RecordKind, format: RecordFormat) => request<Blob>(`/api/projects/${p}/records/${kind}?format=${format}`, { responseType: 'blob' }),
    history: () => request<RecordExport[]>(`/api/projects/${p}/records`),
  };
}

/** Bytes for people: "12 MB", "1.30 GB". */
export function formatBytes(b: number | null): string {
  if (b === null) return 'unknown';
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${Math.round(b / 1e3)} KB`;
  return `${b} bytes`;
}
