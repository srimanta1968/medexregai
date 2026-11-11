import { dataService, Tx } from '../services/DataService';
import { ObjectNotFoundError, ObjectStore, objectStore, sha256Hex } from '../storage/objectStore';
import { DocLocation, DocprocClient, DocprocError, ParseResult } from './docproc';
import { chunkLocations, ChunkInput } from './chunker';
import { scanForInjection } from '../ai/guard/injectionSignals';
import { describeLocation, scanForPhi } from './phiScanner';

/**
 * F7.2 ingest step for one file version: read our copy, check it is the bytes we
 * recorded, parse it in the docproc sandbox, store its locations, then discard the
 * copy if it was fetched from a linked folder (ADR-010: registers, not repositories).
 *
 * Every function is idempotent so the job framework (F8.2) can retry freely:
 *  - a version is claimed by moving it queued -> parsing; a second worker finds nothing
 *  - locations are replaced, not appended, when a parse is repeated
 *  - discarding an already-discarded copy is a no-op
 */

export const MAX_PARSE_ATTEMPTS = 3;
/** A claim older than this is a dead worker's; the sweep returns it to the queue. */
export const STALE_PARSE_MINUTES = 15;
/** Linked copies older than this after processing are deleted by the sweep (crash recovery). */
export const DISCARD_GRACE_MINUTES = 10;

export type ProcessOutcome =
  | { status: 'parsed'; locations: number; needsOcr: boolean; phi: 'clean' | 'flagged'; discarded: boolean }
  | { status: 'failed' | 'unsupported'; reason: string; discarded: boolean }
  | { status: 'retry'; reason: string }
  | { status: 'skipped' };

export interface IngestDeps {
  store?: ObjectStore;
  docproc?: DocprocClient;
}

interface ClaimedVersion {
  id: string;
  file_id: string;
  workspace_id: string;
  project_id: string;
  version_no: number;
  sha256: string;
  storage_key: string | null;
  parse_attempts: number;
  source: 'upload' | 'linked' | 'request' | 'email';
  name: string;
}

/** Only fetched copies of linked files are discarded; uploads are the firm's evidence and stay. */
const DISCARDS_COPY = (source: string): boolean => source === 'linked';

async function claim(orgId: string, versionId: string): Promise<ClaimedVersion | null> {
  const rows = await dataService.query<ClaimedVersion>(
    { orgId },
    'file_versions',
    `UPDATE file_versions v
        SET parse_status = 'parsing', parse_started_at = now(), parse_attempts = v.parse_attempts + 1, parse_error = NULL
       FROM files f
      WHERE v.id = $1 AND v.org_id = $2 AND v.parse_status = 'queued' AND f.id = v.file_id AND f.org_id = v.org_id
      RETURNING v.id, v.file_id, v.workspace_id, f.project_id, v.version_no, v.sha256, v.storage_key, v.parse_attempts, f.source, f.name`,
    [versionId, orgId],
  );
  return rows[0] ?? null;
}

async function finishWithError(orgId: string, versionId: string, status: 'failed' | 'unsupported', reason: string): Promise<void> {
  await dataService.query(
    { orgId },
    'file_versions',
    `UPDATE file_versions SET parse_status = $3, parse_error = left($4, 500), parse_started_at = NULL
      WHERE id = $1 AND org_id = $2 AND parse_status = 'parsing'`,
    [versionId, orgId, status, reason],
  );
}

async function requeue(orgId: string, versionId: string, reason: string): Promise<void> {
  await dataService.query(
    { orgId },
    'file_versions',
    `UPDATE file_versions SET parse_status = 'queued', parse_error = left($3, 500), parse_started_at = NULL
      WHERE id = $1 AND org_id = $2 AND parse_status = 'parsing'`,
    [versionId, orgId, reason],
  );
}

const LOCATION_BATCH = 500;

