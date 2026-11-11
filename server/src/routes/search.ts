import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { requirePermission } from '../middleware/authorize';
import { hybridSearch } from '../retrieval/search';
import { AppError, ErrorCodes } from '../utils/AppError';

/** F7.3 hybrid search over a project's client passages, with source locations and citations. */

type Handler = (req: Request, res: Response) => Promise<void>;
const handle =
  (fn: Handler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

const searchQuery = z.object({
  q: z.string({ required_error: 'q is required' }).trim().min(2, 'q must be at least 2 characters').max(500, 'q must be at most 500 characters'),
  limit: z.coerce.number().int().min(1, 'limit must be 1-50').max(50, 'limit must be 1-50').optional(),
  includeSuperseded: z.enum(['true', 'false']).optional(),
});

export const searchRouter = Router();

searchRouter.get(
  '/api/projects/:projectId/search',
  authenticate,
  requirePermission('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    const projectId = z.string().uuid().safeParse(req.params.projectId);
    if (!projectId.success) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'projectId must be a valid id', [{ field: 'projectId', message: 'must be a valid id' }]);
    }
    const q = searchQuery.safeParse(req.query);
    if (!q.success) {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        q.error.issues[0]?.message ?? 'Invalid query',
        q.error.issues.map((i) => ({ field: i.path.join('.') || 'query', message: i.message })),
      );
    }
    const result = await hybridSearch({
      orgId,
      projectId: projectId.data,
      query: q.data.q,
      limit: q.data.limit ?? 10,
      includeSuperseded: q.data.includeSuperseded === 'true',
    });
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: result });
  }),
);
