import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { audit } from '../middleware/audit';
import { requirePermission } from '../middleware/authorize';
import { auditService } from '../services/AuditService';
import { INVITABLE_ROLES, inviteService } from '../services/InviteService';
import { AppError, ErrorCodes } from '../utils/AppError';

type Handler = (req: Request, res: Response) => Promise<void>;

const handle =
  (fn: Handler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

const email = z.string({ error: (iss) => (iss.input === undefined ? 'email is required' : undefined) }).trim().toLowerCase().max(254).email('email must be a valid email address');

const createInviteSchema = z.object({
  email,
  role: z.string({ error: (iss) => (iss.input === undefined ? 'role is required' : undefined) }),
});

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(200).optional(),
});

const tokenParam = z.string().min(20, 'invitation link is invalid').max(200, 'invitation link is invalid');

const acceptSchema = z.object({
  fullName: z.string().trim().min(1).max(200).optional(),
  password: z
    .string({ error: (iss) => (iss.input === undefined ? 'password is required' : undefined) })
    .min(12, 'password must be at least 12 characters')
    .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'password must be at most 72 bytes'),
});

// Full paths (/api/invites/...) so each route matches its api_definition exactly.
export const invitesRouter = Router();

invitesRouter.post(
  '/api/invites',
  authenticate,
  requirePermission('members:invite'),
  audit('member.invited', {
    targetType: 'invite',
    targetId: (_req, data) => (data?.invite as { id?: string } | undefined)?.id,
    metadata: (req) => ({ role: req.body?.role }),
  }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    const input = createInviteSchema.parse(req.body);
    if (!(INVITABLE_ROLES as readonly string[]).includes(input.role)) {
      throw new AppError(400, ErrorCodes.INVALID_ROLE, `role must be one of ${INVITABLE_ROLES.join(', ')}`);
    }
    const created = await inviteService.create({ orgId, userId }, { email: input.email, role: input.role as (typeof INVITABLE_ROLES)[number] });
    res.status(201).json({ success: true, data: created });
  })
);

invitesRouter.get(
  '/api/invites',
  authenticate,
  requirePermission('members:invite'),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    const { limit, cursor } = listSchema.parse(req.query);
    res.status(200).json({ success: true, data: await inviteService.listOpen({ orgId, userId }, limit, cursor) });
  })
);

// Public: the token in the link is the credential.

invitesRouter.get(
  '/api/invites/:token',
  handle(async (req, res) => {
    const token = tokenParam.parse(req.params.token);
    res.status(200).json({ success: true, data: await inviteService.preview(token) });
  })
);

invitesRouter.post(
  '/api/invites/:token/accept',
  handle(async (req, res) => {
    const token = tokenParam.parse(req.params.token);
    const input = acceptSchema.parse(req.body);
    const session = await inviteService.accept(token, input);
    // Public route (no req.auth yet): record the join explicitly in the new member's firm.
    await auditService.record({
      orgId: session.org.id,
      actorUserId: session.user.id,
      action: 'member.joined',
      targetType: 'user',
      targetId: session.user.id,
      metadata: { role: session.role },
    });
    res.status(200).json({ success: true, data: session });
  })
);
