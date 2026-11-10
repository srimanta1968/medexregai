import { config } from '../config/env';

/**
 * Client for the docproc sidecar (services/docproc, contract docproc/1).
 *
 * The ingest worker fetches a file, posts its bytes here and stores the returned
 * locations in source_locations (migration 015). The sidecar never fetches anything
 * itself and keeps nothing. Types mirror services/docproc/docproc/contract.py.
 */

export const DOCPROC_CONTRACT = 'docproc/1';

export type DocFormat = 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'image' | 'csv';
export type LocationKind = 'page' | 'paragraph' | 'table' | 'cell' | 'slide' | 'region';

export interface DocLocation {
  ordinal: number;
  kind: LocationKind;
  page?: number;
  sheet?: string;
  /** e.g. "B5:F5" */
  cellRange?: string;
  slide?: number;
  /** Heading path, e.g. "5 Results > 5.2 Tensile" */
  sectionPath?: string;
  /** [x0, y0, x1, y1] in 0..1 page coordinates, top-left origin */
  bbox?: [number, number, number, number];
  text: string;
}

export interface ParseResult {
  contractVersion: string;
  sha256: string;
  sizeBytes: number;
  format: DocFormat;
  mimeType: string;
  parser: string;
  /** Pages (PDF, image), slides (PPTX), sheets (XLSX); 1 for DOCX and CSV. */
  unitCount: number;
  ocrUsed: boolean;
  /** Pages had no text layer and OCR is not installed in this docproc build. */
  needsOcr: boolean;
  locations: DocLocation[];
  warnings: string[];
  /** Raw-data column profile (XLSX/CSV) or drawing title block (PDF), when found. */
  profile?: RawDataProfile | DrawingProfile;
}

export interface RawDataColumn {
  column: string;
  name: string;
  unit: string | null;
  type: 'number' | 'date' | 'text' | 'empty';
  nonEmpty: number;
  min?: number;
  max?: number;
  mean?: number;
}

export interface RawDataProfile {
  kind: 'raw_data';
  sheets: { sheet: string; headerRow: number; rowCount: number; columns: RawDataColumn[] }[];
}

export interface DrawingProfile {
  kind: 'drawing';
  titleBlock: { partNumber?: string; drawingNumber?: string; revision?: string; title?: string; material?: string; page: number };
}

/** Codes docproc returns, plus DOCPROC_UNAVAILABLE when it cannot be reached. */
export type DocprocErrorCode =
  | 'UNSUPPORTED_FORMAT'
  | 'FILE_TOO_LARGE'
  | 'FILE_UNREADABLE'
  | 'ARCHIVE_LIMIT'
  | 'PARSE_TIMEOUT'
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'INTERNAL_ERROR'
  | 'DOCPROC_UNAVAILABLE';

/** Retrying the same bytes will not help for these: the file itself is the problem. */
const FILE_PROBLEMS: ReadonlySet<DocprocErrorCode> = new Set(['UNSUPPORTED_FORMAT', 'FILE_TOO_LARGE', 'FILE_UNREADABLE', 'ARCHIVE_LIMIT', 'VALIDATION_ERROR']);

export class DocprocError extends Error {
  readonly retryable: boolean;
  /** True when the message describes the user's file (show it); false for platform faults (log it). */
  readonly fileProblem: boolean;

  constructor(
    readonly code: DocprocErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DocprocError';
    this.fileProblem = FILE_PROBLEMS.has(code);
    // A timeout may pass on a less busy sidecar; a bad key or a sidecar bug needs us, not a retry.
    this.retryable = code === 'DOCPROC_UNAVAILABLE' || code === 'PARSE_TIMEOUT';
  }
}

export interface DocprocOptions {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class DocprocClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: DocprocOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? config.docproc.serviceUrl).replace(/\/+$/, '');
    this.apiKey = opts.apiKey ?? config.docproc.serviceKey;
    this.timeoutMs = opts.timeoutMs ?? config.docproc.timeoutMs;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Parse one file. The name only helps detect CSV; the format is read from the bytes. */
  async parse(bytes: Uint8Array, fileName: string): Promise<ParseResult> {
    if (!this.apiKey) throw new DocprocError('DOCPROC_UNAVAILABLE', 'Document parsing is not configured (DOCPROC_API_KEY is empty)', 503);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/parse`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Docproc-Key': this.apiKey,
          'X-File-Name': encodeURIComponent(fileName.slice(0, 255)),
        },
        body: bytes,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new DocprocError(
        timedOut ? 'PARSE_TIMEOUT' : 'DOCPROC_UNAVAILABLE',
        timedOut ? 'Document parsing timed out' : 'Document parsing service is unreachable',
        503,
      );
    }
    const payload = (await response.json().catch(() => null)) as
      { success: true; data: ParseResult } | { success: false; error: { code: DocprocErrorCode; message: string } } | null;
    if (!payload) throw new DocprocError('DOCPROC_UNAVAILABLE', `Document parsing answered ${response.status} without a JSON body`, 503);
    if (!payload.success) throw new DocprocError(payload.error.code, payload.error.message, response.status);
    if (payload.data.contractVersion !== DOCPROC_CONTRACT) {
      throw new DocprocError('INTERNAL_ERROR', `docproc speaks ${payload.data.contractVersion}, this app expects ${DOCPROC_CONTRACT}`, 502);
    }
    return payload.data;
  }

  /** Liveness and whether OCR (Docling) is installed. */
  async health(): Promise<{ ok: boolean; ocr: boolean }> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      const body = (await response.json()) as { status?: string; contractVersion?: string; ocr?: boolean };
      return { ok: response.ok && body.status === 'ok' && body.contractVersion === DOCPROC_CONTRACT, ocr: body.ocr === true };
    } catch {
      return { ok: false, ocr: false };
    }
  }
}
