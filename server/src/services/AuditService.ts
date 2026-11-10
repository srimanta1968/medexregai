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

export const auditService = new AuditService();
