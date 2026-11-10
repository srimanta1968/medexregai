import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { audit, fromData, fromParam } from '../middleware/audit';
import { Permission, requirePermission } from '../middleware/authorize';
import { projectActivity } from '../services/AuditService';
import { workspaceService } from '../services/WorkspaceService';

type Handler = (req: Request, res: Response) => Promise<void>;

const handle =
  (fn: Handler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

const guard = (permission: Permission) => [authenticate, requirePermission(permission)];

const id = (what: string) => z.string().uuid(`${what} must be a valid id`);
const name = z.string({ required_error: 'name is required' }).trim().min(1, 'name is required').max(200, 'name must be at most 200 characters');
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().max(200).optional(),
});

const clientCreate = z.object({ name });
const clientUpdate = z
  .object({ name: name.optional(), status: z.enum(['active', 'archived']).optional() })
  .refine((v) => v.name !== undefined || v.status !== undefined, 'Nothing to update');

const udiDi = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9+$/.-]{6,23}$/, 'udiDi must be 6-23 letters, digits or + $ / . -')
  .nullable();
const productCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'productCode must be three letters')
  .nullable();
const deviceClass = z.enum(['I', 'II', 'III']).nullable();
const modelNames = z.array(z.string().trim().min(1).max(120)).max(50, 'at most 50 model names');

const deviceCreate = z.object({
  name,
  modelNames: modelNames.default([]),
  udiDi: udiDi.optional(),
  productCode: productCode.optional(),
  deviceClass: deviceClass.optional(),
});
const deviceUpdate = z
  .object({
    name: name.optional(),
    modelNames: modelNames.optional(),
    udiDi: udiDi.optional(),
    productCode: productCode.optional(),
    deviceClass: deviceClass.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

const submissionType = z.enum(['traditional', 'special', 'abbreviated']);
const targetDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'targetDate must be YYYY-MM-DD')
  .nullable();
const projectCreate = z.object({ name, submissionType: submissionType.default('traditional'), targetDate: targetDate.optional() });
const projectUpdate = z
  .object({ name: name.optional(), status: z.enum(['active', 'submitted', 'cleared', 'archived']).optional(), targetDate: targetDate.optional() })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

const ctx = (req: Request) => {
  const { orgId, userId } = requireAuth(req);
  return { orgId, userId };
};

// Full paths so each route matches its api_definition exactly.
export const workspaceRouter = Router();

// Clients
workspaceRouter.get(
  '/api/clients',
  ...guard('projects:read'),
  handle(async (req, res) => {
    const q = listQuery.extend({ status: z.enum(['active', 'archived']).optional() }).parse(req.query);
    res.status(200).json({ success: true, data: await workspaceService.listClients(ctx(req), q) });
  })
);
workspaceRouter.post(
  '/api/clients',
  ...guard('projects:write'),
  audit('client.created', { targetType: 'client', targetId: fromData('id'), workspaceId: fromData('id') }),
  handle(async (req, res) => {
    res.status(201).json({ success: true, data: await workspaceService.createClient(ctx(req), clientCreate.parse(req.body)) });
  })
);
workspaceRouter.patch(
  '/api/clients/:clientId',
  ...guard('projects:write'),
  audit('client.updated', {
    targetType: 'client',
    targetId: fromParam('clientId'),
    workspaceId: fromParam('clientId'),
    metadata: (req) => ({ fields: Object.keys(req.body ?? {}) }),
  }),
  handle(async (req, res) => {
    const clientId = id('clientId').parse(req.params.clientId);
    res.status(200).json({ success: true, data: await workspaceService.updateClient(ctx(req), clientId, clientUpdate.parse(req.body)) });
  })
);

// Devices
workspaceRouter.get(
  '/api/clients/:clientId/devices',
  ...guard('projects:read'),
  handle(async (req, res) => {
    const clientId = id('clientId').parse(req.params.clientId);
    res.status(200).json({ success: true, data: await workspaceService.listDevices(ctx(req), clientId, listQuery.parse(req.query)) });
  })
);
workspaceRouter.post(
  '/api/clients/:clientId/devices',
  ...guard('projects:write'),
  audit('device.created', { targetType: 'device', targetId: fromData('id'), workspaceId: fromParam('clientId') }),
  handle(async (req, res) => {
    const clientId = id('clientId').parse(req.params.clientId);
    res.status(201).json({ success: true, data: await workspaceService.createDevice(ctx(req), clientId, deviceCreate.parse(req.body)) });
  })
);
workspaceRouter.patch(
  '/api/devices/:deviceId',
  ...guard('projects:write'),
  audit('device.updated', {
    targetType: 'device',
    targetId: fromParam('deviceId'),
    workspaceId: fromData('clientId'),
    metadata: (req) => ({ fields: Object.keys(req.body ?? {}) }),
  }),
  handle(async (req, res) => {
    const deviceId = id('deviceId').parse(req.params.deviceId);
    res.status(200).json({ success: true, data: await workspaceService.updateDevice(ctx(req), deviceId, deviceUpdate.parse(req.body)) });
  })
);

// Projects (submissions)
workspaceRouter.get(
  '/api/clients/:clientId/projects',
  ...guard('projects:read'),
  handle(async (req, res) => {
    const clientId = id('clientId').parse(req.params.clientId);
    const q = listQuery.extend({ status: z.enum(['active', 'submitted', 'cleared', 'archived']).optional() }).parse(req.query);
    res.status(200).json({ success: true, data: await workspaceService.listProjects(ctx(req), clientId, q) });
  })
);
workspaceRouter.post(
  '/api/devices/:deviceId/projects',
  ...guard('projects:write'),
  audit('project.created', { targetType: 'project', targetId: fromData('id'), projectId: fromData('id'), workspaceId: fromData('clientId') }),
  handle(async (req, res) => {
    const deviceId = id('deviceId').parse(req.params.deviceId);
    res.status(201).json({ success: true, data: await workspaceService.createProject(ctx(req), deviceId, projectCreate.parse(req.body)) });
  })
);
workspaceRouter.get(
  '/api/projects/:projectId',
  ...guard('projects:read'),
  audit('project.viewed', {
    targetType: 'project',
    targetId: fromParam('projectId'),
    projectId: fromParam('projectId'),
    workspaceId: fromData('clientId'),
  }),
  handle(async (req, res) => {
    const projectId = id('projectId').parse(req.params.projectId);
    res.status(200).json({ success: true, data: await workspaceService.getProject(ctx(req), projectId) });
  })
);
workspaceRouter.patch(
  '/api/projects/:projectId',
  ...guard('projects:write'),
  audit('project.updated', {
    targetType: 'project',
    targetId: fromParam('projectId'),
    projectId: fromParam('projectId'),
    workspaceId: fromData('clientId'),
    metadata: (req) => ({ fields: Object.keys(req.body ?? {}) }),
  }),
  handle(async (req, res) => {
    const projectId = id('projectId').parse(req.params.projectId);
    res.status(200).json({ success: true, data: await workspaceService.updateProject(ctx(req), projectId, projectUpdate.parse(req.body)) });
  })
);

/** Recent activity for a submission, newest first (from the hash-chained audit log). */
workspaceRouter.get(
  '/api/projects/:projectId/activity',
  ...guard('projects:read'),
  handle(async (req, res) => {
    const projectId = id('projectId').parse(req.params.projectId);
    res.status(200).json({ success: true, data: await projectActivity(ctx(req), projectId, listQuery.parse(req.query)) });
  })
);
