import { createHash } from 'crypto';
import { evalStore } from '../ai/eval/EvalStore';
import { EVAL_SETS_VERSION } from '../ai/eval/sets';
import { OUTPUT_SCHEMA_VERSION } from '../ai/guard/outputSchemas';
import { TEMPLATE_VERSIONS } from '../ai/guard/prompts';
import { REGISTRY_VERSION } from '../ai/registry';
import { config } from '../config/env';
import { dataService } from '../services/DataService';
import { fileObjectPrefix, ObjectStore, objectStore } from '../storage/objectStore';
import { AppError, ErrorCodes } from '../utils/AppError';
import { decodeCursor, Page, toPage } from '../utils/pagination';
import {
  CertificateInput,
  certificateBlocks,
  certificateCanonical,
  CLAUSE_STATUS,
  clientClause,
  dataHandlingPackBlocks,
  DataUseState,
  DELETION_CATEGORIES,
  PACK_CONTENT_VERSION,
  PackContext,
  PackKey,
  PACKS,
  PlatformEvalInfo,
  validationPackBlocks,
} from './content';
import { renderPdf } from './pdf';

/**
 * Trust pack (F2.5): the validation and data-handling packs as PDF, the client
 * clause, firm data-use settings and per-project deletion with a certificate.
 *
 * Deletion (NFR-14): the request removes every database row of the project in one
 * transaction (all project tables cascade from projects) after counting them for the
 * certificate, and records the storage prefixes of the project's files. The project
 * disappears at once. The stored objects are removed afterwards (right after the
 * response, and by the worker as a backstop); when none are left the deletion is
 * completed and its certificate fingerprint fixed.
 */

export interface DeletionView {
  id: string;
  projectId: string;
  projectName: string;
  clientName: string;
  deviceName: string;
  status: 'removing_files' | 'completed';
  counts: Record<string, number>;
  objectsTotal: number;
  objectsRemoved: number;
  requestedByName: string;
  requestedAt: string;
  dueBy: string;
  rowsDeletedAt: string;
  completedAt: string | null;
  certificateSha256: string | null;
  lastError: string | null;
}

interface DeletionRow {
  id: string;
  project_id: string;
  firm_name: string;
  project_name: string;
  client_name: string;
  device_name: string;
  status: DeletionView['status'];
  counts: Record<string, number>;
  objects_total: number;
  objects_removed: number;
  backup_retention_days: number;
  requested_by_name: string;
  requested_at: Date;
  due_by: Date;
  rows_deleted_at: Date;
  completed_at: Date | null;
  certificate_sha256: string | null;
  last_error: string | null;
  created_at: Date;
}

const DELETION_COLUMNS = `id, project_id, firm_name, project_name, client_name, device_name, status, counts, objects_total, objects_removed,
  backup_retention_days, requested_by_name, requested_at, due_by, rows_deleted_at, completed_at, certificate_sha256, last_error,
  requested_at AS created_at`;

const iso = (d: Date | string) => new Date(d).toISOString();

function toView(r: DeletionRow): DeletionView {
  return {
    id: r.id,
    projectId: r.project_id,
    projectName: r.project_name,
    clientName: r.client_name,
    deviceName: r.device_name,
    status: r.status,
    counts: r.counts,
    objectsTotal: r.objects_total,
    objectsRemoved: r.objects_removed,
    requestedByName: r.requested_by_name,
    requestedAt: iso(r.requested_at),
    dueBy: iso(r.due_by),
    rowsDeletedAt: iso(r.rows_deleted_at),
    completedAt: r.completed_at ? iso(r.completed_at) : null,
    certificateSha256: r.certificate_sha256,
    lastError: r.last_error,
  };
}

