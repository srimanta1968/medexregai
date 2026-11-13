import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { audit, fromParam } from '../middleware/audit';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { Permission, requirePermission } from '../middleware/authorize';
import { pilotBlocks, pilotCsv, pilotService, signPilotReport } from '../pilot/PilotService';
import { renderPdf } from '../trust/pdf';
import { AppError, ErrorCodes } from '../utils/AppError';

/**
 * F4.2 pilot report.
 *   GET /api/pilot/baseline                          the firm's Phase 0 baseline, hours per A3 activity
 *   PUT /api/pilot/baseline                          { basis?, hours: { <activity code>: hours } } replace it (firm:manage)
 *   GET /api/projects/:projectId/pilot-report        hours against the baseline and the draft acceptance rate
 *   GET /api/projects/:projectId/pilot-report/pdf    the same as a PDF
 * Reading needs projects:read.
 */
export const pilotRouter = Router();

const handle =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };
const guard = (permission: Permission) => [authenticate, requirePermission(permission)];

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
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

export const projectIdOf = (req: Request): string => parse(z.string().uuid('projectId must be a valid id'), req.params.projectId);
export const safeName = (s: string): string => s.replace(/[^A-Za-z0-9 ()&,.-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Project';

const baselineBody = z
  .object({
    basis: z.string().trim().max(200, 'basis must be at most 200 characters').nullable().optional(),
    hours: z.record(
      z.string().regex(/^[a-z_]{2,20}$/, 'hours keys must be activity codes'),
      z.number({ error: (iss) => (iss.input === undefined ? undefined : 'hours must be numbers') }).min(0, 'hours cannot be negative').max(10000, 'hours must be at most 10000'),
    ),
  })
  .strict();

pilotRouter.get(
  '/api/pilot/baseline',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.status(200).json({ success: true, data: await pilotService.baseline(orgId) });
  }),
);

pilotRouter.put(
  '/api/pilot/baseline',
  guard('firm:manage'),
  audit('pilot.baseline_updated', { targetType: 'org' }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    res.status(200).json({ success: true, data: await pilotService.setBaseline({ orgId, userId }, parse(baselineBody, req.body)) });
  }),
);

pilotRouter.get(
  '/api/projects/:projectId/pilot-report',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await pilotService.report(orgId, projectIdOf(req)) });
  }),
);

pilotRouter.get(
  '/api/projects/:projectId/pilot-report/pdf',
  guard('projects:read'),
  audit('pilot.report_exported', { targetType: 'project', targetId: fromParam('projectId') }),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    const r = await pilotService.report(orgId, projectIdOf(req));
    const bytes = renderPdf({ title: `Pilot report: ${r.projectName}`, footer: `${r.projectName} - Pilot report - ${r.generatedAt.slice(0, 10)}`, createdAt: new Date(r.generatedAt), blocks: pilotBlocks(r) });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${safeName(r.projectName)} - Pilot report ${r.generatedAt.slice(0, 10)}.pdf"`);
    res.set('X-Report-SHA256', r.sha256);
    res.set('Access-Control-Expose-Headers', 'Content-Disposition, X-Report-SHA256');
    res.set('Cache-Control', 'no-store');
    res.set('Content-Length', String(bytes.length));
    res.status(200).end(bytes);
  }),
);

/*
 *   GET  /api/projects/:projectId/pilot-report/csv        hours by activity against the baseline, as CSV
 *   POST /api/projects/:projectId/pilot-report/sign-off   { signerTitle, note? } the firm's RA lead signs the report (drafts:review) (201)
 */
const signBody = z
  .object({
    signerTitle: z.string({ error: (iss) => (iss.input === undefined ? 'signerTitle is required' : undefined) }).trim().min(1, 'signerTitle is required').max(200, 'signerTitle must be at most 200 characters'),
    note: z.string().trim().max(1000, 'note must be at most 1000 characters').nullable().optional(),
  })
  .strict();

pilotRouter.get(
  '/api/projects/:projectId/pilot-report/csv',
  guard('projects:read'),
  audit('pilot.report_exported', { targetType: 'project', targetId: fromParam('projectId') }),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    const r = await pilotService.report(orgId, projectIdOf(req));
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${safeName(r.projectName)} - Pilot hours by activity ${r.generatedAt.slice(0, 10)}.csv"`);
    res.set('X-Report-SHA256', r.sha256);
    res.set('Access-Control-Expose-Headers', 'Content-Disposition, X-Report-SHA256');
    res.set('Cache-Control', 'no-store');
    res.status(200).send(pilotCsv(r));
  }),
);

pilotRouter.post(
  '/api/projects/:projectId/pilot-report/sign-off',
  guard('drafts:review'),
  audit('pilot.report_signed', { targetType: 'project', targetId: fromParam('projectId') }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    const id = projectIdOf(req);
    res.status(201).json({ success: true, data: await signPilotReport({ orgId, userId }, id, parse(signBody, req.body)) });
  }),
);
