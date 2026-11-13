import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { audit, fromParam } from '../middleware/audit';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { Permission, requirePermission } from '../middleware/authorize';
import { ESTAR_RULES, ESTAR_TEMPLATE_KEYS } from '../readiness/estarRules';
import { readinessService } from '../readiness/ReadinessService';
import { AppError, ErrorCodes } from '../utils/AppError';

/**
 * F3.4 readiness.
 *   GET /api/estar-templates                        the eSTAR templates checks can follow, with their rules and FDA source
 *   GET /api/projects/:projectId/readiness          attachment checks against the project's template, with the running total
 *   PUT /api/projects/:projectId/estar-template     { template } choose the template the project is checked against
 */
export const readinessRouter = Router();

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

const projectId = (req: Request): string => parse(z.string().uuid('projectId must be a valid id'), req.params.projectId);
const templateBody = z
  .object({
    template: z.enum(ESTAR_TEMPLATE_KEYS as [string, ...string[]], { error: `template must be one of ${ESTAR_TEMPLATE_KEYS.join(', ')}` }),
  })
  .strict();

readinessRouter.get(
  '/api/estar-templates',
  authenticate,
  handle(async (_req, res) => {
    res.status(200).json({
      success: true,
      data: ESTAR_RULES.map((r) => ({
        key: r.key,
        label: r.label,
        maxNameChars: r.maxNameChars,
        maxAttachmentBytes: r.maxAttachmentBytes,
        maxTotalBytes: r.maxTotalBytes,
        rejectedExtensions: r.rejectedExtensions,
        source: r.source,
      })),
    });
  }),
);

readinessRouter.get(
  '/api/projects/:projectId/readiness',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await readinessService.check(orgId, projectId(req)) });
  }),
);

readinessRouter.put(
  '/api/projects/:projectId/estar-template',
  guard('projects:write'),
  audit('project.estar_template_set', { targetType: 'project', targetId: fromParam('projectId') }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    const id = projectId(req);
    const { template } = parse(templateBody, req.body);
    res.status(200).json({ success: true, data: await readinessService.setTemplate(orgId, userId, id, template) });
  }),
);
