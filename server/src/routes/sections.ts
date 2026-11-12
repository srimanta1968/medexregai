import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { audit, fromParam } from '../middleware/audit';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { Permission, requirePermission } from '../middleware/authorize';
import { SECTION_STATUSES, SectionStatus, sectionService } from '../sections/SectionService';
import { AppError, ErrorCodes } from '../utils/AppError';

/**
 * F3.1 review board.
 *   GET   /api/projects/:projectId/sections         every section with status, reviewer, files, open problems; and who can review
 *   PATCH /api/project-sections/:sectionId          { status?, reviewerId?, note? }
 *   GET   /api/project-sections/:sectionId/history  status changes and reviewer assignments
 * Permission per change is checked in SectionService (write to move along, review to approve).
 */
export const sectionsRouter = Router();

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
const updateBody = z
  .object({
    status: z.enum(SECTION_STATUSES as unknown as [SectionStatus, ...SectionStatus[]], {
      errorMap: () => ({ message: `status must be one of ${SECTION_STATUSES.join(', ')}` }),
    }).optional(),
    reviewerId: uuid('reviewerId').nullable().optional(),
    note: z.string().trim().max(1000, 'note must be at most 1000 characters').optional(),
  })
  .strict()
  .refine((v) => v.status !== undefined || v.reviewerId !== undefined, 'Nothing to change: send status or reviewerId');

sectionsRouter.get(
  '/api/projects/:projectId/sections',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await sectionService.board(orgId, parse(uuid('projectId'), req.params.projectId)) });
  }),
);

sectionsRouter.patch(
  '/api/project-sections/:sectionId',
  guard('projects:read'),
  audit('section.updated', { targetType: 'project_section', targetId: fromParam('sectionId') }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    const body = parse(updateBody, req.body);
    res.status(200).json({ success: true, data: await sectionService.update(orgId, userId, parse(uuid('sectionId'), req.params.sectionId), body) });
  }),
);

sectionsRouter.get(
  '/api/project-sections/:sectionId/history',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await sectionService.history(orgId, parse(uuid('sectionId'), req.params.sectionId)) });
  }),
);
