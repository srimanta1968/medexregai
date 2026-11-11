import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { AI_ROUTES } from '../ai/registry';
import { runCitationGate } from '../citations/CitationService';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { requirePermission } from '../middleware/authorize';
import { AppError, ErrorCodes } from '../utils/AppError';

/**
 * F7.3 citation gate v2 over a text, for a project. Generated drafts pass through the
 * same gate inside the drafting routes (E3); this endpoint lets the UI and tests check
 * any text and returns what was kept, what was removed and why.
 */

type Handler = (req: Request, res: Response) => Promise<void>;
const handle =
  (fn: Handler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

const checkBody = z
  .object({
    text: z.string({ required_error: 'text is required' }).min(1, 'text is required').max(50_000, 'text must be at most 50,000 characters'),
    route: z.enum([...AI_ROUTES, 'check'] as [string, ...string[]]).optional(),
  })
  .strict();

export const citationsRouter = Router();

citationsRouter.post(
  '/api/projects/:projectId/citations/check',
  authenticate,
  requirePermission('projects:read'),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    const projectId = z.string().uuid().safeParse(req.params.projectId);
    if (!projectId.success) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'projectId must be a valid id', [{ field: 'projectId', message: 'must be a valid id' }]);
    }
    const body = checkBody.safeParse(req.body);
    if (!body.success) {
      const issue = body.error.issues[0];
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        issue?.message ?? 'Invalid request',
        body.error.issues.map((i) => ({ field: i.path.join('.') || 'body', message: i.message })),
      );
    }
    const result = await runCitationGate({ orgId, userId, projectId: projectId.data, route: body.data.route ?? 'check', text: body.data.text });
    res.status(200).json({ success: true, data: result });
  }),
);