/** Store a version's locations, replacing earlier ones; returns them with their new ids for chunking. */
async function storeLocations(tx: Tx, orgId: string, version: ClaimedVersion, locations: DocLocation[]): Promise<ChunkInput[]> {
  // Replace, so a repeated parse never duplicates passages (chunks cascade with their locations).
  await tx.query('chunks', 'DELETE FROM chunks WHERE file_version_id = $1 AND org_id = $2', [version.id, orgId]);
  await tx.query('source_locations', 'DELETE FROM source_locations WHERE file_version_id = $1 AND org_id = $2', [version.id, orgId]);
  const stored: ChunkInput[] = [];
  for (let i = 0; i < locations.length; i += LOCATION_BATCH) {
    const batch = locations.slice(i, i + LOCATION_BATCH);
    const rows = await tx.query<{ id: string; ordinal: number }>(
      'source_locations',
      `INSERT INTO source_locations (org_id, workspace_id, file_version_id, ordinal, kind, page, sheet, cell_range, slide, section_path, bbox, text)
       SELECT $1, $2, $3, l.ordinal, l.kind, l.page, l.sheet, l.cell_range, l.slide, l.section_path, l.bbox::real[], l.text
         FROM unnest($4::int[], $5::text[], $6::int[], $7::text[], $8::text[], $9::int[], $10::text[], $11::text[], $12::text[])
           AS l(ordinal, kind, page, sheet, cell_range, slide, section_path, bbox, text)
       RETURNING id, ordinal`,
      [
        orgId,
        version.workspace_id,
        version.id,
        batch.map((l) => l.ordinal),
        batch.map((l) => l.kind),
        batch.map((l) => l.page ?? null),
        batch.map((l) => l.sheet ?? null),
        batch.map((l) => l.cellRange ?? null),
        batch.map((l) => l.slide ?? null),
        batch.map((l) => l.sectionPath ?? null),
        batch.map((l) => (l.bbox ? `{${l.bbox.join(',')}}` : null)),
        batch.map((l) => l.text),
      ],
    );
    const byOrdinal = new Map(batch.map((l) => [l.ordinal, l]));
    for (const row of rows) {
      const l = byOrdinal.get(row.ordinal)!;
      stored.push({
        id: row.id,
        ordinal: l.ordinal,
        kind: l.kind,
        page: l.page ?? null,
        sheet: l.sheet ?? null,
        slide: l.slide ?? null,
        sectionPath: l.sectionPath ?? null,
        text: l.text,
      });
    }
  }
  return stored;
}

const CHUNK_BATCH = 500;

/** Chunk the stored locations (embeddings are filled in later by the embedding step). */
async function storeChunks(tx: Tx, orgId: string, version: ClaimedVersion, stored: ChunkInput[]): Promise<number> {
  const chunks = chunkLocations(stored);
  for (let i = 0; i < chunks.length; i += CHUNK_BATCH) {
    const batch = chunks.slice(i, i + CHUNK_BATCH);
    await tx.query(
      'chunks',
      `INSERT INTO chunks (org_id, workspace_id, project_id, file_version_id, ordinal, start_location_id, end_location_id, section_path, text, token_count)
       SELECT $1, $2, $3, $4, c.ordinal, c.start_id, c.end_id, c.section_path, c.text, c.tokens
         FROM unnest($5::int[], $6::uuid[], $7::uuid[], $8::text[], $9::text[], $10::int[])
           AS c(ordinal, start_id, end_id, section_path, text, tokens)`,
      [
        orgId,
        version.workspace_id,
        version.project_id,
        version.id,
        batch.map((c) => c.ordinal),
        batch.map((c) => c.startLocationId),
        batch.map((c) => c.endLocationId),
        batch.map((c) => c.sectionPath),
        batch.map((c) => c.text),
        batch.map((c) => c.tokenCount),
      ],
    );
  }
  return chunks.length;
}

async function recordParse(orgId: string, version: ClaimedVersion, result: ParseResult): Promise<'clean' | 'flagged'> {
  const note = result.needsOcr ? 'Some pages have no text layer and were not read (OCR not installed)' : null;
  // Scanned here, while we still hold the text, so a linked file is checked before its copy goes.
  const phi = scanForPhi(result.locations);
  // Text that reads like instructions to an AI: a warning for the reviewer, never a change in handling (F7.5).
  const injection = scanForInjection(result.locations.map((l) => ({ ordinal: l.ordinal, text: l.text, where: describeLocation(l) })));
  await dataService.transaction({ orgId }, async (tx) => {
    const stored = await storeLocations(tx, orgId, version, result.locations);
    await storeChunks(tx, orgId, version, stored);
    await tx.query(
      'file_versions',
      `UPDATE file_versions
          SET parse_status = 'parsed', parser = $3, unit_count = $4, ocr_used = $5, parse_error = $6,
              format = $7, mime_type = $8, parsed_at = now(), parse_started_at = NULL,
              -- A consultant's earlier decision (redacted / accepted) is kept on a re-parse.
              phi_status = CASE WHEN phi_status IN ('redacted', 'accepted') THEN phi_status ELSE $9 END,
              phi_findings = $10::jsonb, profile = $11::jsonb, injection_signals = $12::jsonb
        WHERE id = $1 AND org_id = $2`,
      [
        version.id,
        orgId,
        result.parser,
        result.unitCount,
        result.ocrUsed,
        note,
        result.format,
        result.mimeType,
        phi.status,
        JSON.stringify(phi.findings),
        result.profile ? JSON.stringify(result.profile) : null,
        JSON.stringify(injection.signals),
      ],
    );
    // A newer version becomes the file's current one; an older one parsed late never takes over.
    await tx.query(
      'files',
      `UPDATE files f SET current_version_id = $3, updated_at = now()
        WHERE f.id = $1 AND f.org_id = $2
          AND (f.current_version_id IS NULL
               OR (SELECT version_no FROM file_versions c WHERE c.id = f.current_version_id) < $4)`,
      [version.file_id, orgId, version.id, version.version_no],
    );
  });
  return phi.status;
}

