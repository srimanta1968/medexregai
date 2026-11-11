import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { simpleParser } from 'mailparser';
import { config } from '../config/env';
import { fileService } from '../ingest/FileService';
import { processVersion } from '../ingest/IngestService';
import { auditService } from '../services/AuditService';
import { dataService } from '../services/DataService';
import { assertAcceptedUpload } from '../storage/fileTypes';
import { scanUpload } from '../storage/malwareScan';
import { ObjectStore, objectStore, projectObjectPrefix } from '../storage/objectStore';
import { AppError, ErrorCodes } from '../utils/AppError';
import { decodeCursor, Page, toPage } from '../utils/pagination';

/**
 * Per-project forwarding address (F2.1, PRD v2.0 FR-14.2).
 *
 * A consultant turns on an address for a project: <project-slug>.<random token>@domain.
 * A mail relay posts each raw message to POST /api/inbound/email (shared key). The API
 * finds the project from the recipient, stores the raw message and answers at once;
 * the worker (or the API right after, in-process) parses it: the sender must be one of
 * the firm's members or on the project's allow-list, DMARC must not have failed, and
 * each attachment is type-checked, malware-scanned and recorded as a file version
 * (source "email"), then read and indexed like any upload. The raw message is deleted
 * after processing; the outcome per attachment is kept.
 */

export type InboundStatus = 'queued' | 'processing' | 'accepted' | 'rejected' | 'failed';

export interface AttachmentOutcome {
  name: string;
  sizeBytes: number;
  outcome: 'stored' | 'unchanged' | 'refused';
  reason?: string;
  fileId?: string;
}

export interface InboundAddress {
  id: string;
  email: string;
  allowedSenders: string[];
  createdAt: string;
  createdByName: string | null;
}

export interface InboundSettings {
  configured: boolean;
  domain: string | null;
  address: InboundAddress | null;
}

export interface InboundEmailView {
  id: string;
  status: InboundStatus;
  reason: string | null;
  fromAddress: string | null;
  subject: string | null;
  sizeBytes: number;
  attachments: AttachmentOutcome[];
  receivedAt: string;
  processedAt: string | null;
}

const MAX_ATTEMPTS = 5;
const iso = (d: Date | string) => new Date(d).toISOString();
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Lower-case slug of the project name, at most 40 characters. */
export function addressSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug.length >= 2 ? slug : 'project';
}

/** 10 random characters from a lower-case alphabet without look-alikes: ~50 bits. */
function addressToken(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(randomBytes(10), (b) => alphabet[b % alphabet.length]).join('');
}

/** "name@client.com" or "@client.com", lower-cased; anything else is refused. */
export function normaliseSender(entry: string): string | null {
  const v = entry.trim().toLowerCase();
  if (/^@[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) return v;
  if (/^[^\s@]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) return v;
  return null;
}

export function senderAllowed(from: string, members: string[], allowed: string[]): boolean {
  const f = from.trim().toLowerCase();
  const domain = f.slice(f.lastIndexOf('@'));
  return members.includes(f) || allowed.includes(f) || allowed.includes(domain);
}

/** Unfolded header section of a raw message: name (lower-case) -> values. */
function rawHeaders(raw: Buffer): Map<string, string[]> {
  const text = raw.subarray(0, Math.min(raw.length, 256 * 1024)).toString('latin1');
  const end = text.search(/\r?\n\r?\n/);
  const section = (end >= 0 ? text.slice(0, end) : text).replace(/\r?\n[ \t]+/g, ' ');
  const out = new Map<string, string[]>();
  for (const line of section.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    out.set(name, [...(out.get(name) ?? []), line.slice(i + 1).trim()]);
  }
  return out;
}

/** Local parts of the recipients at our receiving domain, envelope first. */
export function recipientLocalParts(raw: Buffer, envelopeTo: string | undefined, domain: string): string[] {
  const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`([a-z0-9][a-z0-9.+-]{0,63})@${escaped}(?![a-z0-9.-])`, 'gi');
  const headers = rawHeaders(raw);
  const sources = envelopeTo ? [envelopeTo] : ['x-original-to', 'delivered-to', 'to', 'cc'].flatMap((h) => headers.get(h) ?? []);
  const found = new Set<string>();
  for (const s of sources) for (const m of s.matchAll(re)) found.add(m[1].toLowerCase().split('+')[0]);
  return [...found];
}

