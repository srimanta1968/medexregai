import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { ConnectError, connectResultUrl, connectionService } from '../connections/ConnectionService';
import { audit, fromData, fromParam } from '../middleware/audit';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { Permission, requirePermission } from '../middleware/authorize';
import { AppError, ErrorCodes } from '../utils/AppError';
import { pageSize } from '../utils/pagination';

/**
 * F2.1 read-only folder connections.
 *   GET    /api/connections/providers                    providers, whether each is set up, the read-only scope in plain words
 *   GET    /api/connections                              the firm's connections (cursor paged)
 *   GET    /api/connections/:connectionId
 *   POST   /api/connections/oauth/:provider/start        begin connecting: { authorizeUrl } to send the browser to
 *   GET    /api/connections/oauth/:provider/callback     the provider sends the browser back here (no session; the one-time state binds it)
 *   DELETE /api/connections/:connectionId                disconnect: revoke at the provider, erase tokens, stop syncing
 *   GET    /api/projects/:projectId/folder-links         folders linked to the project
 *   POST   /api/projects/:projectId/folder-links         link a folder { connectionId, folder } (201); the worker syncs it
 *   DELETE /api/projects/:projectId/folder-links/:linkId stop syncing that folder (imported files stay)
 */
export const connectionsRouter = Router();

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
const listQuery = z.object({
  limit: z.coerce.number().int('limit must be a whole number').min(1, 'limit must be at least 1').max(50, 'limit must be at most 50').optional(),
  cursor: z.string().max(200, 'cursor is invalid').optional(),
});
const startBody = z
  .object({ returnPath: z.string().max(300, 'returnPath must be at most 300 characters').optional() })
  .strict();
const linkBody = z
  .object({
    connectionId: uuid('connectionId'),
    folder: z.string({ error: (iss) => (iss.input === undefined ? 'folder is required' : undefined) }).trim().min(1, 'folder is required').max(1024, 'folder must be at most 1024 characters'),
  })
  .strict();

connectionsRouter.get(
  '/api/connections/providers',
  guard('projects:read'),
  handle(async (_req, res) => {
    res.status(200).json({ success: true, data: connectionService.providers() });
  }),
);

connectionsRouter.get(
  '/api/connections',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    const q = parse(listQuery, req.query);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await connectionService.list(orgId, pageSize(q.limit), q.cursor) });
  }),
);

connectionsRouter.get(
  '/api/connections/:connectionId',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await connectionService.get(orgId, parse(uuid('connectionId'), req.params.connectionId)) });
  }),
);

connectionsRouter.post(
  '/api/connections/oauth/:provider/start',
  guard('projects:write'),
  audit('connection.started', { targetType: 'connection_provider', targetId: fromParam('provider') }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    const body = parse(startBody, req.body ?? {});
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await connectionService.start(orgId, userId, req.params.provider, body.returnPath) });
  }),
);

/** Browser redirect from the provider: always answers with a redirect back into the app. */
connectionsRouter.get(
  '/api/connections/oauth/:provider/callback',
  handle(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const { connection, returnPath } = await connectionService.callback(req.params.provider, req.query as Record<string, unknown>);
      res.redirect(302, connectResultUrl(returnPath, { connected: connection.id }));
    } catch (err) {
      if (!(err instanceof ConnectError)) throw err;
      console.warn(`[connections] ${req.params.provider} connect failed (${err.reason}): ${err.message}`);
      res.redirect(302, connectResultUrl(err.returnPath, { error: err.reason }));
    }
  }),
);

connectionsRouter.delete(
  '/api/connections/:connectionId',
  guard('projects:write'),
  audit('connection.disconnected', { targetType: 'connection', targetId: fromParam('connectionId') }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    const data = await connectionService.disconnect(orgId, userId, parse(uuid('connectionId'), req.params.connectionId));
    res.status(200).json({ success: true, data });
  }),
);

connectionsRouter.get(
  '/api/projects/:projectId/folder-links',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    const q = parse(listQuery, req.query);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await connectionService.listLinks(orgId, parse(uuid('projectId'), req.params.projectId), pageSize(q.limit), q.cursor) });
  }),
);

connectionsRouter.post(
  '/api/projects/:projectId/folder-links',
  guard('projects:write'),
  audit('folder_link.created', { targetType: 'folder_link', targetId: fromData('id') }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    const body = parse(linkBody, req.body);
    const link = await connectionService.linkFolder(orgId, userId, parse(uuid('projectId'), req.params.projectId), body.connectionId, body.folder);
    res.status(201).json({ success: true, data: link });
  }),
);

connectionsRouter.delete(
  '/api/projects/:projectId/folder-links/:linkId',
  guard('projects:write'),
  audit('folder_link.unlinked', { targetType: 'folder_link', targetId: fromParam('linkId') }),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    const link = await connectionService.unlinkFolder(orgId, parse(uuid('projectId'), req.params.projectId), parse(uuid('linkId'), req.params.linkId));
    res.status(200).json({ success: true, data: link });
  }),
);
