import { randomUUID } from 'crypto';
import { dataService, Tx } from '../services/DataService';
import { ObjectStore, objectStore, sha256Hex, versionObjectKey } from '../storage/objectStore';
import { AppError, ErrorCodes } from '../utils/AppError';
import { decodeCursor, Page, toPage } from '../utils/pagination';
import { UNREADABLE_ADVICE, UNREADABLE_LABEL, UnreadableKind } from './unreadable';

/**
 * Project files and their versions (F7.2). recordVersion is the single intake path:
 * the development upload route uses it now, F8.2's presigned-upload confirmation and
 * the E2 folder connectors will call it later. A file keeps its identity across
 * versions; sending the same bytes again adds nothing.
 */

export type FileSource = 'upload' | 'linked' | 'request' | 'email';

export interface VersionSummary {
  id: string;
  versionNo: number;
  sha256: string;
  sizeBytes: number;
  format: string;
  parseStatus: 'queued' | 'parsing' | 'parsed' | 'failed' | 'unsupported';
  parseError: string | null;
  parser: string | null;
  unitCount: number | null;
  phiStatus: 'not_scanned' | 'clean' | 'flagged' | 'redacted' | 'accepted';
  phiFindingCount: number;
  /** Places where the text reads like instructions to an AI (F7.5): treated as data like everything else. */
  injectionSignalCount: number;
  copyKept: boolean;
  createdAt: string;
  parsedAt: string | null;
}

export interface FileSummary {
  id: string;
  projectId: string;
  name: string;
  source: FileSource;
  sourceRef: string | null;
  versionCount: number;
  latest: VersionSummary | null;
  createdAt: string;
  updatedAt: string;
}

export interface VersionDetail extends VersionSummary {
  locationCount: number;
  chunkCount: number;
  phiFindings: unknown[];
  injectionSignals: unknown[];
  profile: unknown;
  discardedAt: string | null;
}

export interface FileDetail extends Omit<FileSummary, 'latest'> {
  currentVersionId: string | null;
  versions: VersionDetail[];
}

interface VersionRow {
  id: string;
  version_no: number;
  sha256: string;
  size_bytes: string;
  format: string;
  parse_status: VersionSummary['parseStatus'];
  parse_error: string | null;
  parser: string | null;
  unit_count: number | null;
  phi_status: VersionSummary['phiStatus'];
  phi_count: number;
  injection_count: number;
  has_copy: boolean;
  created_at: Date;
  parsed_at: Date | null;
}

const VERSION_COLUMNS = `v.id, v.version_no, v.sha256, v.size_bytes, v.format, v.parse_status, v.parse_error, v.parser, v.unit_count,
  v.phi_status, jsonb_array_length(v.phi_findings)::int AS phi_count,
  jsonb_array_length(v.injection_signals)::int AS injection_count, v.storage_key IS NOT NULL AS has_copy, v.created_at, v.parsed_at`;

function toVersion(r: VersionRow): VersionSummary {
  return {
    id: r.id,
    versionNo: r.version_no,
    sha256: r.sha256,
    sizeBytes: Number(r.size_bytes),
    format: r.format,
    parseStatus: r.parse_status,
    parseError: r.parse_error,
    parser: r.parser,
    unitCount: r.unit_count,
    phiStatus: r.phi_status,
    phiFindingCount: r.phi_count,
    injectionSignalCount: r.injection_count,
    copyKept: r.has_copy,
    createdAt: r.created_at.toISOString(),
    parsedAt: r.parsed_at ? r.parsed_at.toISOString() : null,
  };
}

const EXTENSION_FORMAT: Record<string, string> = {
  docx: 'docx',
  xlsx: 'xlsx',
  pptx: 'pptx',
  pdf: 'pdf',
  csv: 'csv',
  tsv: 'csv',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  tif: 'image',
  tiff: 'image',
};

