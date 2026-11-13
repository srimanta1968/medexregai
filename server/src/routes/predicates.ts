import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { Permission, requirePermission } from '../middleware/authorize';
import { predicateService } from '../predicates/PredicateService';
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
