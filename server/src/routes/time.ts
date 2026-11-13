import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { Permission, requirePermission } from '../middleware/authorize';
import { audit } from '../middleware/audit';
import { roleHasPermission } from '../middleware/authorize';
import { timeService, timeTotals, totalsCsv } from '../time/TimeService';
import { AppError, ErrorCodes } from '../utils/AppError';

/**
 * F4.1 time capture: each person's own time against the A3 activity codes.
 *   GET    /api/time/activities             the activity codes, in workbook order
 *   GET    /api/time/current                the running timer, or null
 *   POST   /api/time/start                  { activityCode, projectId?, note? } start a timer; stops the running one (201)
 *   POST   /api/time/stop                   stop the running timer (404 when none)
 *   GET    /api/time/entries                ?from&to&projectId&limit&cursor  own entries, newest first
 *   POST   /api/time/entries                { activityCode, projectId?, startedAt, endedAt, note? } typed in afterwards (201)
 *   PATCH  /api/time/entries/:entryId       { activityCode?, projectId?, startedAt?, endedAt?, note? }
 *   DELETE /api/time/entries/:entryId       (204)
 *   GET    /api/time/summary                ?weekStart=YYYY-MM-DD&tzOffset=<minutes>  the week by day, activity and project
 *   GET    /api/time/export                 ?from&to&scope=mine|firm  totals by project and activity as CSV (firm needs firm:manage)
 * Every member may log their own time (projects:read); nobody reads or edits another person's entries here.
 */
export const timeRouter = Router();

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

const ctx = (req: Request) => {
  const { orgId, userId } = requireAuth(req);
  return { orgId, userId };
};
const activityCode = z.string({ error: (iss) => (iss.input === undefined ? 'activityCode is required' : undefined) }).regex(/^[a-z_]{2,20}$/, 'activityCode is not an activity code');
const projectId = z.string().uuid('projectId must be a valid id').nullable();
const instant = (field: string) =>
  z
    .string({ error: (iss) => (iss.input === undefined ? `${field} is required` : undefined) })
    .datetime({ offset: true, message: `${field} must be an ISO 8601 date-time` });
const note = z.string().trim().max(500, 'note must be at most 500 characters').nullable();
const entryId = (req: Request) => parse(z.string().uuid('entryId must be a valid id'), req.params.entryId);

const startBody = z.object({ activityCode, projectId: projectId.optional(), note: note.optional() }).strict();
const addBody = z.object({ activityCode, projectId: projectId.optional(), startedAt: instant('startedAt'), endedAt: instant('endedAt'), note: note.optional() }).strict();
const updateBody = z
  .object({ activityCode: activityCode.optional(), projectId: projectId.optional(), startedAt: instant('startedAt').optional(), endedAt: instant('endedAt').optional(), note: note.optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
const listQuery = z.object({
  from: instant('from').optional(),
  to: instant('to').optional(),
  projectId: z.string().uuid('projectId must be a valid id').optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().max(200).optional(),
});
const summaryQuery = z.object({
  weekStart: z.string({ error: (iss) => (iss.input === undefined ? 'weekStart is required' : undefined) }).regex(/^\d{4}-\d{2}-\d{2}$/, 'weekStart must be a date (YYYY-MM-DD)').refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), 'weekStart must be a real date'),
  tzOffset: z.coerce.number().int().min(-840, 'tzOffset must be between -840 and 840 minutes').max(840, 'tzOffset must be between -840 and 840 minutes').optional(),
});

timeRouter.get(
  '/api/time/activities',
  guard('projects:read'),
  handle(async (_req, res) => {
    res.status(200).json({ success: true, data: await timeService.activities() });
  }),
);

timeRouter.get(
  '/api/time/current',
  guard('projects:read'),
  handle(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: { entry: await timeService.current(ctx(req)) } });
  }),
);

timeRouter.post(
  '/api/time/start',
  guard('projects:read'),
  handle(async (req, res) => {
    res.status(201).json({ success: true, data: await timeService.start(ctx(req), parse(startBody, req.body)) });
  }),
);

timeRouter.post(
  '/api/time/stop',
  guard('projects:read'),
  handle(async (req, res) => {
    res.status(200).json({ success: true, data: await timeService.stop(ctx(req)) });
  }),
);

timeRouter.get(
  '/api/time/entries',
  guard('projects:read'),
  handle(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await timeService.list(ctx(req), parse(listQuery, req.query)) });
  }),
);

timeRouter.post(
  '/api/time/entries',
  guard('projects:read'),
  handle(async (req, res) => {
    res.status(201).json({ success: true, data: await timeService.add(ctx(req), parse(addBody, req.body)) });
  }),
);

timeRouter.patch(
  '/api/time/entries/:entryId',
  guard('projects:read'),
  handle(async (req, res) => {
    const id = entryId(req);
    res.status(200).json({ success: true, data: await timeService.update(ctx(req), id, parse(updateBody, req.body)) });
  }),
);

timeRouter.delete(
  '/api/time/entries/:entryId',
  guard('projects:read'),
  handle(async (req, res) => {
    const id = entryId(req);
    await timeService.remove(ctx(req), id);
    res.status(204).end();
  }),
);

timeRouter.get(
  '/api/time/summary',
  guard('projects:read'),
  handle(async (req, res) => {
    const q = parse(summaryQuery, req.query);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await timeService.week(ctx(req), q.weekStart, q.tzOffset ?? 0) });
  }),
);

const exportQuery = z.object({
  from: instant('from'),
  to: instant('to'),
  scope: z.enum(['mine', 'firm'], { error: 'scope must be mine or firm' }).optional(),
});

timeRouter.get(
  '/api/time/export',
  guard('projects:read'),
  audit('time.exported', { targetType: 'org' }),
  handle(async (req, res) => {
    const auth = requireAuth(req);
    const q = parse(exportQuery, req.query);
    if (Date.parse(q.to) <= Date.parse(q.from)) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'to must be after from', [{ field: 'to', message: 'Must be after from' }]);
    if (Date.parse(q.to) - Date.parse(q.from) > 400 * 86_400_000) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Export at most 400 days at a time', [{ field: 'to', message: 'At most 400 days after from' }]);
    const scope = q.scope ?? 'mine';
    if (scope === 'firm' && !roleHasPermission(auth.role, 'firm:manage')) {
      throw new AppError(403, ErrorCodes.FORBIDDEN, "Only an owner or admin can export the whole firm's time");
    }
    const rows = await timeTotals({ orgId: auth.orgId, userId: auth.userId }, { from: q.from, to: q.to, scope });
    const csv = totalsCsv(rows, scope);
    const name = `Time by project and activity ${q.from.slice(0, 10)} to ${q.to.slice(0, 10)}${scope === 'firm' ? ' (firm)' : ''}.csv`;
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${name}"`);
    res.set('X-Total-Seconds', String(rows.reduce((s, r) => s + r.seconds, 0)));
    res.set('Access-Control-Expose-Headers', 'Content-Disposition, X-Total-Seconds');
    res.set('Cache-Control', 'no-store');
    res.status(200).send(csv);
  }),
);