function messageId(raw: Buffer): string | null {
  const v = rawHeaders(raw).get('message-id')?.[0];
  return v ? v.slice(0, 300) : null;
}

/** Constant-time comparison of the relay's key. */
export function relayKeyMatches(given: string | undefined): boolean {
  const key = config.inboundEmail.relayKey;
  if (!key || !given) return false;
  return timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(key).digest());
}

interface AddressRow {
  id: string;
  local_part: string;
  allowed_senders: string[];
  created_at: Date;
  created_by_name: string | null;
}

interface EmailRow {
  id: string;
  status: InboundStatus;
  reason: string | null;
  from_address: string | null;
  subject: string | null;
  size_bytes: number;
  attachments: AttachmentOutcome[];
  received_at: Date;
  processed_at: Date | null;
  created_at: Date;
}

function toView(r: EmailRow): InboundEmailView {
  return {
    id: r.id,
    status: r.status,
    reason: r.reason,
    fromAddress: r.from_address,
    subject: r.subject,
    sizeBytes: r.size_bytes,
    attachments: r.attachments,
    receivedAt: iso(r.received_at),
    processedAt: r.processed_at ? iso(r.processed_at) : null,
  };
}

export class InboundEmailService {
  constructor(private readonly store: () => ObjectStore = objectStore) {}

  private requireDomain(): string {
    const d = config.inboundEmail.domain;
    if (!d)
      throw new AppError(409, ErrorCodes.INBOUND_EMAIL_NOT_CONFIGURED, 'Forwarding addresses are not set up on this server (INBOUND_EMAIL_DOMAIN is empty)');
    return d;
  }

  private async assertProject(orgId: string, projectId: string): Promise<{ name: string }> {
    const [p] = await dataService.query<{ name: string }>({ orgId }, 'projects', 'SELECT name FROM projects WHERE id = $1 AND org_id = $2', [projectId, orgId]);
    if (!p) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
    return p;
  }

  private async activeAddress(orgId: string, projectId: string): Promise<AddressRow | null> {
    const [a] = await dataService.query<AddressRow>(
      { orgId },
      'project_inbound_addresses',
      `SELECT a.id, a.local_part, a.allowed_senders, a.created_at, p.full_name AS created_by_name
         FROM project_inbound_addresses a LEFT JOIN user_profiles p ON p.user_id = a.created_by
        WHERE a.org_id = $1 AND a.project_id = $2 AND a.revoked_at IS NULL`,
      [orgId, projectId],
    );
    return a ?? null;
  }

  async settings(orgId: string, projectId: string): Promise<InboundSettings> {
    await this.assertProject(orgId, projectId);
    const domain = config.inboundEmail.domain;
    const a = domain ? await this.activeAddress(orgId, projectId) : null;
    return {
      configured: Boolean(domain),
      domain,
      address: a
        ? { id: a.id, email: `${a.local_part}@${domain}`, allowedSenders: a.allowed_senders, createdAt: iso(a.created_at), createdByName: a.created_by_name }
        : null,
    };
  }

