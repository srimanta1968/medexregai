import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { audit, fromParam } from '../middleware/audit';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { Permission, requirePermission } from '../middleware/authorize';
import { RECORD_KINDS, RecordKind, recordService } from '../records/RecordService';
import { AppError, ErrorCodes } from '../utils/AppError';

/**
 * F3.4 dated records for the eQMS.
 *   GET /api/projects/:projectId/records/:kind?format=pdf|docx   generate and download (kind: project_record | problem_log | request_log)
 *   GET /api/projects/:projectId/records                         every record generated, with its SHA-256
 * Each download is logged (record_exports) with the hash of the exact bytes, which is also sent
 * in the X-Record-SHA256 header.
 */
export const recordsRouter = Router();

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
const kind = z.enum(RECORD_KINDS as unknown as [RecordKind, ...RecordKind[]], { error: `kind must be one of ${RECORD_KINDS.join(', ')}` });
const formatQuery = z.object({ format: z.enum(['pdf', 'docx'], { error: 'format must be pdf or docx' }).optional() });

recordsRouter.get(
  '/api/projects/:projectId/records',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await recordService.history(orgId, projectId(req)) });
  }),
);

recordsRouter.get(
  '/api/projects/:projectId/records/:kind',
  guard('projects:read'),
  audit('record.generated', { targetType: 'project', targetId: fromParam('projectId') }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    const id = projectId(req);
    const k = parse(kind, req.params.kind);
    const { format } = parse(formatQuery, req.query);
    const out = await recordService.generate(orgId, userId, id, k, format ?? 'pdf');
    res.set('Content-Type', out.contentType);
    res.set('Content-Disposition', `attachment; filename="${out.fileName}"`);
    res.set('X-Record-SHA256', out.record.sha256);
    res.set('Access-Control-Expose-Headers', 'X-Record-SHA256, Content-Disposition');
    res.set('Cache-Control', 'no-store');
    res.set('Content-Length', String(out.bytes.length));
    res.status(200).end(out.bytes);
  }),
);
