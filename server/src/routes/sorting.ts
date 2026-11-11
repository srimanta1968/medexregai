import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { audit, fromParam } from '../middleware/audit';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { Permission, requirePermission } from '../middleware/authorize';
import { sortingService } from '../sorting/SortingService';
import { AppError, ErrorCodes } from '../utils/AppError';
import { pageSize } from '../utils/pagination';

/**
 * F2.2 sorted folder and eSTAR map (a "submission" is a project here).
 *   GET /api/estar-sections                         FDA eSTAR sections (reference data)
 *   GET /api/projects/:projectId/sorted-files       files with section, confidence, source and reason (?section=<id>|none)
 *   GET /api/projects/:projectId/estar-coverage     every evidence section with its file count, and the first-hour checklist
 *   PUT /api/files/:fileId/assignment               a consultant files it ({ sectionId } or null); the sorter learns from it
 */
export const sortingRouter = Router();

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
const sectionId = z.string().regex(/^[a-z_]{2,40}$/, 'section must be an eSTAR section id');
const listQuery = z.object({
  limit: z.coerce.number().int('limit must be a whole number').min(1, 'limit must be at least 1').max(50, 'limit must be at most 50').optional(),
  cursor: z.string().max(200, 'cursor is invalid').optional(),
  section: sectionId.optional(),
});
const assignBody = z.object({ sectionId: sectionId.nullable() }).strict();

sortingRouter.get(
  '/api/estar-sections',
  guard('projects:read'),
  handle(async (_req, res) => {
    res.set('Cache-Control', 'private, max-age=3600');
    res.status(200).json({ success: true, data: await sortingService.sections() });
  }),
);

sortingRouter.get(
  '/api/projects/:projectId/sorted-files',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    const q = parse(listQuery, req.query);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({
      success: true,
      data: await sortingService.files(orgId, parse(uuid('projectId'), req.params.projectId), pageSize(q.limit), q.cursor, q.section),
    });
  }),
);

sortingRouter.get(
  '/api/projects/:projectId/estar-coverage',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await sortingService.coverage(orgId, parse(uuid('projectId'), req.params.projectId)) });
  }),
);

sortingRouter.put(
  '/api/files/:fileId/assignment',
  guard('projects:write'),
  audit('file.section_assigned', { targetType: 'file', targetId: fromParam('fileId') }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    const body = parse(assignBody, req.body);
    res.status(200).json({ success: true, data: await sortingService.reassign(orgId, userId, parse(uuid('fileId'), req.params.fileId), body.sectionId) });
  }),
);
