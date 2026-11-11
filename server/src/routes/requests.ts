import express, { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { config } from '../config/env';
import { audit, fromData, fromParam } from '../middleware/audit';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { Permission, requirePermission } from '../middleware/authorize';
import { requestService } from '../requests/RequestService';
import { AppError, ErrorCodes } from '../utils/AppError';
import { pageSize } from '../utils/pagination';

/**
 * Client requests (F2.4):
 *   POST   /api/projects/:projectId/requests     draft a request (201)
 *   GET    /api/projects/:projectId/requests     the project's requests, newest first
 *   GET    /api/requests/:requestId              one request with items and link state
 *   PATCH  /api/requests/:requestId              edit a draft
 *   POST   /api/requests/:requestId/approve      approve: link issued (shown once), email sent
 *   POST   /api/requests/:requestId/link         a new link for an open request
 *   POST   /api/requests/:requestId/link/revoke  the link stops working
 * Public, the token is the credential (no account):
 *   GET    /api/u/:token                         what the client is asked for
 *   POST   /api/u/:token/files?item=<itemId>     upload one file (raw bytes, X-File-Name)
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
const item = z
  .object({
    label: z.string({ required_error: 'Each item needs a label' }).trim().min(1, 'Each item needs a label').max(200, 'An item label is at most 200 characters'),
    detail: z.string().trim().max(1000, 'Item details are at most 1000 characters').optional(),
    sectionId: z.string().trim().max(64).nullish(),
    gapRef: z.string().trim().max(100).nullish(),
  })
  .strict();
const email = z.string().trim().email('recipientEmail must be an email address').max(320);
const requestCreate = z
  .object({
    title: z.string({ required_error: 'title is required' }).trim().min(1, 'title is required').max(200, 'title is at most 200 characters'),
    message: z.string().max(5000, 'message is at most 5000 characters').optional(),
    recipientName: z.string().trim().max(200).nullish(),
    recipientEmail: email.nullish(),
    items: z.array(item, { required_error: 'items is required' }).min(1, 'Add at least one item').max(50, 'At most 50 items per request'),
  })
  .strict();
const requestUpdate = requestCreate.partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');
const linkBody = z
  .object({
    expiresInDays: z.coerce
      .number()
      .int('expiresInDays must be a whole number')
      .min(1, 'expiresInDays must be 1 or more')
      .max(config.clientUploads.maxDays, `expiresInDays must be at most ${config.clientUploads.maxDays}`)
      .optional(),
  })
  .strict();
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).optional(), cursor: z.string().max(200).optional() });
const token = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/, 'This upload link is not valid');

export const requestsRouter = Router();

requestsRouter.post(
  '/api/projects/:projectId/requests',
  guard('projects:write'),
  audit('client_request.created', { targetType: 'client_request', targetId: fromData('id'), projectId: fromParam('projectId') }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    const projectId = parse(uuid('projectId'), req.params.projectId);
    res.status(201).json({ success: true, data: await requestService.create(orgId, userId, projectId, parse(requestCreate, req.body)) });
  }),
);

requestsRouter.get(
  '/api/projects/:projectId/requests',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    const projectId = parse(uuid('projectId'), req.params.projectId);
    const q = parse(listQuery, req.query);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await requestService.list(orgId, projectId, pageSize(q.limit), q.cursor) });
  }),
);

requestsRouter.get(
  '/api/requests/:requestId',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await requestService.detail(orgId, parse(uuid('requestId'), req.params.requestId)) });
  }),
);

requestsRouter.patch(
  '/api/requests/:requestId',
  guard('projects:write'),
  audit('client_request.updated', { targetType: 'client_request', targetId: fromParam('requestId'), projectId: fromData('projectId') }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    const requestId = parse(uuid('requestId'), req.params.requestId);
    res.status(200).json({ success: true, data: await requestService.update(orgId, userId, requestId, parse(requestUpdate, req.body)) });
  }),
);

requestsRouter.post(
  '/api/requests/:requestId/approve',
  guard('projects:write'),
  audit('client_request.approved', { targetType: 'client_request', targetId: fromParam('requestId') }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    const requestId = parse(uuid('requestId'), req.params.requestId);
    const { expiresInDays } = parse(linkBody, req.body ?? {});
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await requestService.approve(orgId, userId, requestId, expiresInDays ?? config.clientUploads.defaultDays) });
  }),
);

requestsRouter.post(
  '/api/requests/:requestId/link',
  guard('projects:write'),
  audit('client_request.link_issued', { targetType: 'client_request', targetId: fromParam('requestId') }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    const requestId = parse(uuid('requestId'), req.params.requestId);
    const { expiresInDays } = parse(linkBody, req.body ?? {});
    res.set('Cache-Control', 'no-store');
    res
      .status(200)
      .json({ success: true, data: await requestService.reissueLink(orgId, userId, requestId, expiresInDays ?? config.clientUploads.defaultDays) });
  }),
);

requestsRouter.post(
  '/api/requests/:requestId/link/revoke',
  guard('projects:write'),
  audit('client_request.link_revoked', { targetType: 'client_request', targetId: fromParam('requestId') }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    res.status(200).json({ success: true, data: await requestService.revokeLink(orgId, userId, parse(uuid('requestId'), req.params.requestId)) });
  }),
);

// ------------------------------------------------------------------ public

requestsRouter.get(
  '/api/u/:token',
  handle(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.status(200).json({ success: true, data: await requestService.publicView(parse(token, req.params.token)) });
  }),
);

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
const uploadQuery = z.object({ item: z.string().uuid('item must be a valid id').optional() });

requestsRouter.post(
  '/api/u/:token/files',
  (req: Request, _res: Response, next: NextFunction) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > config.clientUploads.maxBytes) {
      next(new AppError(413, ErrorCodes.FILE_TOO_LARGE, `Files up to ${Math.floor(config.clientUploads.maxBytes / (1024 * 1024))} MB can be uploaded`));
      return;
    }
    next();
  },
  express.raw({ type: () => true, limit: config.clientUploads.maxBytes }),
  handle(async (req, res) => {
    const t = parse(token, req.params.token);
    const { item: itemId } = parse(uploadQuery, req.query);
    let name = '';
    let bytes: Buffer;
    let mimeType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : undefined;
    if (Buffer.isBuffer(req.body)) {
      // The page: body = the file's bytes, X-File-Name = its URL-encoded name.
      const rawName = req.headers['x-file-name'];
      try {
        name = decodeURIComponent(typeof rawName === 'string' ? rawName : '').trim();
      } catch {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'X-File-Name must be URL-encoded', [{ field: 'fileName', message: 'Must be URL-encoded' }]);
      }
      if (!name) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'X-File-Name is required', [{ field: 'fileName', message: 'Required' }]);
      bytes = req.body;
    } else {
      // Scripts and API tests: { fileName, contentBase64, mimeType? } (JSON, within the JSON body limit).
      const body = parse(jsonUpload, req.body ?? {});
      name = body.fileName.trim();
      bytes = Buffer.from(body.contentBase64, 'base64');
      mimeType = body.mimeType ?? undefined;
    }
    if (bytes.length === 0)
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'The request body must be the file', [{ field: 'file', message: 'The file is empty' }]);
    res.set('Cache-Control', 'no-store');
    res.status(201).json({ success: true, data: await requestService.publicUpload(t, { name, bytes, mimeType, itemId }) });
  }),
);
