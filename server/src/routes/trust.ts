import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { audit, fromParam } from '../middleware/audit';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { Permission, requirePermission } from '../middleware/authorize';
import { PACKS, PackKey } from '../trust/content';
import { trustService } from '../trust/TrustService';
import { AppError, ErrorCodes } from '../utils/AppError';
import { pageSize } from '../utils/pagination';

/**
 * Trust pack (F2.5):
 *   GET   /api/trust-pack                               packs on offer, client clause, data-use settings
 *   GET   /api/trust-pack/documents/:pack               validation | data-handling, as PDF
 *   GET   /api/settings/data-use                        AI training (never) and product-improvement use
 *   PATCH /api/settings/data-use                        { productImprovement } (owner/admin)
 *   POST  /api/projects/:projectId/deletion             delete a project's data (owner/admin, typed confirmation), 202
 *   GET   /api/project-deletions                        the firm's deletions, newest first
 *   GET   /api/project-deletions/:deletionId            one deletion and its progress
 *   GET   /api/project-deletions/:deletionId/certificate  the deletion certificate, as PDF (409 until complete)
 */

type Handler = (req: Request, res: Response) => Promise<void>;
const handle =
  (fn: Handler) =>
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
const packKey = z.enum(Object.keys(PACKS) as [PackKey, ...PackKey[]], {
  error: `pack must be one of ${Object.keys(PACKS).join(', ')}`,
});
const dataUseBody = z
  .object(
    {
      productImprovement: z.boolean({ error: (iss) => (iss.input === undefined ? 'productImprovement is required' : 'productImprovement must be true or false') }),
    },
    { error: (iss) => (iss.code === 'unrecognized_keys' ? 'Only productImprovement can be changed; AI training on client data is never allowed' : undefined) },
  )
  .strict();
const deletionBody = z
  .object({ confirmName: z.string({ error: (iss) => (iss.input === undefined ? 'confirmName is required' : undefined) }).trim().min(1, 'confirmName is required').max(200) })
  .strict();
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).optional(), cursor: z.string().max(200).optional() });

function sendPdf(res: Response, fileName: string, bytes: Buffer): void {
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${fileName}"`);
  res.set('Cache-Control', 'no-store');
  res.set('Content-Length', String(bytes.length));
  res.status(200).end(bytes);
}

export const trustRouter = Router();

trustRouter.get(
  '/api/trust-pack',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await trustService.summary(orgId) });
  }),
);

trustRouter.get(
  '/api/trust-pack/documents/:pack',
  guard('projects:read'),
  audit('trust_pack.downloaded', { targetType: 'trust_pack', metadata: (req) => ({ pack: req.params.pack }) }),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    const { fileName, bytes } = await trustService.packPdf(orgId, parse(packKey, req.params.pack));
    sendPdf(res, fileName, bytes);
  }),
);

trustRouter.get(
  '/api/settings/data-use',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await trustService.dataUse(orgId) });
  }),
);

trustRouter.patch(
  '/api/settings/data-use',
  guard('firm:manage'),
  audit('firm.data_use_updated', { targetType: 'org', metadata: (_req, data) => ({ productImprovement: data?.productImprovement ?? null }) }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    const { productImprovement } = parse(dataUseBody, req.body ?? {});
    res.status(200).json({ success: true, data: await trustService.updateDataUse(orgId, userId, productImprovement) });
  }),
);

trustRouter.post(
  '/api/projects/:projectId/deletion',
  guard('firm:manage'),
  audit('project.deleted', {
    targetType: 'project',
    targetId: fromParam('projectId'),
    projectId: fromParam('projectId'),
    metadata: (_req, data) => ({ deletionId: data?.id ?? null }),
  }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    const projectId = parse(uuid('projectId'), req.params.projectId);
    const { confirmName } = parse(deletionBody, req.body ?? {});
    const deletion = await trustService.requestDeletion(orgId, userId, projectId, confirmName);
    res.status(202).json({ success: true, data: deletion });
    // Remove the stored files now; the worker retries anything left (and is the only path after a restart).
    setImmediate(() => {
      trustService.processDeletion(orgId, deletion.id).catch((err: unknown) => {
        console.error(`[trust] deletion ${deletion.id}: removing stored files failed, the worker will retry: ${(err as Error).message}`);
      });
    });
  }),
);

trustRouter.get(
  '/api/project-deletions',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    const q = parse(listQuery, req.query);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await trustService.deletions(orgId, pageSize(q.limit), q.cursor) });
  }),
);

trustRouter.get(
  '/api/project-deletions/:deletionId',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await trustService.deletion(orgId, parse(uuid('deletionId'), req.params.deletionId)) });
  }),
);

trustRouter.get(
  '/api/project-deletions/:deletionId/certificate',
  guard('projects:read'),
  audit('deletion_certificate.downloaded', { targetType: 'project_deletion', targetId: fromParam('deletionId') }),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    const { fileName, bytes, sha256 } = await trustService.certificatePdf(orgId, parse(uuid('deletionId'), req.params.deletionId));
    res.set('X-Certificate-SHA256', sha256);
    sendPdf(res, fileName, bytes);
  }),
);
