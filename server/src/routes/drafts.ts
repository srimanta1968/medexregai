import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { audit, fromParam } from '../middleware/audit';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { Permission, requirePermission } from '../middleware/authorize';
import { draftService } from '../drafting/DraftService';
import { AppError, ErrorCodes } from '../utils/AppError';

/**
 * F3.2 drafts of a section.
 *   POST /api/project-sections/:sectionId/draft          queue a generated draft (202)
 *   GET  /api/project-sections/:sectionId/draft          latest draft (or ?version=n) and every version
 *   GET  /api/project-sections/:sectionId/draft/export   the latest ready draft (or ?version=n) as .docx
 *   POST /api/project-sections/:sectionId/draft/import   { fileName, contentBase64 } an edited export -> new version (201)
 *   POST /api/project-sections/:sectionId/draft/fda-check re-check the draft's predicate K-numbers against FDA data (202)
 * Drafting and importing need projects:write (checked in DraftService); reading needs projects:read.
 */
export const draftsRouter = Router();

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

const sectionId = (req: Request): string => parse(z.string().uuid('sectionId must be a valid id'), req.params.sectionId);
const versionQuery = z.object({ version: z.coerce.number({ error: (iss) => (iss.input === undefined ? undefined : 'version must be a number') }).int().min(1, 'version must be 1 or more').optional() });
const importBody = z
  .object({
    fileName: z.string({ error: (iss) => (iss.input === undefined ? 'fileName is required' : undefined) }).trim().min(1, 'fileName is required').max(255, 'fileName must be at most 255 characters'),
    contentBase64: z
      .string({ error: (iss) => (iss.input === undefined ? 'contentBase64 is required' : undefined) })
      .min(1, 'contentBase64 is required')
      .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'contentBase64 must be base64'),
  })
  .strict();

draftsRouter.post(
  '/api/project-sections/:sectionId/draft',
  guard('projects:read'),
  audit('draft.requested', { targetType: 'project_section', targetId: fromParam('sectionId') }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    res.status(202).json({ success: true, data: await draftService.request(orgId, userId, sectionId(req)) });
  }),
);

draftsRouter.get(
  '/api/project-sections/:sectionId/draft',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    const id = sectionId(req);
    const { version } = parse(versionQuery, req.query);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await draftService.current(orgId, id, version) });
  }),
);

draftsRouter.get(
  '/api/project-sections/:sectionId/draft/export',
  guard('projects:read'),
  audit('draft.exported', { targetType: 'project_section', targetId: fromParam('sectionId') }),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    const id = sectionId(req);
    const { version } = parse(versionQuery, req.query);
    const { fileName, bytes } = await draftService.exportDocx(orgId, id, version);
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.set('Content-Disposition', `attachment; filename="${fileName}"`);
    res.set('Cache-Control', 'no-store');
    res.set('Content-Length', String(bytes.length));
    res.status(200).end(bytes);
  }),
);

draftsRouter.post(
  '/api/project-sections/:sectionId/draft/import',
  guard('projects:read'),
  audit('draft.imported', { targetType: 'project_section', targetId: fromParam('sectionId') }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    const id = sectionId(req);
    const body = parse(importBody, req.body);
    res.status(201).json({ success: true, data: await draftService.importDocx(orgId, userId, id, body) });
  }),
);

draftsRouter.post(
  '/api/project-sections/:sectionId/draft/fda-check',
  guard('projects:read'),
  audit('draft.fda_check_requested', { targetType: 'project_section', targetId: fromParam('sectionId') }),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    const id = sectionId(req);
    const { version } = parse(versionQuery, req.query);
    res.status(202).json({ success: true, data: await draftService.recheckFda(orgId, id, version) });
  }),
);
