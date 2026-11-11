/**
 * Client for the sandboxed docproc sidecar (contract docproc/1, services/docproc).
 * fda-worker posts a cached 510(k) summary PDF and gets its passages back with page
 * locations. docproc never fetches anything and keeps nothing (F7.2 sandbox).
 * Mirrors server/src/ingest/docproc.ts; kept separate because fda-data shares no code
 * with the main app (ADR-017).
 */

export const DOCPROC_CONTRACT = 'docproc/1';

export interface DocLocation {
  ordinal: number;
  kind: string;
  page?: number;
  sectionPath?: string;
  text: string;
}

export interface ParseResult {
  contractVersion: string;
  sha256: string;
  unitCount: number;
  needsOcr: boolean;
  locations: DocLocation[];
  warnings: string[];
}

/** Codes docproc answers with, plus DOCPROC_UNAVAILABLE when it cannot be reached. */
export class DocprocError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DocprocError';
    this.retryable = code === 'DOCPROC_UNAVAILABLE' || code === 'PARSE_TIMEOUT' || code === 'INTERNAL_ERROR';
  }
}

export class DocprocClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | null,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  async parse(bytes: Buffer, fileName: string): Promise<ParseResult> {
    if (!this.apiKey) throw new DocprocError('DOCPROC_UNAVAILABLE', 'Document parsing is not configured (DOCPROC_API_KEY is empty)', 503);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}/v1/parse`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Docproc-Key': this.apiKey,
          'X-File-Name': encodeURIComponent(fileName.slice(0, 255)),
        },
        body: new Uint8Array(bytes),
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
      | { success: true; data: ParseResult }
      | { success: false; error: { code: string; message: string } }
      | null;
    if (!payload) throw new DocprocError('DOCPROC_UNAVAILABLE', `Document parsing answered ${response.status} without a JSON body`, 503);
    if (!payload.success) throw new DocprocError(payload.error.code, payload.error.message, response.status);
    if (payload.data.contractVersion !== DOCPROC_CONTRACT) {
      throw new DocprocError('INTERNAL_ERROR', `docproc speaks ${payload.data.contractVersion}, fda-data expects ${DOCPROC_CONTRACT}`, 502);
    }
    return payload.data;
  }
}