function certificateInput(r: DeletionRow, completedAt: string): CertificateInput {
  return {
    firmName: r.firm_name,
    deletionId: r.id,
    projectId: r.project_id,
    projectName: r.project_name,
    clientName: r.client_name,
    deviceName: r.device_name,
    requestedByName: r.requested_by_name,
    requestedAt: iso(r.requested_at),
    rowsDeletedAt: iso(r.rows_deleted_at),
    completedAt,
    dueBy: iso(r.due_by),
    counts: r.counts,
    objectsRemoved: r.objects_removed,
    backupRetentionDays: r.backup_retention_days,
    release: config.trust.releaseVersion,
  };
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown host';
  }
}

export class TrustService {
  constructor(private readonly store: () => ObjectStore = objectStore) {}

  // ------------------------------------------------------------ data use

  async dataUse(orgId: string): Promise<DataUseState> {
    const [row] = await dataService.query<{ product_improvement_use: boolean; data_use_updated_at: Date | null; updated_by_name: string | null }>(
      { orgId },
      'orgs',
      `SELECT o.product_improvement_use, o.data_use_updated_at, p.full_name AS updated_by_name
         FROM orgs o LEFT JOIN user_profiles p ON p.user_id = o.data_use_updated_by
        WHERE o.id = $1`,
      [orgId],
    );
    if (!row) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Firm not found');
    return {
      aiTraining: 'never',
      productImprovement: row.product_improvement_use,
      updatedAt: row.data_use_updated_at ? iso(row.data_use_updated_at) : null,
      updatedByName: row.updated_by_name,
    };
  }

  async updateDataUse(orgId: string, userId: string, productImprovement: boolean): Promise<DataUseState> {
    await dataService.query(
      { orgId, userId },
      'orgs',
      `UPDATE orgs SET product_improvement_use = $2, data_use_updated_at = now(), data_use_updated_by = $3, updated_at = now() WHERE id = $1`,
      [orgId, productImprovement, userId],
    );
    return this.dataUse(orgId);
  }

  // ------------------------------------------------------------ packs

  private async context(orgId: string): Promise<PackContext> {
    const [firm] = await dataService.query<{ name: string }>({ orgId }, 'orgs', 'SELECT name FROM orgs WHERE id = $1', [orgId]);
    if (!firm) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Firm not found');
    const providers = await dataService.query<{
      name: string;
      kind: 'openai_compatible' | 'anthropic';
      generation_model: string;
      base_url: string;
      test_status: string;
      eval_status: string;
      enabled_routes: string[];
    }>(
      { orgId },
      'firm_model_providers',
      `SELECT name, kind, generation_model, base_url, test_status, eval_status, enabled_routes
         FROM firm_model_providers WHERE org_id = $1 ORDER BY lower(name)`,
      [orgId],
    );
    const run = await evalStore.latestPlatform();
    return {
      firmName: firm.name,
      generatedAt: new Date(),
      release: config.trust.releaseVersion,
      production: config.nodeEnv === 'production',
      hostingRegion: config.trust.hostingRegion,
      storageDriver: (process.env.STORAGE_DRIVER ?? 'fs').trim(),
      mailTransport: config.mail.transport,
      deletionDays: config.trust.deletionDays,
      backupRetentionDays: config.trust.backupRetentionDays,
      dataUse: await this.dataUse(orgId),
      platformAi: { provider: config.llm.provider, generationModel: config.llm.generationModel, embeddingModel: config.llm.embeddingModel },
      firmProviders: providers.map((p) => ({
        name: p.name,
        kind: p.kind,
        model: p.generation_model,
        host: hostOf(p.base_url),
        testStatus: p.test_status,
        evalStatus: p.eval_status,
        routes: p.enabled_routes,
      })),
      versions: {
        registry: REGISTRY_VERSION,
        outputChecks: OUTPUT_SCHEMA_VERSION,
        evalSets: EVAL_SETS_VERSION,
        packContent: PACK_CONTENT_VERSION,
        prompts: { ...TEMPLATE_VERSIONS },
      },
      platformEval: run
        ? {
            status: run.status,
            provider: run.provider,
            model: run.model,
            finishedAt: run.finishedAt,
            scores: run.scores as unknown as PlatformEvalInfo['scores'],
            thresholds: run.thresholds,
          }
        : null,
    };
  }