/** Until docproc reads the bytes, the extension is only a hint (the parser decides from content). */
function formatHint(name: string): string {
  return EXTENSION_FORMAT[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'other';
}

/** A display file name: no path, no control characters. */
export function cleanFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const name = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name || name === '.' || name === '..')
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'A file name is required', [{ field: 'fileName', message: 'A file name is required' }]);
  if (name.length > 255)
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'The file name must be at most 255 characters', [
      { field: 'fileName', message: 'At most 255 characters' },
    ]);
  return name;
}

export interface PassageView {
  fileId: string;
  projectId: string;
  fileName: string;
  versionId: string;
  versionNo: number;
  format: string;
  /** False when a newer version of the file has been read since. */
  current: boolean;
  currentVersionNo: number | null;
  copyKept: boolean;
  /** The cited passages (cited=true) with one passage of context before and after. */
  passages: { ordinal: number; kind: string; cited: boolean; where: string; sectionPath: string | null; text: string }[];
}

export interface RecordInput {
  orgId: string;
  userId: string;
  projectId: string;
  source: FileSource;
  /** Provider path for linked files; null for uploads (matched by name). */
  sourceRef?: string | null;
  name: string;
  mimeType?: string;
  bytes: Buffer;
  /** Malware scan result of these bytes (F2.4); uploads are scanned before they are recorded. */
  scanStatus?: 'clean' | 'not_scanned';
  /** Linked folders (F2.1): the link the file came through, its provider hash and path inside the folder. */
  folderLinkId?: string;
  sourceHash?: string | null;
  sourcePath?: string | null;
}

export interface UnreadableFile {
  id: string;
  name: string;
  source: FileSource;
  /** Path inside the linked folder, for linked files. */
  path: string | null;
  kind: UnreadableKind | null;
  label: string;
  reason: string;
  advice: string;
  /** Seen in a linked folder but not fetched: there is no version. */
  listedOnly: boolean;
  versionNo: number | null;
}

export interface RecordResult {
  file: FileSummary;
  /** True when these exact bytes are already the file's latest version: nothing was added. */
  unchanged: boolean;
}

export class FileService {
  constructor(private readonly store: () => ObjectStore = objectStore) {}

