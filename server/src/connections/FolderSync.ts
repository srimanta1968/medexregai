import { config } from '../config/env';
import { fileService } from '../ingest/FileService';
import { dataService } from '../services/DataService';
import { assertAcceptedUpload } from '../storage/fileTypes';
import { scanUpload } from '../storage/malwareScan';
import { AppError, ErrorCodes } from '../utils/AppError';
import { connectionService } from './ConnectionService';
import { FolderChanges, FolderProvider, FolderRef, ProviderError, ProviderRateLimited, RemoteFile } from './providers';

/**
 * F2.1 change-feed sync and nightly hash sweep (worker only, never in a request).
 *
 * Every active folder link is due every SYNC_EVERY_MIN minutes:
 *   - first run:  full listing; every file is imported; the provider's cursor is saved
 *   - later runs: the provider's change feed from the saved cursor
 *   - once a day: a full listing compared by provider hash (the sweep), which catches
 *                 anything a feed missed, so a change is seen within 24 hours (AC6)
 * A file whose provider hash matches what we recorded is not downloaded again. New
 * bytes go through the same type check and malware scan as uploads and become a new
 * file version; the ingest pass then parses it. A file deleted, trashed or moved out
 * of the folder is marked removed (its versions stay for the audit trail).
 *
 * Provider webhooks are not used yet: the feed poll plus the sweep meet the 24-hour
 * target without a public webhook endpoint per provider.
 */

export const SYNC_EVERY_MIN = 15;
export const SWEEP_EVERY_HOURS = 24;
/** Downloads per link per run; the rest are picked up next run (hash-matched files are skipped). */
export const MAX_DOWNLOADS_PER_RUN = 100;
/** A claim older than this belongs to a worker that died; the link becomes claimable again. */
const STALE_CLAIM_MIN = 30;
const MAX_BACKOFF_MIN = 6 * 60;

interface LinkRow {
  id: string;
  org_id: string;
  project_id: string;
  connection_id: string;
  folder_id: string;
  folder_path: string;
  change_cursor: string | null;
  last_sweep_at: Date | null;
  sync_attempts: number;
  created_by: string | null;
}

export interface SyncReport {
  linkId: string;
  mode: 'initial' | 'sweep' | 'feed';
  imported: number;
  unchanged: number;
  skipped: Array<{ path: string; reason: string }>;
  removed: number;
  /** True when the download cap was hit: the cursor is kept and the link is due again soon. */
  partial: boolean;
}

/** The provider hash as stored in files.source_hash. */
export const hashOf = (f: RemoteFile): string =>
  f.providerHash ? `${f.providerHash.algorithm}:${f.providerHash.value}` : `mtime:${f.modifiedAt ?? 'unknown'}`;

const sourceRef = (linkId: string, fileId: string): string => `${linkId}:${fileId}`.slice(0, 1024);

async function claim(orgId: string, linkId?: string): Promise<LinkRow[]> {
  return dataService.query<LinkRow>(
    { orgId },
    'project_folder_links',
    `UPDATE project_folder_links SET sync_claimed_at = now()
      WHERE id IN (
        SELECT id FROM project_folder_links
         WHERE org_id = current_setting('app.org_id')::uuid AND status = 'active'
           AND ($1::uuid IS NULL AND next_sync_at <= now() OR id = $1::uuid)
           AND (sync_claimed_at IS NULL OR sync_claimed_at < now() - make_interval(mins => $2))
         ORDER BY next_sync_at LIMIT 5 FOR UPDATE SKIP LOCKED)
      RETURNING id, org_id, project_id, connection_id, folder_id, folder_path, change_cursor, last_sweep_at, sync_attempts, created_by`,
    [linkId ?? null, STALE_CLAIM_MIN],
  );
}

async function knownHashes(orgId: string, linkId: string): Promise<Map<string, { hash: string | null; status: string }>> {
  const rows = await dataService.query<{ source_ref: string; source_hash: string | null; status: string }>(
    { orgId },
    'files',
    `SELECT source_ref, source_hash, status FROM files WHERE folder_link_id = $1 AND org_id = current_setting('app.org_id')::uuid`,
    [linkId],
  );
  return new Map(rows.map((r) => [r.source_ref, { hash: r.source_hash, status: r.status }]));
}