  async summary(orgId: string): Promise<{
    release: string;
    contentVersion: string;
    packs: { key: PackKey; title: string; summary: string; fileName: string; format: 'pdf' }[];
    clause: { text: string; status: string };
    dataUse: DataUseState;
    deletionDays: number;
    backupRetentionDays: number;
  }> {
    const [firm] = await dataService.query<{ name: string }>({ orgId }, 'orgs', 'SELECT name FROM orgs WHERE id = $1', [orgId]);
    if (!firm) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Firm not found');
    return {
      release: config.trust.releaseVersion,
      contentVersion: PACK_CONTENT_VERSION,
      packs: Object.values(PACKS).map((p) => ({ key: p.key, title: p.title, summary: p.summary, fileName: p.fileName, format: 'pdf' as const })),
      clause: { text: clientClause(firm.name, config.trust.deletionDays), status: CLAUSE_STATUS },
      dataUse: await this.dataUse(orgId),
      deletionDays: config.trust.deletionDays,
      backupRetentionDays: config.trust.backupRetentionDays,
    };
  }

  async packPdf(orgId: string, pack: PackKey): Promise<{ fileName: string; bytes: Buffer }> {
    const c = await this.context(orgId);
    const meta = PACKS[pack];
    const blocks = pack === 'validation' ? validationPackBlocks(c) : dataHandlingPackBlocks(c);
    const bytes = renderPdf({
      title: `MedexRegAI ${meta.title.toLowerCase()}`,
      footer: `MedexRegAI ${meta.title.toLowerCase()} | ${c.firmName} | ${c.release}`,
      createdAt: c.generatedAt,
      blocks,
    });
    return { fileName: meta.fileName, bytes };
  }

  // ------------------------------------------------------------ deletion

