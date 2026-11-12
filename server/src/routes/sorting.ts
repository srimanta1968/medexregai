import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { audit, fromParam } from '../middleware/audit';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { Permission, requirePermission } from '../middleware/authorize';
import { problemEngine } from '../problems/ProblemEngine';
import { revisionDetector } from '../sorting/RevisionDetector';
import { sortingService } from '../sorting/SortingService';
import { AppError, ErrorCodes } from '../utils/AppError';
import { pageSize } from '../utils/pagination';

/**
 * F2.2 sorted folder and eSTAR map (a "submission" is a project here).
 *   GET /api/estar-sections                         FDA eSTAR sections (reference data)
 *   GET /api/projects/:projectId/sorted-files       files with section, confidence, source and reason (?section=<id>|none)
 *   GET /api/projects/:projectId/estar-coverage     every evidence section with its file count, and the first-hour checklist
 *   PUT /api/files/:fileId/assignment               a consultant files it ({ sectionId } or null); the sorter learns from it
 *   GET /api/projects/:projectId/version-groups     revisions and copies of the same document; unclear ones need a decision
 *   POST /api/projects/:projectId/version-groups/:groupId/current  { fileId }: the consultant says which is current
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

sortingRouter.get(
  '/api/projects/:projectId/version-groups',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await revisionDetector.list(orgId, parse(uuid('projectId'), req.params.projectId)) });
  }),
);

const currentBody = z.object({ fileId: uuid('fileId') }).strict();

sortingRouter.post(
  '/api/projects/:projectId/version-groups/:groupId/current',
  guard('projects:write'),
  audit('file.version_confirmed', { targetType: 'version_group', targetId: fromParam('groupId') }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    const projectId = parse(uuid('projectId'), req.params.projectId);
    const groupId = parse(uuid('groupId'), req.params.groupId);
    const body = parse(currentBody, req.body);
    await revisionDetector.confirm(orgId, userId, projectId, groupId, body.fileId);
    // Superseded files no longer count in contradictions.
    await problemEngine.detect(orgId, projectId).catch((err) => console.warn(`[problems] re-check after version choice failed: ${(err as Error).message}`));
    const group = (await revisionDetector.list(orgId, projectId)).find((g) => g.id === groupId);
    res.status(200).json({ success: true, data: group });
  }),
);