async function markRemoved(orgId: string, linkId: string, removed: FolderChanges['removed'], keepRefs?: Set<string>): Promise<number> {
  let n = 0;
  if (keepRefs) {
    // Sweep: anything we hold for this link that the full listing no longer has.
    const rows = await dataService.query<{ id: string }>(
      { orgId },
      'files',
      `UPDATE files SET status = 'removed', updated_at = now()
        WHERE folder_link_id = $1 AND org_id = current_setting('app.org_id')::uuid AND status = 'active' AND NOT (source_ref = ANY($2::text[]))
        RETURNING id`,
      [linkId, [...keepRefs]],
    );
    return rows.length;
  }
  for (const r of removed) {
    const rows = r.id
      ? await dataService.query<{ id: string }>(
          { orgId },
          'files',
          `UPDATE files SET status = 'removed', updated_at = now()
            WHERE folder_link_id = $1 AND org_id = current_setting('app.org_id')::uuid AND status = 'active' AND source_ref = $2 RETURNING id`,
          [linkId, sourceRef(linkId, r.id)],
        )
      : await dataService.query<{ id: string }>(
          // Dropbox reports a deletion by path; a deleted folder removes everything under it.
          { orgId },
          'files',
          `UPDATE files SET status = 'removed', updated_at = now()
            WHERE folder_link_id = $1 AND org_id = current_setting('app.org_id')::uuid AND status = 'active'
              AND (lower(source_path) = lower($2) OR lower(source_path) LIKE lower($3) ESCAPE '\\')
            RETURNING id`,
          [linkId, r.path ?? '', `${(r.path ?? '').replace(/[\\%_]/g, (c) => `\\${c}`)}/%`],
        );
    n += rows.length;
  }
  return n;
}

async function importFiles(
  link: LinkRow,
  provider: FolderProvider,
  accessToken: string,
  files: RemoteFile[],
  report: SyncReport,
): Promise<void> {
  const known = await knownHashes(link.org_id, link.id);
  const userId = link.created_by;
  if (!userId) throw new Error('The person who linked this folder no longer has an account; link it again');
  let downloads = 0;
  for (const f of files) {
    const ref = sourceRef(link.id, f.id);
    const had = known.get(ref);
    if (had && had.status === 'active' && had.hash === hashOf(f)) {
      report.unchanged++;
      continue;
    }
    if (f.sizeBytes !== null && f.sizeBytes > config.connections.maxFileBytes) {
      report.skipped.push({ path: f.path, reason: `larger than ${config.connections.maxFileBytes} bytes` });
      continue;
    }
    if (downloads >= MAX_DOWNLOADS_PER_RUN) {
      report.partial = true;
      return;
    }
    downloads++;
    let bytes: Buffer;
    try {
      bytes = await provider.download(accessToken, f, config.connections.maxFileBytes);
    } catch (err) {
      if (err instanceof ProviderError && err.status === 413) {
        report.skipped.push({ path: f.path, reason: err.message });
        continue;
      }
      throw err;
    }
    const name = f.exportAs ? exportName(f) : f.name;
    try {
      assertAcceptedUpload(name, bytes);
    } catch (err) {
      if (err instanceof AppError) {
        report.skipped.push({ path: f.path, reason: err.message });
        continue;
      }
      throw err;
    }
    // SCAN_UNAVAILABLE propagates: the run fails and is retried with backoff.
    const scan = await scanUpload(bytes);
    const { unchanged } = await fileService.recordVersion({
      orgId: link.org_id,
      userId,
      projectId: link.project_id,
      source: 'linked',
      sourceRef: ref,
      name,
      mimeType: f.exportAs ?? f.mimeType ?? undefined,
      bytes,
      scanStatus: scan.status,
      folderLinkId: link.id,
      sourceHash: hashOf(f),
      sourcePath: f.path,
    });
    if (unchanged) report.unchanged++;
    else report.imported++;
  }
}

/** Google exports get the Office extension so type checks and parsing see the right format. */
function exportName(f: RemoteFile): string {
  const ext = f.exportAs?.includes('wordprocessingml') ? '.docx' : f.exportAs?.includes('spreadsheetml') ? '.xlsx' : '.pptx';
  return f.name.toLowerCase().endsWith(ext) ? f.name : `${f.name}${ext}`;
}

async function finish(link: LinkRow, patch: { cursor?: string; swept?: boolean; error?: string; retryAfterMin?: number; soon?: boolean }): Promise<void> {
  const attempts = patch.error ? link.sync_attempts + 1 : 0;
  const nextMin = patch.error
    ? Math.min(patch.retryAfterMin ?? 5 * 2 ** Math.min(link.sync_attempts, 7), MAX_BACKOFF_MIN)
    : patch.soon
      ? 1
      : SYNC_EVERY_MIN;
  await dataService.query(
    { orgId: link.org_id },
    'project_folder_links',
    `UPDATE project_folder_links SET
        change_cursor = COALESCE($2, change_cursor),
        last_sync_at = CASE WHEN $3::text IS NULL THEN now() ELSE last_sync_at END,
        last_sweep_at = CASE WHEN $4 THEN now() ELSE last_sweep_at END,
        last_error = $3, sync_attempts = $5, next_sync_at = now() + make_interval(mins => $6), sync_claimed_at = NULL, updated_at = now()
      WHERE id = $1 AND org_id = current_setting('app.org_id')::uuid AND status = 'active'`,
    [link.id, patch.cursor ?? null, patch.error?.slice(0, 500) ?? null, patch.swept === true, attempts, nextMin],
  );
}