  async requestDeletion(orgId: string, userId: string, projectId: string, confirmName: string): Promise<DeletionView> {
    const id = await dataService.transaction({ orgId, userId }, async (tx) => {
      const [p] = await tx.query<{ name: string; client_name: string; device_name: string; firm_name: string }>(
        'projects',
        `SELECT p.name, w.name AS client_name, d.name AS device_name, o.name AS firm_name
           FROM projects p
           JOIN client_workspaces w ON w.id = p.workspace_id AND w.org_id = p.org_id
           JOIN devices d ON d.id = p.device_id AND d.org_id = p.org_id
           JOIN orgs o ON o.id = p.org_id
          WHERE p.id = $1 AND p.org_id = $2
          FOR UPDATE OF p`,
        [projectId, orgId],
      );
      if (!p) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
      if (confirmName.trim() !== p.name.trim()) {
        throw new AppError(422, ErrorCodes.CONFIRMATION_MISMATCH, 'Type the project name exactly to confirm the deletion', [
          { field: 'confirmName', message: 'Does not match the project name' },
        ]);
      }
      const [c] = await tx.query<Record<string, string>>(
        'projects',
        `SELECT
           (SELECT count(*) FROM files f WHERE f.org_id = $1 AND f.project_id = $2) AS files,
           (SELECT count(*) FROM file_versions v JOIN files f ON f.id = v.file_id WHERE f.org_id = $1 AND f.project_id = $2) AS file_versions,
           (SELECT count(*) FROM file_versions v JOIN files f ON f.id = v.file_id WHERE f.org_id = $1 AND f.project_id = $2 AND v.storage_key IS NOT NULL) AS stored,
           (SELECT count(*) FROM source_locations s JOIN file_versions v ON v.id = s.file_version_id JOIN files f ON f.id = v.file_id
              WHERE f.org_id = $1 AND f.project_id = $2) AS source_locations,
           (SELECT count(*) FROM chunks k WHERE k.org_id = $1 AND k.project_id = $2) AS chunks,
           (SELECT count(*) FROM citation_gate_runs g WHERE g.org_id = $1 AND g.project_id = $2) AS citation_gate_runs,
           (SELECT count(*) FROM client_requests r WHERE r.org_id = $1 AND r.project_id = $2) AS client_requests,
           (SELECT count(*) FROM client_request_items i JOIN client_requests r ON r.id = i.request_id WHERE r.org_id = $1 AND r.project_id = $2) AS client_request_items,
           (SELECT count(*) FROM upload_links l JOIN client_requests r ON r.id = l.request_id WHERE r.org_id = $1 AND r.project_id = $2) AS upload_links,
           (SELECT count(*) FROM ai_calls a WHERE a.org_id = $1 AND a.project_id = $2) AS ai_calls`,
        [orgId, projectId],
      );
      const counts = Object.fromEntries(DELETION_CATEGORIES.map((k) => [k.key, Number(c[k.key] ?? 0)]));
      const files = await tx.query<{ id: string }>('files', 'SELECT id FROM files WHERE org_id = $1 AND project_id = $2', [orgId, projectId]);
      const [who] = await tx.query<{ full_name: string }>('user_profiles', 'SELECT full_name FROM user_profiles WHERE user_id = $1', [userId]);

      const [row] = await tx.query<{ id: string }>(
        'project_deletions',
        `INSERT INTO project_deletions (org_id, project_id, firm_name, project_name, client_name, device_name, counts, objects_total,
           backup_retention_days, requested_by, requested_by_name, due_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + make_interval(days => $12::int)) RETURNING id`,
        [
          orgId,
          projectId,
          p.firm_name,
          p.name,
          p.client_name,
          p.device_name,
          JSON.stringify(counts),
          Number(c.stored ?? 0),
          config.trust.backupRetentionDays,
          userId,
          who?.full_name ?? 'Unknown user',
          config.trust.deletionDays,
        ],
      );
      if (files.length) {
        await tx.query(
          'project_deletion_objects',
          `INSERT INTO project_deletion_objects (deletion_id, org_id, prefix) SELECT $1, $2, unnest($3::text[]) ON CONFLICT DO NOTHING`,
          [row.id, orgId, files.map((f) => fileObjectPrefix(orgId, f.id))],
        );
      }
      // Every project table cascades from projects: files, versions, locations, chunks, gate runs, requests, links, AI calls.
      await tx.query('projects', 'DELETE FROM projects WHERE id = $1 AND org_id = $2', [projectId, orgId]);
      return row.id;
    });
    return this.deletion(orgId, id);
  }

  async deletion(orgId: string, deletionId: string): Promise<DeletionView> {
    const [r] = await dataService.query<DeletionRow>(
      { orgId },
      'project_deletions',
      `SELECT ${DELETION_COLUMNS} FROM project_deletions WHERE id = $1 AND org_id = $2`,
      [deletionId, orgId],
    );
    if (!r) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Deletion not found');
    return toView(r);
  }

  async deletions(orgId: string, size: number, cursor?: string): Promise<Page<DeletionView>> {
    const c = decodeCursor(cursor);
    const rows = await dataService.query<DeletionRow>(
      { orgId },
      'project_deletions',
      `SELECT ${DELETION_COLUMNS} FROM project_deletions
        WHERE org_id = $1 AND ($2::timestamptz IS NULL OR (requested_at, id) < ($2::timestamptz, $3::uuid))
        ORDER BY requested_at DESC, id DESC LIMIT $4`,
      [orgId, c.createdAt, c.id, size + 1],
    );
    return toPage(rows, size, toView);
  }