/**
 * Delete our copy of a version's bytes; keep its SHA-256, size, text and locations.
 * Returns true when a copy was removed (false when there was none).
 */
export async function discardCopy(orgId: string, versionId: string, store: ObjectStore = objectStore()): Promise<boolean> {
  const [row] = await dataService.query<{ storage_key: string | null }>(
    { orgId },
    'file_versions',
    'SELECT storage_key FROM file_versions WHERE id = $1 AND org_id = $2',
    [versionId, orgId],
  );
  if (!row?.storage_key) return false;
  // Object first, row second: if the row update fails the sweep sees the key and deletes again (idempotent).
  await store.delete(row.storage_key);
  const updated = await dataService.query(
    { orgId },
    'file_versions',
    `UPDATE file_versions SET storage_key = NULL, discarded_at = now()
      WHERE id = $1 AND org_id = $2 AND storage_key = $3 RETURNING id`,
    [versionId, orgId, row.storage_key],
  );
  return updated.length === 1;
}

/** Parse one queued version. Safe to call twice or concurrently: only one call does the work. */
export async function processVersion(orgId: string, versionId: string, deps: IngestDeps = {}): Promise<ProcessOutcome> {
  const store = deps.store ?? objectStore();
  const docproc = deps.docproc ?? new DocprocClient();
  const version = await claim(orgId, versionId);
  if (!version) return { status: 'skipped' };

  const fail = async (status: 'failed' | 'unsupported', reason: string): Promise<ProcessOutcome> => {
    await finishWithError(orgId, version.id, status, reason);
    // A linked copy we cannot use is still a copy we should not keep.
    const discarded = DISCARDS_COPY(version.source) ? await discardCopy(orgId, version.id, store) : false;
    return { status, reason, discarded };
  };

  if (!version.storage_key) return fail('failed', 'No stored copy of this file version to read');
  let bytes: Buffer;
  try {
    bytes = await store.get(version.storage_key);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) return fail('failed', 'The stored copy of this file version is missing');
    if (version.parse_attempts >= MAX_PARSE_ATTEMPTS) return fail('failed', 'File storage was unavailable on every attempt');
    await requeue(orgId, version.id, 'File storage was unavailable');
    return { status: 'retry', reason: 'File storage was unavailable' };
  }
  if (sha256Hex(bytes) !== version.sha256) {
    return fail('failed', 'The stored copy does not match the SHA-256 recorded when the file arrived');
  }

  let result: ParseResult;
  try {
    result = await docproc.parse(bytes, version.name);
  } catch (err) {
    if (!(err instanceof DocprocError)) throw err;
    if (err.retryable && version.parse_attempts < MAX_PARSE_ATTEMPTS) {
      await requeue(orgId, version.id, err.message);
      return { status: 'retry', reason: err.message };
    }
    if (err.code === 'UNSUPPORTED_FORMAT') return fail('unsupported', err.message);
    // Platform faults (bad key, sidecar bug) are not the user's file: say so plainly.
    return fail('failed', err.fileProblem ? err.message : `Document parsing failed (${err.code}); an operator has been notified`);
  }
  if (result.sha256 !== version.sha256) {
    return fail('failed', 'The parser received different bytes than were recorded');
  }

  const phi = await recordParse(orgId, version, result);
  const discarded = DISCARDS_COPY(version.source) ? await discardCopy(orgId, version.id, store) : false;
  return { status: 'parsed', locations: result.locations.length, needsOcr: result.needsOcr, phi, discarded };
}

