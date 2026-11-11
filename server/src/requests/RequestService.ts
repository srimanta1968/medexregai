import { config } from '../config/env';
import { processVersion } from '../ingest/IngestService';
import { fileService } from '../ingest/FileService';
import { auditService } from '../services/AuditService';
import { dataService, Tx } from '../services/DataService';
import { mailService } from '../services/MailService';
import { hashToken, newOpaqueToken } from '../services/TokenService';
import { ACCEPTED_EXTENSIONS, ACCEPTED_LABEL, assertAcceptedUpload } from '../storage/fileTypes';
import { scanUpload } from '../storage/malwareScan';
import { AppError, ErrorCodes } from '../utils/AppError';
import { decodeCursor, Page, toPage } from '../utils/pagination';

/**
 * Client requests and no-login upload links (F2.4, PRD FR-14.9).
 *
 * A consultant drafts a request (title, message, items), edits it, and approves it.
 * Nothing reaches the client before approval. Approval issues an expiring upload link
 * (the token is shown once; only its hash is kept) and, when the request has a
 * recipient address, emails the approved message with the link. The client uploads on
 * a phone without an account: each file is type-checked, malware-scanned, recorded as
 * a version of the project's files (source "request") and marks its item received.
 */

export type RequestStatus = 'draft' | 'open' | 'closed';

export interface ItemInput {
  label: string;
  detail?: string;
  sectionId?: string | null;
  gapRef?: string | null;
}

export interface RequestInput {
  title: string;
  message?: string;
  recipientName?: string | null;
  recipientEmail?: string | null;
  items: ItemInput[];
}

export interface RequestItem {
  id: string;
  position: number;
  label: string;
  detail: string;
  sectionId: string | null;
  gapRef: string | null;
  status: 'requested' | 'received';
  receivedAt: string | null;
  receivedCount: number;
}

export interface LinkState {
  active: boolean;
  expiresAt: string;
  revokedAt: string | null;
  filesReceived: number;
  maxFiles: number;
  lastUsedAt: string | null;
}

export interface RequestSummary {
  id: string;
  projectId: string;
  title: string;
  status: RequestStatus;
  recipientName: string | null;
  recipientEmail: string | null;
  itemCount: number;
  receivedCount: number;
  emailStatus: 'not_sent' | 'sent' | 'failed';
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RequestDetail extends RequestSummary {
  message: string;
  emailError: string | null;
  emailedAt: string | null;
  items: RequestItem[];
  link: LinkState | null;
}

interface RequestRow {
  id: string;
  project_id: string;
  title: string;
  status: RequestStatus;
  recipient_name: string | null;
  recipient_email: string | null;
  item_count: number;
  received_count: number;
  email_status: RequestSummary['emailStatus'];
  approved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const SUMMARY_COLUMNS = `r.id, r.project_id, r.title, r.status, r.recipient_name, r.recipient_email, r.email_status, r.approved_at, r.created_at, r.updated_at,
  (SELECT count(*)::int FROM client_request_items i WHERE i.request_id = r.id AND i.org_id = r.org_id) AS item_count,
  (SELECT count(*)::int FROM client_request_items i WHERE i.request_id = r.id AND i.org_id = r.org_id AND i.status = 'received') AS received_count`;

const toSummary = (r: RequestRow): RequestSummary => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  status: r.status,
  recipientName: r.recipient_name,
  recipientEmail: r.recipient_email,
  itemCount: r.item_count,
  receivedCount: r.received_count,
  emailStatus: r.email_status,
  approvedAt: iso(r.approved_at),
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

const notFound = (): AppError => new AppError(404, ErrorCodes.NOT_FOUND, 'Request not found');
const linkUrl = (token: string): string => `${config.appBaseUrl}/u/${encodeURIComponent(token)}`;

async function replaceItems(tx: Tx, orgId: string, requestId: string, items: ItemInput[]): Promise<void> {
  await tx.query('client_request_items', 'DELETE FROM client_request_items WHERE request_id = $1 AND org_id = $2', [requestId, orgId]);
  for (const [i, it] of items.entries()) {
    await tx.query(
      'client_request_items',
      `INSERT INTO client_request_items (org_id, request_id, position, label, detail, section_id, gap_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [orgId, requestId, i + 1, it.label, it.detail ?? '', it.sectionId ?? null, it.gapRef ?? null],
    );
  }
}

export class RequestService {
  async create(orgId: string, userId: string, projectId: string, input: RequestInput): Promise<RequestDetail> {
    const id = await dataService.transaction({ orgId, userId }, async (tx) => {
      const [project] = await tx.query<{ id: string }>('projects', 'SELECT id FROM projects WHERE id = $1 AND org_id = $2', [projectId, orgId]);
      if (!project) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
      const [row] = await tx.query<{ id: string }>(
        'client_requests',
        `INSERT INTO client_requests (org_id, project_id, title, message, recipient_name, recipient_email, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [orgId, projectId, input.title, input.message ?? '', input.recipientName ?? null, input.recipientEmail?.toLowerCase() ?? null, userId],
      );
      await replaceItems(tx, orgId, row.id, input.items);
      return row.id;
    });
    return this.detail(orgId, id);
  }