/** Sync one claimed link. Errors are recorded on the link (with backoff), never thrown. */
async function syncLink(link: LinkRow): Promise<SyncReport | { linkId: string; error: string }> {
  const sweepDue = !link.last_sweep_at || Date.now() - link.last_sweep_at.getTime() >= SWEEP_EVERY_HOURS * 3600_000;
  const mode: SyncReport['mode'] = !link.change_cursor ? 'initial' : sweepDue ? 'sweep' : 'feed';
  const report: SyncReport = { linkId: link.id, mode, imported: 0, unchanged: 0, skipped: [], removed: 0, partial: false };
  try {
    const { provider, accessToken } = await connectionService.accessToken(link.org_id, link.connection_id);
    const folder: FolderRef = { id: link.folder_id, path: link.folder_path };
    if (mode === 'feed') {
      const ch = await provider.changes(accessToken, folder, link.change_cursor!);
      await importFiles(link, provider, accessToken, ch.changed, report);
      if (!report.partial) report.removed = await markRemoved(link.org_id, link.id, ch.removed);
      // Partial: keep the old cursor; the next run replays the feed and skips what is already in.
      await finish(link, report.partial ? { soon: true } : { cursor: ch.cursor });
    } else {
      const all = await provider.listAll(accessToken, folder);
      await importFiles(link, provider, accessToken, all.files, report);
      if (!report.partial) {
        report.removed = await markRemoved(link.org_id, link.id, [], new Set(all.files.map((f) => sourceRef(link.id, f.id))));
      }
      await finish(link, report.partial ? { soon: true } : { cursor: all.cursor, swept: true });
    }
    return report;
  } catch (err) {
    const msg = err instanceof AppError || err instanceof ProviderError ? err.message : `Sync failed: ${(err as Error).message}`;
    // needs_reauth / revoked: the connection already paused or unlinked this link; nothing to reschedule.
    if (err instanceof AppError && (err.code === ErrorCodes.CONNECTION_NEEDS_REAUTH || err.code === ErrorCodes.CONNECTION_REVOKED)) {
      await dataService
        .query({ orgId: link.org_id }, 'project_folder_links', 'UPDATE project_folder_links SET sync_claimed_at = NULL WHERE id = $1', [link.id])
        .catch(() => undefined);
      return { linkId: link.id, error: msg };
    }
    const retryAfterMin = err instanceof ProviderRateLimited && err.retryAfterSeconds ? Math.ceil(err.retryAfterSeconds / 60) : undefined;
    await finish(link, { error: msg, retryAfterMin }).catch(() => undefined);
    return { linkId: link.id, error: msg };
  }
}

export const folderSync = {
  /** One worker pass: every firm's due links, a few at a time. */
  async processDue(): Promise<{ links: number; imported: number; removed: number; errors: number }> {
    const totals = { links: 0, imported: 0, removed: 0, errors: 0 };
    const orgs = await dataService.query<{ id: string }>({}, 'orgs', "SELECT id FROM orgs WHERE status = 'active' ORDER BY id");
    for (const { id: orgId } of orgs) {
      let due: LinkRow[];
      try {
        due = await claim(orgId);
      } catch (err) {
        // One firm's failure must not stop the others.
        console.error(`[folder-sync] claiming links for firm ${orgId} failed: ${(err as Error).message}`);
        totals.errors++;
        continue;
      }
      for (const link of due) {
        const r = await syncLink(link);
        totals.links++;
        if ('error' in r) {
          totals.errors++;
          console.warn(`[folder-sync] link ${r.linkId}: ${r.error}`);
        } else {
          totals.imported += r.imported;
          totals.removed += r.removed;
          if (r.skipped.length) console.info(`[folder-sync] link ${r.linkId}: skipped ${JSON.stringify(r.skipped.slice(0, 5))}`);
        }
      }
    }
    return totals;
  },

  /** Sync one link now (development checks, and a future "sync now" button). */
  async syncNow(orgId: string, linkId: string): Promise<SyncReport | { linkId: string; error: string } | null> {
    const [link] = await claim(orgId, linkId);
    return link ? syncLink(link) : null;
  },
};
