import { NextFunction, Request, Response } from 'express';
import { auditService } from '../services/AuditService';

/**
 * How the interceptor finds what an action was about. Each resolver reads the
 * request (params) or the JSON the route sent (body.data), so the route itself
 * does not need to know about auditing.
 */
export interface AuditTarget {
  targetType: string;
  targetId?: (req: Request, data: Record<string, unknown> | undefined) => string | undefined;
  projectId?: (req: Request, data: Record<string, unknown> | undefined) => string | undefined;
  workspaceId?: (req: Request, data: Record<string, unknown> | undefined) => string | undefined;
  metadata?: (req: Request, data: Record<string, unknown> | undefined) => Record<string, unknown>;
  /** Record only when this returns true (e.g. a download, not its preview). Default: always. */
  when?: (req: Request) => boolean;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Common resolvers. */
export const fromParam = (name: string) => (req: Request) => str(req.params[name]);
export const fromData = (key: string) => (_req: Request, data: Record<string, unknown> | undefined) => str(data?.[key]);

/**
 * Record `action` in the firm's hash-chained audit log once the route has answered
 * 2xx. Runs after `authenticate` (needs req.auth). Recording happens after the
 * response so a view is never slowed down; a failure to record is logged loudly,
 * never swallowed silently.
 */
export function audit(action: string, target: AuditTarget) {
  return (req: Request, res: Response, next: NextFunction): void => {
    let data: Record<string, unknown> | undefined;
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      const payload = body as { data?: unknown } | undefined;
      if (payload && typeof payload.data === 'object' && payload.data !== null) {
        data = payload.data as Record<string, unknown>;
      }
      return json(body);
    };

    res.on('finish', () => {
      const auth = req.auth;
      if (!auth || res.statusCode < 200 || res.statusCode >= 300 || (target.when && !target.when(req))) {
        return;
      }
      auditService
        .record({
          orgId: auth.orgId,
          actorUserId: auth.userId,
          action,
          targetType: target.targetType,
          targetId: target.targetId?.(req, data) ?? null,
          projectId: target.projectId?.(req, data) ?? null,
          workspaceId: target.workspaceId?.(req, data) ?? null,
          metadata: target.metadata?.(req, data) ?? {},
        })
        .catch((err: unknown) => {
          console.error(`[audit] FAILED to record ${action} for org ${auth.orgId}: ${(err as Error).message}`);
        });
    });
    next();
  };
}