  async list(orgId: string, projectId: string, size: number, cursor?: string): Promise<Page<RequestSummary>> {
    const [project] = await dataService.query<{ id: string }>({ orgId }, 'projects', 'SELECT id FROM projects WHERE id = $1 AND org_id = $2', [
      projectId,
      orgId,
    ]);
    if (!project) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
    const c = decodeCursor(cursor);
    const rows = await dataService.query<RequestRow>(
      { orgId },
      'client_requests',
      `SELECT ${SUMMARY_COLUMNS} FROM client_requests r
        WHERE r.org_id = $1 AND r.project_id = $2
          AND ($3::timestamptz IS NULL OR (r.created_at, r.id) < ($3::timestamptz, $4::uuid))
        ORDER BY r.created_at DESC, r.id DESC LIMIT $5`,
      [orgId, projectId, c.createdAt, c.id, size + 1],
    );
    return toPage(rows, size, toSummary);
  }

  async detail(orgId: string, requestId: string): Promise<RequestDetail> {
    const [r] = await dataService.query<RequestRow & { message: string; email_error: string | null; emailed_at: Date | null }>(
      { orgId },
      'client_requests',
      `SELECT ${SUMMARY_COLUMNS}, r.message, r.email_error, r.emailed_at FROM client_requests r WHERE r.id = $1 AND r.org_id = $2`,
      [requestId, orgId],
    );
    if (!r) throw notFound();
    const items = await dataService.query<{
      id: string;
      position: number;
      label: string;
      detail: string;
      section_id: string | null;
      gap_ref: string | null;
      status: RequestItem['status'];
      received_at: Date | null;
      received_count: number;
    }>(
      { orgId },
      'client_request_items',
      `SELECT id, position, label, detail, section_id, gap_ref, status, received_at, received_count
         FROM client_request_items WHERE request_id = $1 AND org_id = $2 ORDER BY position`,
      [requestId, orgId],
    );
    const [link] = await dataService.query<{
      expires_at: Date;
      revoked_at: Date | null;
      files_received: number;
      max_files: number;
      last_used_at: Date | null;
    }>(
      { orgId },
      'upload_links',
      `SELECT expires_at, revoked_at, files_received, max_files, last_used_at FROM upload_links
        WHERE request_id = $1 AND org_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [requestId, orgId],
    );
    return {
      ...toSummary(r),
      message: r.message,
      emailError: r.email_error,
      emailedAt: iso(r.emailed_at),
      items: items.map((i) => ({
        id: i.id,
        position: i.position,
        label: i.label,
        detail: i.detail,
        sectionId: i.section_id,
        gapRef: i.gap_ref,
        status: i.status,
        receivedAt: iso(i.received_at),
        receivedCount: i.received_count,
      })),
      link: link
        ? {
            active: !link.revoked_at && link.expires_at > new Date() && r.status === 'open',
            expiresAt: link.expires_at.toISOString(),
            revokedAt: iso(link.revoked_at),
            filesReceived: link.files_received,
            maxFiles: link.max_files,
            lastUsedAt: iso(link.last_used_at),
          }
        : null,
    };
  }

  /** Edit a draft. Once approved, the text the client received is not changed. */
  async update(orgId: string, userId: string, requestId: string, input: Partial<RequestInput>): Promise<RequestDetail> {
    await dataService.transaction({ orgId, userId }, async (tx) => {
      const [r] = await tx.query<{ status: RequestStatus }>('client_requests', 'SELECT status FROM client_requests WHERE id = $1 AND org_id = $2 FOR UPDATE', [
        requestId,
        orgId,
      ]);
      if (!r) throw notFound();
      if (r.status !== 'draft') throw new AppError(409, ErrorCodes.REQUEST_NOT_DRAFT, 'Only a draft request can be edited; this one has been approved.');
      await tx.query(
        'client_requests',
        `UPDATE client_requests SET
            title = COALESCE($3, title), message = COALESCE($4, message),
            recipient_name = CASE WHEN $5::boolean THEN $6 ELSE recipient_name END,
            recipient_email = CASE WHEN $7::boolean THEN $8 ELSE recipient_email END,
            updated_at = now()
          WHERE id = $1 AND org_id = $2`,
        [
          requestId,
          orgId,
          input.title ?? null,
          input.message ?? null,
          input.recipientName !== undefined,
          input.recipientName ?? null,
          input.recipientEmail !== undefined,
          input.recipientEmail?.toLowerCase() ?? null,
        ],
      );
      if (input.items) await replaceItems(tx, orgId, requestId, input.items);
    });
    return this.detail(orgId, requestId);
  }

  private async newLink(tx: Tx, orgId: string, userId: string, requestId: string, days: number): Promise<{ token: string; expiresAt: Date }> {
    await tx.query('upload_links', 'UPDATE upload_links SET revoked_at = now(), revoked_by = $3 WHERE request_id = $1 AND org_id = $2 AND revoked_at IS NULL', [
      requestId,
      orgId,
      userId,
    ]);
    const t = newOpaqueToken();
    const [link] = await tx.query<{ expires_at: Date }>(
      'upload_links',
      `INSERT INTO upload_links (org_id, request_id, token_hash, expires_at, max_files, created_by)
       VALUES ($1, $2, $3, now() + make_interval(days => $4::int), $5, $6) RETURNING expires_at`,
      [orgId, requestId, t.hash, days, config.clientUploads.maxFilesPerLink, userId],
    );
    return { token: t.token, expiresAt: link.expires_at };
  }

  /**
   * Approve a draft: it becomes open, an upload link is issued, and the approved message
   * is emailed to the recipient when there is one. The link is returned once.
   */
  async approve(
    orgId: string,
    userId: string,
    requestId: string,
    days: number,
  ): Promise<{ request: RequestDetail; link: { url: string; token: string; expiresAt: string } }> {
    const issued = await dataService.transaction({ orgId, userId }, async (tx) => {
      const [r] = await tx.query<{ status: RequestStatus; items: number }>(
        'client_requests',
        `SELECT status, (SELECT count(*)::int FROM client_request_items i WHERE i.request_id = r.id AND i.org_id = r.org_id) AS items
           FROM client_requests r WHERE r.id = $1 AND r.org_id = $2 FOR UPDATE`,
        [requestId, orgId],
      );
      if (!r) throw notFound();
      if (r.status !== 'draft') throw new AppError(409, ErrorCodes.REQUEST_NOT_DRAFT, 'This request has already been approved.');
      if (r.items === 0)
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Add at least one item before approving', [{ field: 'items', message: 'Required' }]);
      await tx.query(
        'client_requests',
        `UPDATE client_requests SET status = 'open', approved_by = $3, approved_at = now(), updated_at = now() WHERE id = $1 AND org_id = $2`,
        [requestId, orgId, userId],
      );
      return this.newLink(tx, orgId, userId, requestId, days);
    });
    await this.email(orgId, requestId, issued.token, issued.expiresAt);
    return {
      request: await this.detail(orgId, requestId),
      link: { url: linkUrl(issued.token), token: issued.token, expiresAt: issued.expiresAt.toISOString() },
    };
  }

  /** A new link for an open request (the old one stops working). */
  async reissueLink(
    orgId: string,
    userId: string,
    requestId: string,
    days: number,
  ): Promise<{ request: RequestDetail; link: { url: string; token: string; expiresAt: string } }> {
    const issued = await dataService.transaction({ orgId, userId }, async (tx) => {
      const [r] = await tx.query<{ status: RequestStatus }>('client_requests', 'SELECT status FROM client_requests WHERE id = $1 AND org_id = $2 FOR UPDATE', [
        requestId,
        orgId,
      ]);
      if (!r) throw notFound();
      if (r.status !== 'open') throw new AppError(409, ErrorCodes.REQUEST_NOT_OPEN, 'Approve the request first; a link is issued when it is approved.');
      return this.newLink(tx, orgId, userId, requestId, days);
    });
    return {
      request: await this.detail(orgId, requestId),
      link: { url: linkUrl(issued.token), token: issued.token, expiresAt: issued.expiresAt.toISOString() },
    };
  }

  async revokeLink(orgId: string, userId: string, requestId: string): Promise<RequestDetail> {
    const rows = await dataService.query<{ id: string }>(
      { orgId, userId },
      'upload_links',
      'UPDATE upload_links SET revoked_at = now(), revoked_by = $3 WHERE request_id = $1 AND org_id = $2 AND revoked_at IS NULL RETURNING id',
      [requestId, orgId, userId],
    );
    if (!rows.length) {
      await this.detail(orgId, requestId); // 404 when the request does not exist
      throw new AppError(409, ErrorCodes.REQUEST_NOT_OPEN, 'This request has no active link to revoke.');
    }
    return this.detail(orgId, requestId);
  }

  /** Email the approved message with the link. Delivery is recorded; a failure never undoes the approval. */
  private async email(orgId: string, requestId: string, token: string, expiresAt: Date): Promise<void> {
    const [r] = await dataService.query<{ title: string; message: string; recipient_email: string | null; recipient_name: string | null; firm: string }>(
      { orgId },
      'client_requests',
      `SELECT r.title, r.message, r.recipient_email, r.recipient_name, o.name AS firm
         FROM client_requests r JOIN orgs o ON o.id = r.org_id WHERE r.id = $1 AND r.org_id = $2`,
      [requestId, orgId],
    );
    if (!r?.recipient_email) return;
    const items = await dataService.query<{ label: string; detail: string }>(
      { orgId },
      'client_request_items',
      'SELECT label, detail FROM client_request_items WHERE request_id = $1 AND org_id = $2 ORDER BY position',
      [requestId, orgId],
    );
    const text = [
      r.recipient_name ? `Dear ${r.recipient_name},` : 'Hello,',
      '',
      r.message.trim(),
      '',
      'Requested:',
      ...items.map((i, n) => `${n + 1}. ${i.label}${i.detail ? ` - ${i.detail}` : ''}`),
      '',
      `Upload the files here (no account needed; works on a phone): ${linkUrl(token)}`,
      `The link works until ${expiresAt.toUTCString()}.`,
      '',
      r.firm,
    ].join('\n');
    try {
      await mailService.send({ to: r.recipient_email, subject: `${r.firm}: ${r.title}`, text });
      await dataService.query(
        { orgId },
        'client_requests',
        "UPDATE client_requests SET email_status = 'sent', email_error = NULL, emailed_at = now() WHERE id = $1 AND org_id = $2",
        [requestId, orgId],
      );
    } catch (err) {
      await dataService.query(
        { orgId },
        'client_requests',
        "UPDATE client_requests SET email_status = 'failed', email_error = $3 WHERE id = $1 AND org_id = $2",
        [requestId, orgId, (err as Error).message.slice(0, 500)],
      );
    }
  }

  // ---------------------------------------------------------------- public (the token is the credential)

  private async activeLink(token: string) {
    const [link] = await dataService.transaction({}, (tx) =>
      tx.lookupByToken<{
        id: string;
        org_id: string;
        request_id: string;
        expires_at: Date;
        revoked_at: Date | null;
        files_received: number;
        max_files: number;
        status: RequestStatus;
        project_id: string;
        title: string;
        message: string;
        approved_by: string | null;
        created_by: string | null;
        firm: string;
      }>(
        'upload_links',
        `SELECT l.id, l.org_id, l.request_id, l.expires_at, l.revoked_at, l.files_received, l.max_files,
                r.status, r.project_id, r.title, r.message, r.approved_by, r.created_by, o.name AS firm
           FROM upload_links l
           JOIN client_requests r ON r.id = l.request_id AND r.org_id = l.org_id
           JOIN orgs o ON o.id = l.org_id
          WHERE l.token_hash = $1 AND o.status = 'active'`,
        [hashToken(token)],
      ),
    );
    if (!link) throw new AppError(404, ErrorCodes.NOT_FOUND, 'This upload link is not valid. Check the link in the message you received.');
    if (link.revoked_at || link.expires_at <= new Date() || link.status !== 'open') {
      throw new AppError(
        410,
        ErrorCodes.UPLOAD_LINK_INACTIVE,
        `This upload link has ${link.revoked_at ? 'been withdrawn' : 'expired'}. Please ask ${link.firm} for a new one.`,
      );
    }
    return link;
  }

  /** What the client sees on the upload page. */
  async publicView(token: string) {
    const link = await this.activeLink(token);
    const items = await dataService.query<{ id: string; label: string; detail: string; status: RequestItem['status'] }>(
      { orgId: link.org_id },
      'client_request_items',
      'SELECT id, label, detail, status FROM client_request_items WHERE request_id = $1 AND org_id = $2 ORDER BY position',
      [link.request_id, link.org_id],
    );
    return {
      firmName: link.firm,
      title: link.title,
      message: link.message,
      items,
      expiresAt: link.expires_at.toISOString(),
      filesRemaining: Math.max(0, link.max_files - link.files_received),
      maxFileBytes: config.clientUploads.maxBytes,
      accepted: { label: ACCEPTED_LABEL, extensions: ACCEPTED_EXTENSIONS },
    };
  }

  /** A client upload: check the link, the file type and size, scan it, then record it. */
  async publicUpload(token: string, input: { name: string; bytes: Buffer; mimeType?: string; itemId?: string }) {
    const link = await this.activeLink(token);
    if (link.files_received >= link.max_files) {
      throw new AppError(
        409,
        ErrorCodes.UPLOAD_LIMIT_REACHED,
        `This link has reached its limit of ${link.max_files} files. Please ask ${link.firm} for a new link.`,
      );
    }
    if (input.itemId) {
      const [item] = await dataService.query<{ id: string }>(
        { orgId: link.org_id },
        'client_request_items',
        'SELECT id FROM client_request_items WHERE id = $1 AND request_id = $2 AND org_id = $3',
        [input.itemId, link.request_id, link.org_id],
      );
      if (!item) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'That item is not part of this request', [{ field: 'item', message: 'Unknown item' }]);
    }
    assertAcceptedUpload(input.name, input.bytes);
    const scan = await scanUpload(input.bytes);
    const recorder = link.approved_by ?? link.created_by;
    if (!recorder) throw new AppError(410, ErrorCodes.UPLOAD_LINK_INACTIVE, `This upload link is no longer valid. Please ask ${link.firm} for a new one.`);
    const { file, unchanged } = await fileService.recordVersion({
      orgId: link.org_id,
      userId: recorder,
      projectId: link.project_id,
      source: 'request',
      name: input.name,
      mimeType: input.mimeType,
      bytes: input.bytes,
      scanStatus: scan.status,
    });
    await dataService.transaction({ orgId: link.org_id }, async (tx) => {
      await tx.query('upload_links', 'UPDATE upload_links SET files_received = files_received + 1, last_used_at = now() WHERE id = $1 AND org_id = $2', [
        link.id,
        link.org_id,
      ]);
      if (input.itemId) {
        await tx.query(
          'client_request_items',
          `UPDATE client_request_items SET status = 'received', received_at = COALESCE(received_at, now()), received_count = received_count + 1
            WHERE id = $1 AND org_id = $2`,
          [input.itemId, link.org_id],
        );
      }
      await tx.query('client_requests', 'UPDATE client_requests SET updated_at = now() WHERE id = $1 AND org_id = $2', [link.request_id, link.org_id]);
    });
    await auditService.record({
      orgId: link.org_id,
      actorUserId: null,
      action: 'client_request.file_received',
      targetType: 'client_request',
      targetId: link.request_id,
      projectId: link.project_id,
      metadata: { fileId: file.id, versionNo: file.latest?.versionNo ?? null, itemId: input.itemId ?? null, unchanged, scan: scan.status, via: 'upload_link' },
    });
    // Read and index it like any other file (the worker does this when docproc is configured).
    if (!unchanged && file.latest && config.docproc.serviceKey) {
      const versionId = file.latest.id;
      setImmediate(() => {
        processVersion(link.org_id, versionId).catch((err) => console.error(`[requests] parse of ${versionId} failed: ${(err as Error).message}`));
      });
    }
    return { received: true, fileName: file.name, alreadyReceived: unchanged, scan: scan.status, itemId: input.itemId ?? null };
  }
}

export const requestService = new RequestService();