  /** Turn the address on, or replace it with a new one (the old address stops working). */
  async create(orgId: string, userId: string, projectId: string): Promise<InboundSettings> {
    this.requireDomain();
    const project = await this.assertProject(orgId, projectId);
    await dataService.transaction({ orgId, userId }, async (tx) => {
      const [old] = await tx.query<{ allowed_senders: string[] }>(
        'project_inbound_addresses',
        `UPDATE project_inbound_addresses SET revoked_at = now(), revoked_by = $3, updated_at = now()
          WHERE org_id = $1 AND project_id = $2 AND revoked_at IS NULL RETURNING allowed_senders`,
        [orgId, projectId, userId],
      );
      const local = `${addressSlug(project.name)}.${addressToken()}`;
      await tx.query(
        'project_inbound_addresses',
        `INSERT INTO project_inbound_addresses (org_id, project_id, local_part, token_hash, allowed_senders, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [orgId, projectId, local, sha256(local), old?.allowed_senders ?? [], userId],
      );
    });
    return this.settings(orgId, projectId);
  }

  async updateSenders(orgId: string, userId: string, projectId: string, entries: string[]): Promise<InboundSettings> {
    this.requireDomain();
    await this.assertProject(orgId, projectId);
    const bad = entries.filter((e) => !normaliseSender(e));
    if (bad.length) {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        `Not an email address or @domain: ${bad.slice(0, 3).join(', ')}`,
        bad.map((b) => ({ field: 'allowedSenders', message: `${b} is not an email address or @domain` })),
      );
    }
    const senders = [...new Set(entries.map((e) => normaliseSender(e) as string))];
    const rows = await dataService.query(
      { orgId, userId },
      'project_inbound_addresses',
      `UPDATE project_inbound_addresses SET allowed_senders = $3, updated_at = now()
        WHERE org_id = $1 AND project_id = $2 AND revoked_at IS NULL RETURNING id`,
      [orgId, projectId, senders],
    );
    if (!rows.length) throw new AppError(404, ErrorCodes.NOT_FOUND, 'This project has no forwarding address; turn it on first');
    return this.settings(orgId, projectId);
  }

  async turnOff(orgId: string, userId: string, projectId: string): Promise<InboundSettings> {
    await this.assertProject(orgId, projectId);
    const rows = await dataService.query(
      { orgId, userId },
      'project_inbound_addresses',
      `UPDATE project_inbound_addresses SET revoked_at = now(), revoked_by = $3, updated_at = now()
        WHERE org_id = $1 AND project_id = $2 AND revoked_at IS NULL RETURNING id`,
      [orgId, projectId, userId],
    );
    if (!rows.length) throw new AppError(404, ErrorCodes.NOT_FOUND, 'This project has no forwarding address');
    return this.settings(orgId, projectId);
  }

  async list(orgId: string, projectId: string, size: number, cursor?: string): Promise<Page<InboundEmailView>> {
    await this.assertProject(orgId, projectId);
    const c = decodeCursor(cursor);
    const rows = await dataService.query<EmailRow>(
      { orgId },
      'inbound_emails',
      `SELECT id, status, reason, from_address, subject, size_bytes, attachments, received_at, processed_at, received_at AS created_at
         FROM inbound_emails
        WHERE org_id = $1 AND project_id = $2 AND ($3::timestamptz IS NULL OR (received_at, id) < ($3::timestamptz, $4::uuid))
        ORDER BY received_at DESC, id DESC LIMIT $5`,
      [orgId, projectId, c.createdAt, c.id, size + 1],
    );
    return toPage(rows, size, toView);
  }

  // ---------------------------------------------------------------- relay

  /** Store a raw message for each of our recipient addresses. Returns the queued ids. */
  async receive(raw: Buffer, envelopeTo: string | undefined): Promise<{ queued: { id: string; orgId: string }[]; duplicates: number }> {
    const domain = this.requireDomain();
    if (raw.length > config.inboundEmail.maxBytes) throw new AppError(413, ErrorCodes.FILE_TOO_LARGE, 'The message is too large');
    const locals = recipientLocalParts(raw, envelopeTo, domain);
    const msgId = messageId(raw);
    const queued: { id: string; orgId: string }[] = [];
    let duplicates = 0;
    for (const local of locals) {
      const hit = await dataService.transaction({}, async (tx) => {
        const [a] = await tx.lookupByToken<{ id: string; org_id: string; project_id: string }>(
          'project_inbound_addresses',
          'SELECT id, org_id, project_id FROM project_inbound_addresses WHERE token_hash = $1 AND revoked_at IS NULL',
          [sha256(local)],
        );
        if (!a) return null;
        await tx.setOrg(a.org_id);
        const [row] = await tx.query<{ id: string }>(
          'inbound_emails',
          `INSERT INTO inbound_emails (id, org_id, project_id, address_id, message_id, size_bytes, storage_key)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'pending')
           ON CONFLICT (address_id, message_id) WHERE message_id IS NOT NULL DO NOTHING RETURNING id`,
          [a.org_id, a.project_id, a.id, msgId, raw.length],
        );
        if (!row) return { duplicate: true as const };
        const key = `${projectObjectPrefix(a.org_id, a.project_id)}inbound/${row.id}.eml`;
        await this.store().put(key, raw);
        await tx.query('inbound_emails', 'UPDATE inbound_emails SET storage_key = $2 WHERE id = $1', [row.id, key]);
        return { id: row.id, orgId: a.org_id };
      });
      if (!hit) continue;
      if ('duplicate' in hit) duplicates += 1;
      else queued.push(hit);
    }
    if (!queued.length && !duplicates) throw new AppError(404, ErrorCodes.RECIPIENT_UNKNOWN, 'No active project address among the recipients');
    return { queued, duplicates };
  }

  // ---------------------------------------------------------------- processing

  /** Parse one queued message and record its attachments. Safe to run concurrently. */
  async process(orgId: string, emailId: string): Promise<InboundStatus | 'skipped'> {
    const [claimed] = await dataService.query<{
      id: string;
      project_id: string;
      storage_key: string;
      attempts: number;
      allowed_senders: string[];
      created_by: string | null;
    }>(
      { orgId },
      'inbound_emails',
      `UPDATE inbound_emails e SET status = 'processing', attempts = e.attempts + 1, claimed_at = now()
         FROM project_inbound_addresses a
        WHERE e.id = (SELECT id FROM inbound_emails WHERE id = $1 AND org_id = $2 AND status = 'queued' FOR UPDATE SKIP LOCKED)
          AND a.id = e.address_id
        RETURNING e.id, e.project_id, e.storage_key, e.attempts, a.allowed_senders, a.created_by`,
      [emailId, orgId],
    );
    if (!claimed) return 'skipped';

    const finish = async (
      status: InboundStatus,
      reason: string | null,
      extra: { from?: string | null; subject?: string | null; attachments?: AttachmentOutcome[] },
    ) => {
      await this.store()
        .delete(claimed.storage_key)
        .catch(() => undefined);
      await dataService.query(
        { orgId },
        'inbound_emails',
        `UPDATE inbound_emails SET status = $2, reason = $3, from_address = COALESCE($4, from_address), subject = COALESCE($5, subject),
           attachments = $6, storage_key = NULL, processed_at = now() WHERE id = $1`,
        [emailId, status, reason?.slice(0, 300) ?? null, extra.from ?? null, extra.subject?.slice(0, 300) ?? null, JSON.stringify(extra.attachments ?? [])],
      );
      const stored = (extra.attachments ?? []).filter((a) => a.outcome === 'stored').length;
      await auditService.record({
        orgId,
        actorUserId: null,
        action: 'inbound_email.processed',
        targetType: 'inbound_email',
        targetId: emailId,
        projectId: claimed.project_id,
        metadata: { status, stored, attachments: (extra.attachments ?? []).length },
      });
      return status;
    };
    /** Try again later (scanner down, storage error); give up after MAX_ATTEMPTS. */
    const retry = async (reason: string) => {
      if (claimed.attempts >= MAX_ATTEMPTS) return finish('failed', reason, {});
      await dataService.query({ orgId }, 'inbound_emails', "UPDATE inbound_emails SET status = 'queued', reason = $2 WHERE id = $1", [
        emailId,
        reason.slice(0, 300),
      ]);
      return 'queued' as const;
    };

    let raw: Buffer;
    try {
      raw = await this.store().get(claimed.storage_key);
    } catch (err) {
      return retry(`Could not read the stored message: ${(err as Error).message}`);
    }
    const mail = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true, skipTextLinks: true });
    const from = mail.from?.value?.[0]?.address?.toLowerCase() ?? null;
    const subject = mail.subject ?? null;

    const auth = String(mail.headers.get('authentication-results') ?? '').toLowerCase();
    if (/\bdmarc=fail\b/.test(auth)) return finish('rejected', 'The sender could not be verified (DMARC failed)', { from, subject });
    if (!from) return finish('rejected', 'The message has no sender address', { from, subject });
    const members = await dataService.query<{ email: string }>(
      { orgId },
      'memberships',
      `SELECT lower(p.email::text) AS email FROM memberships m JOIN user_profiles p ON p.user_id = m.user_id WHERE m.org_id = $1 AND m.status = 'active'`,
      [orgId],
    );
    if (
      !senderAllowed(
        from,
        members.map((m) => m.email),
        claimed.allowed_senders,
      )
    ) {
      return finish('rejected', `${from} is not allowed to send to this project. Add the address or its domain to the allowed senders.`, { from, subject });
    }
    if (!claimed.created_by)
      return finish('failed', 'The person who turned this address on no longer has an account; turn on a new address', { from, subject });

    // Real attachments only: inline images of a signature or HTML body are skipped.
    const parts = mail.attachments.filter((a) => a.filename && !a.related && a.contentDisposition !== 'inline');
    const outcomes: AttachmentOutcome[] = [];
    for (const [i, a] of parts.entries()) {
      const name = (a.filename as string).replace(/[\\/]/g, '_').slice(0, 255);
      const base = { name, sizeBytes: a.size };
      if (i >= config.inboundEmail.maxAttachments) {
        outcomes.push({ ...base, outcome: 'refused', reason: `Only the first ${config.inboundEmail.maxAttachments} attachments are taken` });
        continue;
      }
      try {
        assertAcceptedUpload(name, a.content);
        const scan = await scanUpload(a.content);
        const { file, unchanged } = await fileService.recordVersion({
          orgId,
          userId: claimed.created_by,
          projectId: claimed.project_id,
          source: 'email',
          name,
          mimeType: a.contentType,
          bytes: a.content,
          scanStatus: scan.status,
        });
        outcomes.push({ ...base, outcome: unchanged ? 'unchanged' : 'stored', fileId: file.id });
        if (!unchanged && file.latest && config.docproc.serviceKey) {
          const versionId = file.latest.id;
          setImmediate(() => {
            processVersion(orgId, versionId).catch((err) => console.error(`[inbound] parse of ${versionId} failed: ${(err as Error).message}`));
          });
        }
      } catch (err) {
        if (err instanceof AppError && err.code === ErrorCodes.SCAN_UNAVAILABLE) {
          // Nothing of this message is half-recorded on purpose: stored attachments are
          // idempotent (same bytes = unchanged), so the whole message is retried.
          return retry('The malware scanner is unavailable; the message will be tried again');
        }
        if (err instanceof AppError) outcomes.push({ ...base, outcome: 'refused', reason: err.message });
        else return retry(`Recording an attachment failed: ${(err as Error).message}`);
      }
    }
    const stored = outcomes.filter((o) => o.outcome !== 'refused').length;
    const reason = parts.length === 0 ? 'The message had no attachments' : stored === 0 ? 'No attachment could be accepted' : null;
    return finish('accepted', reason, { from, subject, attachments: outcomes });
  }

  /** Worker pass: queued messages of every firm, oldest first. */
  async processQueued(perOrg = 10): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    const orgs = await dataService.query<{ id: string }>({}, 'orgs', "SELECT id FROM orgs WHERE status = 'active' ORDER BY id");
    for (const { id: orgId } of orgs) {
      // A claim that lost its worker (crash mid-message) goes back to the queue after 10 minutes.
      await dataService.query(
        { orgId },
        'inbound_emails',
        "UPDATE inbound_emails SET status = 'queued' WHERE org_id = $1 AND status = 'processing' AND claimed_at < now() - interval '10 minutes'",
        [orgId],
      );
      const due = await dataService.query<{ id: string }>(
        { orgId },
        'inbound_emails',
        "SELECT id FROM inbound_emails WHERE org_id = $1 AND status = 'queued' ORDER BY received_at LIMIT $2",
        [orgId, perOrg],
      );
      for (const { id } of due) {
        try {
          const r = await this.process(orgId, id);
          counts[r] = (counts[r] ?? 0) + 1;
        } catch (err) {
          console.error(`[inbound] message ${id} failed: ${(err as Error).message}`);
          await dataService
            .query({ orgId }, 'inbound_emails', "UPDATE inbound_emails SET status = 'queued' WHERE id = $1 AND status = 'processing'", [id])
            .catch(() => undefined);
          counts.error = (counts.error ?? 0) + 1;
        }
      }
    }
    return counts;
  }
}

export const inboundEmailService = new InboundEmailService();
