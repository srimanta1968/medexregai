import { AppError, ErrorCodes } from '../utils/AppError';
import { pageSize } from '../utils/pagination';
import { dataService } from './DataService';

/** One audit record. seq, prev_hash, hash and created_at are set by the database. */
export interface AuditEventInput {
  orgId: string;
  actorUserId: string | null;
  /** dotted, lower-case verb: project.viewed, draft.accepted, export.created ... */
  action: string;
  targetType: string;
  targetId?: string | null;
  workspaceId?: string | null;
  projectId?: string | null;
  /** Small, content-free context (ids, formats, counts). Never client content. */
  metadata?: Record<string, unknown>;
}

export interface AuditEventView {
  seq: number;
  action: string;
  targetType: string;
  targetId: string | null;
  actor: { id: string | null; name: string | null };
  metadata: Record<string, unknown>;
  createdAt: string;
}

export class AuditService {
  async record(e: AuditEventInput): Promise<void> {
    await dataService.query(
      { orgId: e.orgId, userId: e.actorUserId ?? undefined },
      'audit_events',
      `INSERT INTO audit_events (org_id, actor_user_id, action, target_type, target_id, workspace_id, project_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [e.orgId, e.actorUserId, e.action, e.targetType, e.targetId ?? null, e.workspaceId ?? null, e.projectId ?? null, JSON.stringify(e.metadata ?? {})]
    );
  }
}

/** Activity cursor is the chain position: "<seq>" base64url (seq is unique per firm). */
function decodeSeq(cursor: string | undefined): number | null {
  if (!cursor) return null;
  const n = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'cursor is invalid');
  }
  return n;
}

export async function projectActivity(
  ctx: { orgId: string; userId: string },
  projectId: string,
  opts: { limit?: number; cursor?: string }
): Promise<{ items: AuditEventView[]; nextCursor: string | null }> {
  const size = pageSize(opts.limit);
  const before = decodeSeq(opts.cursor);
  const exists = await dataService.query(ctx, 'projects', 'SELECT 1 FROM projects WHERE id = $1 AND org_id = $2', [projectId, ctx.orgId]);
  if (!exists[0]) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
  }
  const rows = await dataService.query<{
    seq: string;
    action: string;
    target_type: string;
    target_id: string | null;
    actor_user_id: string | null;
    actor_name: string | null;
    metadata: Record<string, unknown>;
    created_at: Date;
  }>(
    ctx,
    'audit_events',
    `SELECT e.seq, e.action, e.target_type, e.target_id, e.actor_user_id, p.full_name AS actor_name, e.metadata, e.created_at
       FROM audit_events e LEFT JOIN user_profiles p ON p.user_id = e.actor_user_id
      WHERE e.org_id = $1 AND e.project_id = $2 AND ($3::bigint IS NULL OR e.seq < $3)
      ORDER BY e.seq DESC LIMIT $4`,
    [ctx.orgId, projectId, before, size + 1]
  );
  const page = rows.slice(0, size);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      seq: Number(r.seq),
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      actor: { id: r.actor_user_id, name: r.actor_name },
      metadata: r.metadata,
      createdAt: new Date(r.created_at).toISOString(),
    })),
    nextCursor: rows.length > size && last ? Buffer.from(String(last.seq)).toString('base64url') : null,
  };
}

/** Integrity of the firm's audit chain: recomputes every hash in order. */
export async function verifyFirmChain(ctx: { orgId: string; userId: string }): Promise<{
  intact: boolean;
  events: number;
  brokenAtSeq: number | null;
  reason: string | null;
  checkedAt: string;
}> {
  const [count] = await dataService.query<{ n: string }>(ctx, 'audit_events', 'SELECT count(*) AS n FROM audit_events WHERE org_id = $1', [ctx.orgId]);
  const broken = await dataService.query<{ broken_seq: string; reason: string }>(
    ctx,
    'audit_events',
    'SELECT broken_seq, reason FROM audit_verify_chain($1)',
    [ctx.orgId]
  );
  return {
    intact: broken.length === 0,
    events: Number(count.n),
    brokenAtSeq: broken[0] ? Number(broken[0].broken_seq) : null,
    reason: broken[0]?.reason ?? null,
    checkedAt: new Date().toISOString(),
  };
}

export const auditService = new AuditService();
