import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { audit, fromParam } from '../middleware/audit';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { Permission, requirePermission } from '../middleware/authorize';
import { DECISIONS, Decision, problemService } from '../problems/ProblemService';
import { AppError, ErrorCodes } from '../utils/AppError';
import { pageSize } from '../utils/pagination';

/**
 * F2.3 problems: gaps and contradictions.
 *   GET  /api/projects/:projectId/problems          ?status=open|resolved|dismissed|all (default open), counts
 *   POST /api/projects/:projectId/problems/check    re-check now (rules only)
 *   GET  /api/problems/:problemId                   both sources side by side, the decision
 *   POST /api/problems/:problemId/decision          { decision, note }: resolve or dismiss with a note
 */
export const problemsRouter = Router();

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

const uuid = (what: string) => z.string().uuid(`${what} must be a valid id`);
const listQuery = z.object({
  status: z.enum(['open', 'resolved', 'dismissed', 'all'], { error: 'status must be open, resolved, dismissed or all' }).optional(),
  limit: z.coerce.number().int('limit must be a whole number').min(1, 'limit must be at least 1').max(50, 'limit must be at most 50').optional(),
  cursor: z.string().max(200, 'cursor is invalid').optional(),
});
const decisionBody = z
  .object({
    decision: z.enum(DECISIONS as unknown as [Decision, ...Decision[]], {
      error: `decision must be one of ${DECISIONS.join(', ')}`,
    }),
    note: z.string({ error: (iss) => (iss.input === undefined ? 'note is required' : undefined) }).trim().min(3, 'Add a short note explaining the decision').max(1000, 'note must be at most 1000 characters'),
  })
  .strict();

problemsRouter.get(
  '/api/projects/:projectId/problems',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    const q = parse(listQuery, req.query);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({
      success: true,
      data: await problemService.list(orgId, parse(uuid('projectId'), req.params.projectId), q.status ?? 'open', pageSize(q.limit), q.cursor),
    });
  }),
);

problemsRouter.post(
  '/api/projects/:projectId/problems/check',
  guard('projects:write'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.status(200).json({ success: true, data: await problemService.check(orgId, parse(uuid('projectId'), req.params.projectId)) });
  }),
);

problemsRouter.get(
  '/api/problems/:problemId',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await problemService.get(orgId, parse(uuid('problemId'), req.params.problemId)) });
  }),
);

problemsRouter.post(
  '/api/problems/:problemId/decision',
  guard('projects:write'),
  audit('problem.decision_requested', { targetType: 'problem', targetId: fromParam('problemId') }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    const body = parse(decisionBody, req.body);
    res.status(200).json({ success: true, data: await problemService.decide(orgId, userId, parse(uuid('problemId'), req.params.problemId), body.decision, body.note) });
  }),
);