  async recordVersion(input: RecordInput): Promise<RecordResult> {
    const { orgId, userId, projectId, source } = input;
    const name = cleanFileName(input.name);
    const sha = sha256Hex(input.bytes);
    const result = await dataService.transaction({ orgId, userId }, async (tx) => {
      const [project] = await tx.query<{ workspace_id: string }>('projects', 'SELECT workspace_id FROM projects WHERE id = $1 AND org_id = $2', [
        projectId,
        orgId,
      ]);
      if (!project) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');

      // Lock the logical file so two uploads of the same name cannot take the same version number.
      const [existing] = input.sourceRef
        ? await tx.query<{ id: string; version_count: number }>(
            'files',
            'SELECT id, version_count FROM files WHERE project_id = $1 AND org_id = $2 AND source_ref = $3 FOR UPDATE',
            [projectId, orgId, input.sourceRef],
          )
        : await tx.query<{ id: string; version_count: number }>(
            'files',
            "SELECT id, version_count FROM files WHERE project_id = $1 AND org_id = $2 AND source_ref IS NULL AND status = 'active' AND lower(name) = lower($3) FOR UPDATE",
            [projectId, orgId, name],
          );
      if (existing) {
        const [latest] = await tx.query<{ sha256: string }>(
          'file_versions',
          'SELECT sha256 FROM file_versions WHERE file_id = $1 AND org_id = $2 ORDER BY version_no DESC LIMIT 1',
          [existing.id, orgId],
        );
        if (latest?.sha256 === sha) {
          if (input.sourceRef) await this.touchLinked(tx, orgId, existing.id, input);
          return { fileId: existing.id, unchanged: true };
        }
      }

      const fileId = existing?.id ?? randomUUID();
      const versionNo = (existing?.version_count ?? 0) + 1;
      const key = versionObjectKey(orgId, fileId, versionNo, sha);
      // Bytes first: a version row never points at an object that was not written.
      // If the transaction then fails, the orphan object is harmless and overwritten on retry.
      await this.store().put(key, input.bytes);
      if (existing) {
        await tx.query('files', 'UPDATE files SET version_count = $3, updated_at = now() WHERE id = $1 AND org_id = $2', [fileId, orgId, versionNo]);
        if (input.sourceRef) await this.touchLinked(tx, orgId, fileId, input);
      } else {
        await tx.query(
          'files',
          `INSERT INTO files (id, org_id, workspace_id, project_id, source, source_ref, name, version_count, created_by, folder_link_id, source_hash, source_path)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, $10, $11)`,
          [
            fileId,
            orgId,
            project.workspace_id,
            projectId,
            source,
            input.sourceRef ?? null,
            name,
            userId,
            input.folderLinkId ?? null,
            input.sourceHash ?? null,
            input.sourcePath?.slice(0, 1024) ?? null,
          ],
        );
      }
      await tx.query(
        'file_versions',
        `INSERT INTO file_versions (org_id, workspace_id, file_id, version_no, sha256, size_bytes, mime_type, format, storage_key, uploaded_by, scan_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          orgId,
          project.workspace_id,
          fileId,
          versionNo,
          sha,
          input.bytes.length,
          (input.mimeType || 'application/octet-stream').slice(0, 127),
          formatHint(name),
          key,
          userId,
          input.scanStatus ?? 'not_scanned',
        ],
      );
      return { fileId, unchanged: false };
    });
    const file = await this.getSummary(orgId, result.fileId);
    return { file, unchanged: result.unchanged };
  }

  /**
   * A linked file we did not fetch (native CAD, a type we do not read, too large):
   * recorded with no versions so it is listed, with the reason, instead of skipped.
   */
  async recordListedOnly(input: {
    orgId: string;
    userId: string;
    projectId: string;
    sourceRef: string;
    name: string;
    folderLinkId: string;
    sourceHash: string | null;
    sourcePath: string | null;
    kind: UnreadableKind;
    reason: string;
  }): Promise<void> {
    const { orgId, projectId } = input;
    await dataService.transaction({ orgId, userId: input.userId }, async (tx) => {
      const [project] = await tx.query<{ workspace_id: string }>('projects', 'SELECT workspace_id FROM projects WHERE id = $1 AND org_id = $2', [projectId, orgId]);
      if (!project) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
      await tx.query(
        'files',
        `INSERT INTO files (org_id, workspace_id, project_id, source, source_ref, name, version_count, created_by, folder_link_id, source_hash, source_path,
                            unreadable_kind, unreadable_reason)
         VALUES ($1, $2, $3, 'linked', $4, $5, 0, $6, $7, $8, $9, $10, left($11, 500))
         ON CONFLICT (project_id, source_ref) WHERE source_ref IS NOT NULL DO UPDATE
           SET name = EXCLUDED.name, status = 'active', folder_link_id = EXCLUDED.folder_link_id, source_hash = EXCLUDED.source_hash,
               source_path = EXCLUDED.source_path, unreadable_kind = EXCLUDED.unreadable_kind, unreadable_reason = EXCLUDED.unreadable_reason, updated_at = now()`,
        [
          orgId,
          project.workspace_id,
          projectId,
          input.sourceRef,
          cleanFileName(input.name),
          input.userId,
          input.folderLinkId,
          input.sourceHash,
          input.sourcePath?.slice(0, 1024) ?? null,
          input.kind,
          input.reason,
        ],
      );
    });
  }

  /**
   * Files of a project that could not be read, with the reason: listed-only linked
   * files, and files whose latest version failed, is unsupported, or had no text.
   */
  async unreadable(orgId: string, projectId: string, size: number, cursor?: string): Promise<Page<UnreadableFile>> {
    const c = decodeCursor(cursor);
    const [project] = await dataService.query<{ id: string }>({ orgId }, 'projects', 'SELECT id FROM projects WHERE id = $1 AND org_id = $2', [projectId, orgId]);
    if (!project) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
    const rows = await dataService.query<{
      id: string;
      name: string;
      source: FileSource;
      source_path: string | null;
      kind: UnreadableKind | null;
      reason: string | null;
      version_no: number | null;
      created_at: Date;
    }>(
      { orgId },
      'files',
      `SELECT f.id, f.name, f.source, f.source_path, f.created_at,
              COALESCE(f.unreadable_kind, v.unreadable_kind) AS kind,
              COALESCE(f.unreadable_reason, v.parse_error) AS reason,
              v.version_no
         FROM files f
         LEFT JOIN LATERAL (SELECT version_no, unreadable_kind, parse_status, parse_error FROM file_versions
                             WHERE file_id = f.id AND org_id = f.org_id ORDER BY version_no DESC LIMIT 1) v ON true
        WHERE f.org_id = $1 AND f.project_id = $2 AND f.status = 'active'
          AND (f.unreadable_kind IS NOT NULL OR v.unreadable_kind IS NOT NULL OR v.parse_status IN ('failed', 'unsupported'))
          AND ($3::timestamptz IS NULL OR (f.created_at, f.id) < ($3::timestamptz, $4::uuid))
        ORDER BY f.created_at DESC, f.id DESC
        LIMIT $5`,
      [orgId, projectId, c.createdAt, c.id, size + 1],
    );
    return toPage(rows, size, (r) => ({
      id: r.id,
      name: r.name,
      source: r.source,
      path: r.source_path,
      kind: r.kind,
      label: r.kind ? UNREADABLE_LABEL[r.kind] : 'Could not be read',
      reason: r.reason ?? 'The file could not be read.',
      advice: r.kind ? UNREADABLE_ADVICE[r.kind] : 'An operator has been told. Try adding the file again later.',
      listedOnly: r.version_no === null,
      versionNo: r.version_no,
    }));
  }

  /** A linked file seen again: refresh its provider hash, path and name, and bring it back if it had been removed. */
  private async touchLinked(tx: Tx, orgId: string, fileId: string, input: RecordInput): Promise<void> {
    await tx.query(
      'files',
      `UPDATE files SET status = 'active', name = $3, folder_link_id = COALESCE($4, folder_link_id), source_hash = $5, source_path = $6,
              unreadable_kind = NULL, unreadable_reason = NULL, updated_at = now()
        WHERE id = $1 AND org_id = $2`,
      [fileId, orgId, cleanFileName(input.name), input.folderLinkId ?? null, input.sourceHash ?? null, input.sourcePath?.slice(0, 1024) ?? null],
    );
  }

  private async getSummary(orgId: string, fileId: string): Promise<FileSummary> {
    const page = await this.query(orgId, 'f.id = $2', [fileId], 1);
    if (!page[0]) throw new AppError(404, ErrorCodes.NOT_FOUND, 'File not found');
    return page[0];
  }

  private async query(orgId: string, where: string, params: unknown[], limit: number): Promise<(FileSummary & { _created: Date })[]> {
    const rows = await dataService.query<{
      id: string;
      project_id: string;
      name: string;
      source: FileSource;
      source_ref: string | null;
      version_count: number;
      created_at: Date;
      updated_at: Date;
      latest: VersionRow | null;
    }>(
      { orgId },
      'files',
      `SELECT f.id, f.project_id, f.name, f.source, f.source_ref, f.version_count, f.created_at, f.updated_at,
              (SELECT row_to_json(x) FROM (SELECT ${VERSION_COLUMNS} FROM file_versions v
                 WHERE v.file_id = f.id AND v.org_id = f.org_id ORDER BY v.version_no DESC LIMIT 1) x) AS latest
         FROM files f
        WHERE f.org_id = $1 AND f.status = 'active' AND ${where}
        ORDER BY f.created_at DESC, f.id DESC
        LIMIT ${limit}`,
      [orgId, ...params],
    );
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      name: r.name,
      source: r.source,
      sourceRef: r.source_ref,
      versionCount: r.version_count,
      latest: r.latest
        ? toVersion({ ...r.latest, created_at: new Date(r.latest.created_at), parsed_at: r.latest.parsed_at ? new Date(r.latest.parsed_at) : null })
        : null,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
      _created: r.created_at,
    }));
  }

  /** A project's files, newest first, each with its latest version's status. */
  async list(orgId: string, projectId: string, size: number, cursor?: string): Promise<Page<FileSummary>> {
    const [project] = await dataService.query<{ id: string }>({ orgId }, 'projects', 'SELECT id FROM projects WHERE id = $1 AND org_id = $2', [
      projectId,
      orgId,
    ]);
    if (!project) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
    const after = decodeCursor(cursor);
    const where = after.createdAt ? 'f.project_id = $2 AND (f.created_at, f.id) < ($3::timestamptz, $4::uuid)' : 'f.project_id = $2';
    const rows = await this.query(orgId, where, after.createdAt ? [projectId, after.createdAt, after.id] : [projectId], size + 1);
    return toPage(
      rows.map((r) => ({ ...r, created_at: r._created })),
      size,
      ({ _created: _c, created_at: _ca, ...file }) => file,
    );
  }

  /** One file with every version (newest first), its parse and PHI results. */
  async detail(orgId: string, fileId: string): Promise<FileDetail> {
    const [file] = await dataService.query<{
      id: string;
      project_id: string;
      name: string;
      source: FileSource;
      source_ref: string | null;
      version_count: number;
      current_version_id: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      { orgId },
      'files',
      "SELECT id, project_id, name, source, source_ref, version_count, current_version_id, created_at, updated_at FROM files WHERE id = $1 AND org_id = $2 AND status = 'active'",
      [fileId, orgId],
    );
    if (!file) throw new AppError(404, ErrorCodes.NOT_FOUND, 'File not found');
    const versions = await dataService.query<
      VersionRow & {
        location_count: number;
        chunk_count: number;
        phi_findings: unknown[];
        injection_signals: unknown[];
        profile: unknown;
        discarded_at: Date | null;
      }
    >(
      { orgId },
      'file_versions',
      `SELECT ${VERSION_COLUMNS}, v.phi_findings, v.injection_signals, v.profile, v.discarded_at,
              (SELECT count(*)::int FROM source_locations s WHERE s.file_version_id = v.id AND s.org_id = v.org_id) AS location_count,
              (SELECT count(*)::int FROM chunks c WHERE c.file_version_id = v.id AND c.org_id = v.org_id) AS chunk_count
         FROM file_versions v WHERE v.file_id = $1 AND v.org_id = $2 ORDER BY v.version_no DESC LIMIT 100`,
      [fileId, orgId],
    );
    return {
      id: file.id,
      projectId: file.project_id,
      name: file.name,
      source: file.source,
      sourceRef: file.source_ref,
      versionCount: file.version_count,
      currentVersionId: file.current_version_id,
      createdAt: file.created_at.toISOString(),
      updatedAt: file.updated_at.toISOString(),
      versions: versions.map((v) => ({
        ...toVersion(v),
        locationCount: v.location_count,
        chunkCount: v.chunk_count,
        phiFindings: v.phi_findings,
        injectionSignals: v.injection_signals,
        profile: v.profile,
        discardedAt: v.discarded_at ? v.discarded_at.toISOString() : null,
      })),
    };
  }

  /**
   * Cited passages of one file version, for the source viewer behind a citation chip
   * (F7.3): passages from..to plus one passage of context on each side, where each sits,
   * and whether this version is still the file's current one.
   */
  async passages(orgId: string, versionId: string, from: number, to: number): Promise<PassageView> {
    const [v] = await dataService.query<{
      file_id: string;
      project_id: string;
      name: string;
      version_no: number;
      current_version_id: string | null;
      current_no: number | null;
      format: string;
      copy_kept: boolean;
    }>(
      { orgId },
      'file_versions',
      `SELECT f.id AS file_id, f.project_id, f.name, v.version_no, f.current_version_id,
              (SELECT version_no FROM file_versions c WHERE c.id = f.current_version_id) AS current_no, v.format, v.storage_key IS NOT NULL AS copy_kept
         FROM file_versions v JOIN files f ON f.id = v.file_id AND f.org_id = v.org_id
        WHERE v.id = $1 AND v.org_id = $2 AND f.status = 'active'`,
      [versionId, orgId],
    );
    if (!v) throw new AppError(404, ErrorCodes.NOT_FOUND, 'File version not found');
    const rows = await dataService.query<{
      ordinal: number;
      kind: string;
      page: number | null;
      sheet: string | null;
      cell_range: string | null;
      slide: number | null;
      section_path: string | null;
      text: string;
    }>(
      { orgId },
      'source_locations',
      `SELECT ordinal, kind, page, sheet, cell_range, slide, section_path, text FROM source_locations
        WHERE file_version_id = $1 AND org_id = $2 AND ordinal BETWEEN $3 AND $4 ORDER BY ordinal`,
      [versionId, orgId, Math.max(0, from - 1), to + 1],
    );
    if (!rows.some((r) => r.ordinal >= from && r.ordinal <= to)) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Passage not found in this file version');
    return {
      fileId: v.file_id,
      projectId: v.project_id,
      fileName: v.name,
      versionId,
      versionNo: v.version_no,
      format: v.format,
      current: v.current_version_id === versionId,
      currentVersionNo: v.current_no,
      copyKept: v.copy_kept,
      passages: rows.map((r) => ({
        ordinal: r.ordinal,
        kind: r.kind,
        cited: r.ordinal >= from && r.ordinal <= to,
        where:
          r.sheet && r.cell_range
            ? `sheet ${r.sheet}, ${r.cell_range}`
            : r.slide
              ? `slide ${r.slide}`
              : r.page
                ? `page ${r.page}`
                : (r.section_path ?? 'document'),
        sectionPath: r.section_path,
        text: r.text,
      })),
    };
  }

  /**
   * The consultant's answer to a PHI warning: "redacted" (the identifiers were removed,
   * usually by uploading a redacted version) or "accepted" (keep it: not PHI, or allowed).
   */
  async decidePhi(
    orgId: string,
    userId: string,
    versionId: string,
    decision: 'redacted' | 'accepted',
  ): Promise<{ id: string; fileId: string; projectId: string; phiStatus: string }> {
    // Only a version that was flagged has a warning to answer; the answer may be changed later.
    const rows = await dataService.query<{ id: string; file_id: string; project_id: string; phi_status: string }>(
      { orgId, userId },
      'file_versions',
      `UPDATE file_versions v SET phi_status = $3
         FROM files f
        WHERE v.id = $1 AND v.org_id = $2 AND f.id = v.file_id AND f.org_id = v.org_id AND v.phi_status IN ('flagged', 'redacted', 'accepted')
        RETURNING v.id, v.file_id, f.project_id, v.phi_status`,
      [versionId, orgId, decision],
    );
    if (!rows[0]) {
      const [exists] = await dataService.query<{ phi_status: string }>(
        { orgId },
        'file_versions',
        'SELECT phi_status FROM file_versions WHERE id = $1 AND org_id = $2',
        [versionId, orgId],
      );
      if (!exists) throw new AppError(404, ErrorCodes.NOT_FOUND, 'File version not found');
      throw new AppError(409, ErrorCodes.PHI_NOT_FLAGGED, 'This file version has no PHI warning to answer');
    }
    return { id: rows[0].id, fileId: rows[0].file_id, projectId: rows[0].project_id, phiStatus: rows[0].phi_status };
  }
}

export const fileService = new FileService();