export interface SweepReport {
  orgs: number;
  requeued: number;
  gaveUp: number;
  discarded: number;
  errors: number;
}

/**
 * Housekeeping across all active firms (each under its own org context):
 *  - a claim older than STALE_PARSE_MINUTES goes back to the queue, or fails after MAX_PARSE_ATTEMPTS
 *  - a processed linked copy still held after DISCARD_GRACE_MINUTES is deleted
 */
export async function sweep(store: ObjectStore = objectStore()): Promise<SweepReport> {
  const report: SweepReport = { orgs: 0, requeued: 0, gaveUp: 0, discarded: 0, errors: 0 };
  const orgs = await dataService.query<{ id: string }>({}, 'orgs', "SELECT id FROM orgs WHERE status = 'active' ORDER BY id");
  for (const { id: orgId } of orgs) {
    report.orgs += 1;
    const stale = await dataService.query<{ id: string; gave_up: boolean }>(
      { orgId },
      'file_versions',
      `UPDATE file_versions
          SET parse_status = CASE WHEN parse_attempts >= $2 THEN 'failed' ELSE 'queued' END,
              parse_error = CASE WHEN parse_attempts >= $2 THEN 'Parsing did not finish after ' || $2 || ' attempts' ELSE parse_error END,
              parse_started_at = NULL
        WHERE org_id = $1 AND parse_status = 'parsing' AND parse_started_at < now() - make_interval(mins => $3)
        RETURNING id, parse_status = 'failed' AS gave_up`,
      [orgId, MAX_PARSE_ATTEMPTS, STALE_PARSE_MINUTES],
    );
    report.requeued += stale.filter((r) => !r.gave_up).length;
    report.gaveUp += stale.filter((r) => r.gave_up).length;

    const leftovers = await dataService.query<{ id: string }>(
      { orgId },
      'file_versions',
      `SELECT v.id FROM file_versions v JOIN files f ON f.id = v.file_id AND f.org_id = v.org_id
        WHERE v.org_id = $1 AND f.source = 'linked' AND v.storage_key IS NOT NULL
          AND v.parse_status IN ('parsed', 'failed', 'unsupported')
          AND coalesce(v.parsed_at, v.created_at) < now() - make_interval(mins => $2)
        ORDER BY v.created_at LIMIT 500`,
      [orgId, DISCARD_GRACE_MINUTES],
    );
    for (const { id } of leftovers) {
      try {
        if (await discardCopy(orgId, id, store)) report.discarded += 1;
      } catch (err) {
        report.errors += 1;
        console.error(`[ingest] sweep could not discard version ${id}: ${(err as Error).message}`);
      }
    }
  }
  return report;
}

/**
 * Interim dispatcher until the F8.2 job framework: process up to `perOrg` queued
 * versions for each active firm. Claims are atomic, so several workers may run it.
 */
export async function processQueued(perOrg = 5, deps: IngestDeps = {}): Promise<Record<ProcessOutcome['status'], number>> {
  const counts: Record<ProcessOutcome['status'], number> = { parsed: 0, failed: 0, unsupported: 0, retry: 0, skipped: 0 };
  const orgs = await dataService.query<{ id: string }>({}, 'orgs', "SELECT id FROM orgs WHERE status = 'active' ORDER BY id");
  for (const { id: orgId } of orgs) {
    const queued = await dataService.query<{ id: string }>(
      { orgId },
      'file_versions',
      "SELECT id FROM file_versions WHERE org_id = $1 AND parse_status = 'queued' ORDER BY created_at LIMIT $2",
      [orgId, perOrg],
    );
    for (const { id } of queued) {
      const outcome = await processVersion(orgId, id, deps);
      counts[outcome.status] += 1;
    }
  }
  return counts;
}

/**
 * File versions waiting for docproc or being parsed, across all active firms. The worker
 * publishes it as the metric the sandboxed docproc pool scales on (Terraform: docproc_queue).
 */
export async function queueDepth(): Promise<number> {
  const orgs = await dataService.query<{ id: string }>({}, 'orgs', "SELECT id FROM orgs WHERE status = 'active' ORDER BY id");
  let depth = 0;
  for (const { id: orgId } of orgs) {
    const [row] = await dataService.query<{ n: string }>(
      { orgId },
      'file_versions',
      "SELECT count(*) AS n FROM file_versions WHERE org_id = $1 AND parse_status IN ('queued', 'parsing')",
      [orgId],
    );
    depth += Number(row?.n ?? 0);
  }
  return depth;
}
