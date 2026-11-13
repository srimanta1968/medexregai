import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { audit, fromParam } from '../middleware/audit';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { Permission, requirePermission } from '../middleware/authorize';
import { predicateService } from '../predicates/PredicateService';
import { seComparisonService } from '../predicates/SeComparisonService';
import { AppError, ErrorCodes } from '../utils/AppError';

/**
 * F5.2 predicates (UI 2.0 §7.2). Read: projects:read.
 *   GET /api/projects/:projectId/predicates/search   ?mode=product_code|keyword|semantic&q&productCode&limit&cursor
 *       candidate predicates for the subject device, with IFU/technology similarity and recall flags
 */
export const predicatesRouter = Router();

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

const searchQuery = z
  .object({
    mode: z.enum(['product_code', 'keyword', 'semantic'], { error: 'mode must be product_code, keyword or semantic' }),
    q: z.string().trim().min(2, 'q must be at least 2 characters').max(300, 'q must be at most 300 characters').optional(),
    productCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/, 'productCode must be three letters')
      .optional(),
    limit: z.coerce.number().int().min(1, 'limit must be 1-20').max(20, 'limit must be 1-20').default(10),
    cursor: z.string().max(500, 'cursor is invalid').optional(),
  })
  .strict();

predicatesRouter.get(
  '/api/projects/:projectId/predicates/search',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    const projectId = parse(z.string().uuid('projectId must be a valid id'), req.params.projectId);
    const q = parse(searchQuery, req.query);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await predicateService.search(orgId, projectId, q) });
  }),
);

// ---- F5.2 SE comparison tables (UI 2.0 §7.2). Read: projects:read. Change: projects:write. ----
//   GET    /api/projects/:projectId/se-comparisons            the project's comparisons, newest first
//   POST   /api/projects/:projectId/se-comparisons            { kNumber } build and save a cited comparison (201; 409 if one exists)
//   GET    /api/se-comparisons/:comparisonId                  one comparison with its rows
//   POST   /api/se-comparisons/:comparisonId/rebuild          rebuild from the sources; edited rows are kept
//   PATCH  /api/se-comparisons/:comparisonId/rows/:rowKey     the consultant's edit of one row
//   DELETE /api/se-comparisons/:comparisonId                  (204)

const kNumberField = z
  .string({ error: (iss) => (iss.input === undefined ? 'kNumber is required' : 'kNumber must be text') })
  .trim()
  .toUpperCase()
  .regex(/^[KDP]\d{6}$/, 'kNumber must look like K123456');
const idParam = (req: Request, name: string): string => parse(z.string().uuid(`${name} must be a valid id`), req.params[name]);

const rowPatch = z
  .object({
    subjectText: z.string().max(4000, 'subjectText must be at most 4000 characters').optional(),
    predicateText: z.string().max(4000, 'predicateText must be at most 4000 characters').optional(),
    comparison: z.enum(['same', 'different', 'review'], { error: 'comparison must be same, different or review' }).optional(),
    note: z.string().max(1000, 'note must be at most 1000 characters').nullable().optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'Nothing to change');

predicatesRouter.get(
  '/api/projects/:projectId/se-comparisons',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.status(200).json({ success: true, data: { items: await seComparisonService.list(orgId, idParam(req, 'projectId')) } });
  }),
);

predicatesRouter.post(
  '/api/projects/:projectId/se-comparisons',
  guard('projects:write'),
  audit('se_comparison.created', {
    targetType: 'se_comparison',
    targetId: (_req, data) => (typeof data?.id === 'string' ? data.id : undefined),
    projectId: fromParam('projectId'),
    metadata: (_req, data) => ({ predicate: data?.predicateKNumber ?? null }),
  }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    const { kNumber } = parse(z.object({ kNumber: kNumberField }).strict(), req.body ?? {});
    res.status(201).json({ success: true, data: await seComparisonService.create(orgId, userId, idParam(req, 'projectId'), kNumber) });
  }),
);

predicatesRouter.get(
  '/api/se-comparisons/:comparisonId',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.status(200).json({ success: true, data: await seComparisonService.get(orgId, idParam(req, 'comparisonId')) });
  }),
);

predicatesRouter.post(
  '/api/se-comparisons/:comparisonId/rebuild',
  guard('projects:write'),
  audit('se_comparison.rebuilt', { targetType: 'se_comparison', targetId: fromParam('comparisonId') }),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.status(200).json({ success: true, data: await seComparisonService.rebuild(orgId, idParam(req, 'comparisonId')) });
  }),
);

predicatesRouter.patch(
  '/api/se-comparisons/:comparisonId/rows/:rowKey',
  guard('projects:write'),
  audit('se_comparison.row_edited', { targetType: 'se_comparison', targetId: fromParam('comparisonId'), metadata: (req) => ({ row: req.params.rowKey, fields: Object.keys(req.body ?? {}) }) }),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    const rowKey = parse(z.string().regex(/^[a-z_]{2,40}$/, 'rowKey is invalid'), req.params.rowKey);
    res.status(200).json({ success: true, data: await seComparisonService.updateRow(orgId, idParam(req, 'comparisonId'), rowKey, parse(rowPatch, req.body ?? {})) });
  }),
);

predicatesRouter.delete(
  '/api/se-comparisons/:comparisonId',
  guard('projects:write'),
  audit('se_comparison.deleted', { targetType: 'se_comparison', targetId: fromParam('comparisonId') }),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    await seComparisonService.remove(orgId, idParam(req, 'comparisonId'));
    res.status(204).end();
  }),
);
