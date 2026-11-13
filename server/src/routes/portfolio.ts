import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { requirePermission } from '../middleware/authorize';
import { portfolioService } from '../portfolio/PortfolioService';
import { AppError, ErrorCodes } from '../utils/AppError';

/**
 * F5.3 portfolio (UI 2.0 §7.3). Read: projects:read.
 *   GET /api/portfolio?status=open|active|submitted|cleared|archived|all&clientId=&limit=&cursor=
 *       totals (active projects, open client requests, open high problems, FDA clocks running,
 *       overdue) and the firm's submissions, soonest due first, each with stage, next action,
 *       due date and risks.
 */
export const portfolioRouter = Router();

const handle =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

const query = z
  .object(
    {
      status: z
        .enum(['open', 'active', 'submitted', 'cleared', 'archived', 'all'], { error: 'status must be open, active, submitted, cleared, archived or all' })
        .default('open'),
      clientId: z.string().uuid('clientId must be a valid id').optional(),
      limit: z.coerce.number().int().min(1, 'limit must be 1-50').max(50, 'limit must be 1-50').default(25),
      cursor: z.string().max(200, 'cursor is invalid').optional(),
    },
    { error: (iss) => (iss.code === 'unrecognized_keys' ? `Unknown query parameter: ${iss.keys.join(', ')}` : undefined) },
  )
  .strict();

portfolioRouter.get(
  '/api/portfolio',
  authenticate,
  requirePermission('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    const r = query.safeParse(req.query);
    if (!r.success) {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        r.error.issues[0]?.message ?? 'Invalid request',
        r.error.issues.map((i) => ({ field: i.path.join('.') || 'query', message: i.message })),
      );
    }
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await portfolioService.get(orgId, r.data) });
  }),
);
