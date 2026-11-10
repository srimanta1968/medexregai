/** Typed client for project files (server/src/routes/files.ts, F7.2). */
import type { ApiRequest } from './api';

type Request = <T>(path: string, init?: Omit<ApiRequest, 'token'>) => Promise<T>;

export type ParseStatus = 'queued' | 'parsing' | 'parsed' | 'failed' | 'unsupported';
export type PhiStatus = 'not_scanned' | 'clean' | 'flagged' | 'redacted' | 'accepted';

export interface VersionSummary {
  id: string;
  versionNo: number;
  sha256: string;
  sizeBytes: number;
  format: string;
  parseStatus: ParseStatus;
  parseError: string | null;
  parser: string | null;
  unitCount: number | null;
  phiStatus: PhiStatus;
  phiFindingCount: number;
  copyKept: boolean;
  createdAt: string;
  parsedAt: string | null;
}

export interface FileSummary {
  id: string;
  projectId: string;
  name: string;
  source: 'upload' | 'linked' | 'request';
  sourceRef: string | null;
  versionCount: number;
  latest: VersionSummary | null;
  createdAt: string;
  updatedAt: string;
}

export interface PhiFinding {
  type: string;
  confidence: 'high' | 'low';
  ordinal: number;
  where: string;
  excerpt: string;
}

export interface RawDataProfile {
  kind: 'raw_data';
  sheets: {
    sheet: string;
    headerRow: number;
    rowCount: number;
    columns: { column: string; name: string; unit: string | null; type: string; min?: number; max?: number; mean?: number }[];
  }[];
}

export interface DrawingProfile {
  kind: 'drawing';
  titleBlock: { partNumber?: string; drawingNumber?: string; revision?: string; title?: string; material?: string; page: number };
}

export interface VersionDetail extends VersionSummary {
  locationCount: number;
  chunkCount: number;
  phiFindings: PhiFinding[];
  profile: RawDataProfile | DrawingProfile | null;
  discardedAt: string | null;
}

export interface FileDetail extends Omit<FileSummary, 'latest'> {
  currentVersionId: string | null;
  versions: VersionDetail[];
}

export const PARSE_LABELS: Record<ParseStatus, string> = {
  queued: 'Waiting to be read',
  parsing: 'Reading',
  parsed: 'Read',
  failed: 'Could not be read',
  unsupported: 'Not supported',
};

export const PHI_LABELS: Record<PhiStatus, string> = {
  not_scanned: 'Not checked yet',
  clean: 'No patient data found',
  flagged: 'Possible patient data',
  redacted: 'Marked redacted',
  accepted: 'Kept after review',
};

export const PHI_TYPE_LABELS: Record<string, string> = {
  ssn: 'Social Security number',
  mrn: 'Medical record number',
  date_of_birth: 'Date of birth',
  patient_name: 'Patient name',
  health_plan_id: 'Health plan or member ID',
  medicare_id: 'Medicare number',
  email: 'Email address',
  phone: 'Phone number',
};

/** "page 3", "sheet Tensile, A2:D2", "slide 4" -> where a unit count is a pages/slides/sheets count. */
export function unitLabel(format: string, count: number | null): string | null {
  if (count === null) return null;
  const word = format === 'pptx' ? 'slide' : format === 'xlsx' ? 'sheet' : format === 'pdf' || format === 'image' ? 'page' : null;
  return word ? `${count} ${word}${count === 1 ? '' : 's'}` : null;
}

export function filesApi(request: Request) {
  const id = encodeURIComponent;
  return {
    list: (projectId: string, cursor?: string) =>
      request<{ items: FileSummary[]; nextCursor: string | null }>(`/api/projects/${id(projectId)}/files?limit=50${cursor ? `&cursor=${id(cursor)}` : ''}`),
    detail: (fileId: string) => request<FileDetail>(`/api/files/${id(fileId)}`),
    /** Development upload (DEV_UPLOADS); answers UPLOADS_DISABLED where uploads go through connectors and presigned URLs. */
    upload: (projectId: string, file: File) =>
      request<FileSummary & { unchanged: boolean }>(`/api/projects/${id(projectId)}/files`, {
        method: 'POST',
        rawBody: file,
        headers: { 'X-File-Name': encodeURIComponent(file.name) },
      }),
    decidePhi: (versionId: string, decision: 'redacted' | 'accepted') =>
      request<{ id: string; phiStatus: PhiStatus }>(`/api/file-versions/${id(versionId)}/phi`, { method: 'PATCH', body: { decision } }),
  };
}
