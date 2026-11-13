import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { audit, fromParam } from '../middleware/audit';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { Permission, requirePermission } from '../middleware/authorize';
import { impactService } from '../impact/ImpactService';
import { AppError, ErrorCodes } from '../utils/AppError';

/**
 * F3.3 revision impact.
 *   GET  /api/projects/:projectId/revisions             new file versions, newest first, with how much relied on the old one
 *   GET  /api/file-versions/:versionId/impact           what the version affects: drafts, problems, request items; changed facts
 *   POST /api/file-versions/:versionId/impact/actions   { itemKey, action } carry out the consultant's choice for one item
 * Acting needs projects:write (checked in ImpactService); reading needs projects:read.
 */
export const impactRouter = Router();

const handle =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };
const guard = (permission: Permission) => [authenticate, requirePermission(permission)];

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new AppError(
      400,
      ErrorCodes.VALIDATION_ERROR,
      r.error.issues[0]?.message ?? 'Invalid request',
      r.error.issues.map((i) => ({ field: i.path.join('.') || 'body', message: i.message })),
    );
  }
  return r.data;
}

const uuid = (what: string) => z.string().uuid(`${what} must be a valid id`);
const actionBody = z
  .object({
    itemKey: z
      .string({ error: (iss) => (iss.input === undefined ? 'itemKey is required' : undefined) })
      .regex(/^(draft|problem|request_item):[0-9a-f-]{36}$/i, 'itemKey must be draft:<id>, problem:<id> or request_item:<id>'),
    action: z.enum(['redraft', 'recheck', 'mark_received', 'keep'], { error: 'action must be redraft, recheck, mark_received or keep' }),
  })
  .strict();

impactRouter.get(
  '/api/projects/:projectId/revisions',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await impactService.revisions(orgId, parse(uuid('projectId'), req.params.projectId)) });
  }),
);

impactRouter.get(
  '/api/file-versions/:versionId/impact',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await impactService.impact(orgId, parse(uuid('versionId'), req.params.versionId)) });
  }),
);

impactRouter.post(
  '/api/file-versions/:versionId/impact/actions',
  guard('projects:read'),
  audit('impact.action', { targetType: 'file_version', targetId: fromParam('versionId') }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    const versionId = parse(uuid('versionId'), req.params.versionId);
    const body = parse(actionBody, req.body);
    res.status(200).json({ success: true, data: await impactService.act(orgId, userId, versionId, body) });
  }),
);
