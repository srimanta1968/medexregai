import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { audit } from '../middleware/audit';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { Permission, requirePermission } from '../middleware/authorize';
import { usageCsv, usageService } from '../usage/UsageService';
import { AppError, ErrorCodes } from '../utils/AppError';

/**
 * F4.3 usage per client for rebilling (PRD v2.0 FR-14.22).
 *   GET /api/usage          ?from&to (UTC dates)&workspaceId?  files read, pages/sheets/slides read and drafts generated, per client and project
 *   GET /api/usage/export   same query, as CSV for Excel (one row per project, a total per client)
 * Exporting usage for rebilling is the consultancy owner's job (PRD v2.0 §5): billing:manage.
 */
export const usageRouter = Router();

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
      r.error.issues.map((i) => ({ field: i.path.join('.') || 'query', message: i.message })),
    );
  }
  return r.data;
}

const date = (field: string) =>
  z
    .string({ required_error: `${field} is required` })
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${field} must be a date (YYYY-MM-DD)`)
    .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), `${field} must be a real date`);
const usageQuery = z.object({
  from: date('from'),
  to: date('to'),
  workspaceId: z.string().uuid('workspaceId must be a valid id').optional(),
});

usageRouter.get(
  '/api/usage',
  guard('billing:manage'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await usageService.summary(orgId, parse(usageQuery, req.query)) });
  }),
);

usageRouter.get(
  '/api/usage/export',
  guard('billing:manage'),
  audit('usage.exported', { targetType: 'org' }),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    const q = parse(usageQuery, req.query);
    const s = await usageService.summary(orgId, q);
    const who = q.workspaceId && s.clients[0] ? ` ${s.clients[0].clientName.replace(/[^A-Za-z0-9 ()&,.-]+/g, ' ').trim().slice(0, 60)}` : '';
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="Usage${who} ${q.from} to ${q.to}.csv"`);
    res.set('Access-Control-Expose-Headers', 'Content-Disposition');
    res.set('Cache-Control', 'no-store');
    res.status(200).send(usageCsv(s));
  }),
);
