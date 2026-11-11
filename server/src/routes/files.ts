import express, { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { config } from '../config/env';
import { processVersion } from '../ingest/IngestService';
import { fileService } from '../ingest/FileService';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { audit, fromData, fromParam } from '../middleware/audit';
import { Permission, requirePermission } from '../middleware/authorize';
import { AppError, ErrorCodes } from '../utils/AppError';
import { scanUpload } from '../storage/malwareScan';
import { pageSize } from '../utils/pagination';

/**
 * Project files (F7.2): the file list with each file's ingest status, one file's
 * version history, the answer to a PHI warning, and a development-only upload.
 */

type Handler = (req: Request, res: Response) => Promise<void>;
const handle =
  (fn: Handler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };
const guard = (permission: Permission) => [authenticate, requirePermission(permission)];

const uuid = (what: string) => z.string().uuid(`${what} must be a valid id`);
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().max(200).optional(),
});
const phiDecision = z
  .object({ decision: z.enum(['redacted', 'accepted'], { errorMap: () => ({ message: 'decision must be redacted or accepted' }) }) })
  .strict();

const jsonUpload = z
  .object({
    fileName: z.string({ required_error: 'fileName is required' }).min(1, 'fileName is required').max(255, 'fileName must be at most 255 characters'),
    contentBase64: z
      .string({ required_error: 'contentBase64 is required' })
      .min(1, 'contentBase64 is required')
      .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'contentBase64 must be base64'),
    mimeType: z.string().max(127).nullish(),
  })
  .strict();

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

export const filesRouter = Router();

filesRouter.get(
  '/api/projects/:projectId/files',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    const projectId = parse(uuid('projectId'), req.params.projectId);
    const q = parse(listQuery, req.query);
    const page = await fileService.list(orgId, projectId, pageSize(q.limit), q.cursor);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: page });
  }),
);

/** F2.2: files that could not be read, each with the reason and what to do; never silently skipped. */
filesRouter.get(
  '/api/projects/:projectId/files/unreadable',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    const projectId = parse(uuid('projectId'), req.params.projectId);
    const q = parse(listQuery, req.query);
    const page = await fileService.unreadable(orgId, projectId, pageSize(q.limit), q.cursor);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: page });
  }),
);

filesRouter.get(
  '/api/files/:fileId',
  guard('projects:read'),
  audit('file.viewed', { targetType: 'file', targetId: fromParam('fileId'), projectId: fromData('projectId') }),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    const detail = await fileService.detail(orgId, parse(uuid('fileId'), req.params.fileId));
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: detail });
  }),
);

const passageQuery = z.object({
  from: z.coerce.number({ invalid_type_error: 'from must be a passage number' }).int().min(0, 'from must be 0 or more'),
  to: z.coerce.number({ invalid_type_error: 'to must be a passage number' }).int().min(0).optional(),
});

/** The passages a citation [C:<versionId>#from-to] points at, with context, for the source viewer. */
filesRouter.get(
  '/api/file-versions/:versionId/passages',
  guard('projects:read'),
  audit('file.passage_viewed', { targetType: 'file_version', targetId: fromParam('versionId'), projectId: fromData('projectId') }),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    const versionId = parse(uuid('versionId'), req.params.versionId);
    const q = parse(passageQuery, req.query);
    const to = q.to ?? q.from;
    if (to < q.from || to - q.from >= 50) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'to must be from..from+49', [{ field: 'to', message: 'must be from..from+49' }]);
    }
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await fileService.passages(orgId, versionId, q.from, to) });
  }),
);

filesRouter.patch(
  '/api/file-versions/:versionId/phi',
  guard('projects:write'),
  audit('file.phi_decision', { targetType: 'file_version', targetId: fromParam('versionId'), projectId: fromData('projectId') }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    const versionId = parse(uuid('versionId'), req.params.versionId);
    const { decision } = parse(phiDecision, req.body);
    res.status(200).json({ success: true, data: await fileService.decidePhi(orgId, userId, versionId, decision) });
  }),
);

/**
 * Development-only upload: the request body is the file's raw bytes.
 * Off unless DEV_UPLOADS=true (refused in production); F8.2 replaces it with
 * presigned uploads straight to object storage.
 */
filesRouter.post(
  '/api/projects/:projectId/files',
  guard('projects:write'),
  (req: Request, _res: Response, next: NextFunction) => {
    if (!config.devUploads.enabled) {
      next(
        new AppError(403, ErrorCodes.UPLOADS_DISABLED, 'Uploading through the API is turned off here; files arrive from connected folders or upload links.'),
      );
      return;
    }
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > config.devUploads.maxBytes) {
      next(new AppError(413, ErrorCodes.FILE_TOO_LARGE, `Files up to ${Math.floor(config.devUploads.maxBytes / (1024 * 1024))} MB can be uploaded`));
      return;
    }
    next();
  },
  express.raw({ type: () => true, limit: config.devUploads.maxBytes }),
  audit('file.uploaded', { targetType: 'file', targetId: fromData('id'), projectId: fromParam('projectId') }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    const projectId = parse(uuid('projectId'), req.params.projectId);
    let name = '';
    let bytes: Buffer;
    let mimeType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : undefined;
    if (Buffer.isBuffer(req.body)) {
      // Raw form (the browser): body = bytes, X-File-Name = URL-encoded name.
      const rawName = req.headers['x-file-name'];
      try {
        name = decodeURIComponent(typeof rawName === 'string' ? rawName : '');
      } catch {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'X-File-Name must be URL-encoded', [{ field: 'fileName', message: 'Must be URL-encoded' }]);
      }
      bytes = req.body;
    } else {
      // JSON form (scripts and API tests): { fileName, contentBase64, mimeType? }, within the JSON body limit.
      const body = parse(jsonUpload, req.body ?? {});
      name = body.fileName;
      bytes = Buffer.from(body.contentBase64, 'base64');
      mimeType = body.mimeType ?? undefined;
    }
    if (bytes.length === 0) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'The request body must be the file', [{ field: 'file', message: 'The file is empty' }]);
    }
    const scan = await scanUpload(bytes);
    const { file, unchanged } = await fileService.recordVersion({ orgId, userId, projectId, source: 'upload', name, mimeType, bytes, scanStatus: scan.status });
    // Development convenience: parse right away when docproc is configured, so a lone
    // `npm run dev` works without the worker. Production parsing runs only in the worker.
    if (!unchanged && file.latest && config.docproc.serviceKey) {
      const versionId = file.latest.id;
      setImmediate(() => {
        processVersion(orgId, versionId).catch((err) => console.error(`[files] dev parse of ${versionId} failed: ${(err as Error).message}`));
      });
    }
    res.status(unchanged ? 200 : 201).json({ success: true, data: { ...file, unchanged } });
  }),
);
