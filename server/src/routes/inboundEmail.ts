import express, { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { config } from '../config/env';
import { audit, fromParam } from '../middleware/audit';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { Permission, requirePermission } from '../middleware/authorize';
import { inboundEmailService, relayKeyMatches } from '../inbound/InboundEmailService';
import { AppError, ErrorCodes } from '../utils/AppError';
import { pageSize } from '../utils/pagination';

/**
 * Per-project forwarding address (F2.1):
 *   GET    /api/projects/:projectId/inbound-email     the address (if on) and allowed senders
 *   POST   /api/projects/:projectId/inbound-email     turn it on, or replace it (201)
 *   PATCH  /api/projects/:projectId/inbound-email     { allowedSenders }
 *   DELETE /api/projects/:projectId/inbound-email     turn it off
 *   GET    /api/projects/:projectId/inbound-emails    messages received and what happened to each
 * Mail relay (shared key in X-Inbound-Key, raw RFC 822 message as the body):
 *   POST   /api/inbound/email                         202 queued; 404 when no recipient is an active address
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
const sendersBody = z
  .object({
    allowedSenders: z
      .array(z.string().max(320, 'A sender is at most 320 characters'), { required_error: 'allowedSenders is required' })
      .max(50, 'At most 50 allowed senders'),
  })
  .strict();
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).optional(), cursor: z.string().max(200).optional() });

export const inboundEmailRouter = Router();

inboundEmailRouter.get(
  '/api/projects/:projectId/inbound-email',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await inboundEmailService.settings(orgId, parse(uuid('projectId'), req.params.projectId)) });
  }),
);

inboundEmailRouter.post(
  '/api/projects/:projectId/inbound-email',
  guard('projects:write'),
  audit('inbound_address.created', { targetType: 'project', targetId: fromParam('projectId'), projectId: fromParam('projectId') }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    res.status(201).json({ success: true, data: await inboundEmailService.create(orgId, userId, parse(uuid('projectId'), req.params.projectId)) });
  }),
);

inboundEmailRouter.patch(
  '/api/projects/:projectId/inbound-email',
  guard('projects:write'),
  audit('inbound_address.senders_updated', { targetType: 'project', targetId: fromParam('projectId'), projectId: fromParam('projectId') }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    const projectId = parse(uuid('projectId'), req.params.projectId);
    const { allowedSenders } = parse(sendersBody, req.body ?? {});
    res.status(200).json({ success: true, data: await inboundEmailService.updateSenders(orgId, userId, projectId, allowedSenders) });
  }),
);

inboundEmailRouter.delete(
  '/api/projects/:projectId/inbound-email',
  guard('projects:write'),
  audit('inbound_address.revoked', { targetType: 'project', targetId: fromParam('projectId'), projectId: fromParam('projectId') }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    res.status(200).json({ success: true, data: await inboundEmailService.turnOff(orgId, userId, parse(uuid('projectId'), req.params.projectId)) });
  }),
);

inboundEmailRouter.get(
  '/api/projects/:projectId/inbound-emails',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    const projectId = parse(uuid('projectId'), req.params.projectId);
    const q = parse(listQuery, req.query);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await inboundEmailService.list(orgId, projectId, pageSize(q.limit), q.cursor) });
  }),
);

// ------------------------------------------------------------------ relay

inboundEmailRouter.post(
  '/api/inbound/email',
  (req: Request, _res: Response, next: NextFunction) => {
    // Authenticate before reading a large body.
    if (!config.inboundEmail.relayKey) {
      next(new AppError(503, ErrorCodes.INBOUND_EMAIL_NOT_CONFIGURED, 'Inbound email is not set up on this server'));
      return;
    }
    const key = req.headers['x-inbound-key'];
    if (!relayKeyMatches(typeof key === 'string' ? key : undefined)) {
      next(new AppError(401, ErrorCodes.UNAUTHORIZED, 'Invalid relay key'));
      return;
    }
    if (Number(req.headers['content-length'] ?? 0) > config.inboundEmail.maxBytes) {
      next(new AppError(413, ErrorCodes.FILE_TOO_LARGE, 'The message is too large'));
      return;
    }
    next();
  },
  express.raw({ type: () => true, limit: config.inboundEmail.maxBytes }),
  handle(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'The request body must be the raw message (message/rfc822)', [{ field: 'body', message: 'Empty' }]);
    }
    const envelope = req.headers['x-envelope-to'];
    const r = await inboundEmailService.receive(req.body, typeof envelope === 'string' ? envelope : undefined);
    res.status(202).json({ success: true, data: { queued: r.queued.map((q) => q.id), duplicates: r.duplicates } });
    // Process now; the worker picks up anything this misses.
    for (const q of r.queued) {
      setImmediate(() => {
        inboundEmailService.process(q.orgId, q.id).catch((err: unknown) => {
          console.error(`[inbound] message ${q.id} failed, the worker will retry: ${(err as Error).message}`);
        });
      });
    }
  }),
);