  /** Remove the stored objects of one deletion and complete it when none are left. Safe to run concurrently. */
  async processDeletion(orgId: string, deletionId: string): Promise<'completed' | 'pending' | 'skipped'> {
    return dataService.transaction({ orgId }, async (tx) => {
      const [r] = await tx.query<DeletionRow>(
        'project_deletions',
        `SELECT ${DELETION_COLUMNS} FROM project_deletions WHERE id = $1 AND org_id = $2 AND status = 'removing_files' FOR UPDATE SKIP LOCKED`,
        [deletionId, orgId],
      );
      if (!r) return 'skipped';
      const prefixes = await tx.query<{ prefix: string }>(
        'project_deletion_objects',
        'SELECT prefix FROM project_deletion_objects WHERE deletion_id = $1 AND org_id = $2 ORDER BY prefix',
        [deletionId, orgId],
      );
      let removed = 0;
      let error: string | null = null;
      for (const { prefix } of prefixes) {
        try {
          removed += await this.store().deletePrefix(prefix);
          await tx.query('project_deletion_objects', 'DELETE FROM project_deletion_objects WHERE deletion_id = $1 AND prefix = $2', [deletionId, prefix]);
        } catch (err) {
          error = `Removing stored files failed: ${(err as Error).message}`.slice(0, 500);
          break;
        }
      }
      if (error) {
        await tx.query(
          'project_deletions',
          'UPDATE project_deletions SET objects_removed = objects_removed + $2, attempts = attempts + 1, last_error = $3 WHERE id = $1',
          [deletionId, removed, error],
        );
        return 'pending';
      }
      const completedAt = new Date().toISOString();
      const finalRow = { ...r, objects_removed: r.objects_removed + removed };
      const fingerprint = sha256(certificateCanonical(certificateInput(finalRow, completedAt)));
      await tx.query(
        'project_deletions',
        `UPDATE project_deletions SET objects_removed = $2, status = 'completed', completed_at = $3, certificate_sha256 = $4, last_error = NULL,
           attempts = attempts + 1 WHERE id = $1`,
        [deletionId, finalRow.objects_removed, completedAt, fingerprint],
      );
      return 'completed';
    });
  }

  /** Worker pass: every firm's pending deletions, oldest first. */
  async processPending(perOrg = 5): Promise<{ completed: number; pending: number }> {
    const out = { completed: 0, pending: 0 };
    const orgs = await dataService.query<{ id: string }>({}, 'orgs', 'SELECT id FROM orgs ORDER BY id');
    for (const { id: orgId } of orgs) {
      const due = await dataService.query<{ id: string }>(
        { orgId },
        'project_deletions',
        `SELECT id FROM project_deletions WHERE org_id = $1 AND status = 'removing_files' ORDER BY requested_at LIMIT $2`,
        [orgId, perOrg],
      );
      for (const { id } of due) {
        const r = await this.processDeletion(orgId, id);
        if (r === 'completed') out.completed += 1;
        else if (r === 'pending') out.pending += 1;
      }
    }
    return out;
  }

  async certificatePdf(orgId: string, deletionId: string): Promise<{ fileName: string; bytes: Buffer; sha256: string }> {
    const [r] = await dataService.query<DeletionRow>(
      { orgId },
      'project_deletions',
      `SELECT ${DELETION_COLUMNS} FROM project_deletions WHERE id = $1 AND org_id = $2`,
      [deletionId, orgId],
    );
    if (!r) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Deletion not found');
    if (r.status !== 'completed' || !r.completed_at || !r.certificate_sha256) {
      throw new AppError(409, ErrorCodes.DELETION_IN_PROGRESS, 'The deletion is still in progress; the certificate is issued when it completes');
    }
    const input = certificateInput(r, iso(r.completed_at));
    const fingerprint = sha256(certificateCanonical(input));
    if (fingerprint !== r.certificate_sha256) throw new Error(`Deletion ${r.id}: the record no longer matches its certificate fingerprint`);
    const bytes = renderPdf({
      title: 'Certificate of project data deletion',
      footer: `MedexRegAI deletion certificate | ${r.id}`,
      createdAt: new Date(r.completed_at),
      blocks: certificateBlocks(input, fingerprint),
    });
    return { fileName: `deletion-certificate-${r.id.slice(0, 8)}.pdf`, bytes, sha256: fingerprint };
  }
}

export const trustService = new TrustService();
