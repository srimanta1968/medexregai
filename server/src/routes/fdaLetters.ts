import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { audit, fromParam } from '../middleware/audit';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { Permission, requirePermission } from '../middleware/authorize';
import { fdaLetterService } from '../fdaLetters/FdaLetterService';
import { AppError, ErrorCodes } from '../utils/AppError';

/**
 * F5.1 FDA letters (FR-14.23; UI 2.0 §7.1). Read: projects:read. Change: projects:write.
 *   GET    /api/projects/:projectId/fda-letters          letters, newest first, with deficiency counts and days left
 *   POST   /api/projects/:projectId/fda-letters          save a letter with the deficiencies the consultant confirmed (201)
 *   GET    /api/fda-letters/:letterId                     one letter, its deficiencies and what each affects
 *   PATCH  /api/fda-letters/:letterId                     status, responded date, reference, received/due date, notes
 *   DELETE /api/fda-letters/:letterId                     (204)
 *   POST   /api/fda-letters/:letterId/deficiencies        add a deficiency missed in the split (201)
 *   PATCH  /api/fda-deficiencies/:deficiencyId            summary, section, owner, status, due date
 *   PUT    /api/fda-deficiencies/:deficiencyId/links      replace the linked files and statements
 */
export const fdaLettersRouter = Router();

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
const param = (req: Request, name: string, what: string): string => parse(uuid(what), req.params[name]);
const day = (field: string) =>
  z
    .string({ error: (iss) => (iss.input === undefined ? `${field} is required` : `${field} must be a date`) })
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${field} must be a date (YYYY-MM-DD)`)
    .refine((d) => {
      const t = Date.parse(`${d}T00:00:00Z`);
      return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
    }, `${field} must be a real date`);
const text = (field: string, max: number) =>
  z
    .string({ error: (iss) => (iss.input === undefined ? `${field} is required` : `${field} must be text`) })
    .trim()
    .min(1, `${field} is required`)
    .max(max, `${field} must be at most ${max} characters`);
const owner = z.enum(['consultant', 'client'], { error: 'owner must be consultant or client' });
const sectionId = z.string().max(40, 'sectionId is too long').nullable();

const deficiencyBody = z
  .object({
    number: z.number({ error: 'number must be a whole number' }).int('number must be a whole number').min(1, 'number must be 1 or more').max(999, 'number must be at most 999'),
    summary: text('summary', 300),
    fdaText: text('fdaText', 20000),
    sectionId: sectionId.optional(),
    owner: owner.optional(),
    dueOn: day('dueOn').nullable().optional(),
    fileIds: z.array(uuid('fileIds'), { error: 'fileIds must be a list' }).max(50, 'At most 50 files').optional(),
    statementIds: z.array(uuid('statementIds'), { error: 'statementIds must be a list' }).max(100, 'At most 100 statements').optional(),
  })
  .strict();

const letterBody = z
  .object({
    kind: z.enum(['ai_request', 'rta_hold'], { error: 'kind must be ai_request or rta_hold' }),
    fdaReference: z.string().trim().max(40, 'fdaReference must be at most 40 characters').nullable().optional(),
    issuedOn: day('issuedOn'),
    receivedOn: day('receivedOn').nullable().optional(),
    dueOn: day('dueOn').nullable().optional(),
    fileVersionId: uuid('fileVersionId').nullable().optional(),
    notes: z.string().max(4000, 'notes must be at most 4000 characters').nullable().optional(),
    deficiencies: z.array(deficiencyBody, { error: 'deficiencies must be a list' }).max(200, 'At most 200 deficiencies'),
  })
  .strict();

const letterPatch = z
  .object({
    status: z.enum(['open', 'responded', 'closed'], { error: 'status must be open, responded or closed' }).optional(),
    respondedOn: day('respondedOn').nullable().optional(),
    fdaReference: z.string().trim().max(40, 'fdaReference must be at most 40 characters').nullable().optional(),
    receivedOn: day('receivedOn').nullable().optional(),
    dueOn: day('dueOn').optional(),
    notes: z.string().max(4000, 'notes must be at most 4000 characters').nullable().optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'Nothing to change');

const deficiencyPatch = z
  .object({
    summary: text('summary', 300).optional(),
    sectionId: sectionId.optional(),
    owner: owner.optional(),
    status: z.enum(['open', 'requested', 'drafting', 'ready', 'answered'], { error: 'status must be open, requested, drafting, ready or answered' }).optional(),
    dueOn: day('dueOn').nullable().optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'Nothing to change');

const linksBody = z
  .object({
    fileIds: z.array(uuid('fileIds'), { error: 'fileIds must be a list' }).max(50, 'At most 50 files'),
    statementIds: z.array(uuid('statementIds'), { error: 'statementIds must be a list' }).max(100, 'At most 100 statements'),
  })
  .strict();

fdaLettersRouter.get(
  '/api/projects/:projectId/fda-letters',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.status(200).json({ success: true, data: { items: await fdaLetterService.list(orgId, param(req, 'projectId', 'projectId')) } });
  }),
);

fdaLettersRouter.post(
  '/api/projects/:projectId/fda-letters',
  guard('projects:write'),
  audit('fda_letter.created', {
    targetType: 'fda_letter',
    targetId: (_req, data) => (typeof data?.id === 'string' ? data.id : undefined),
    projectId: fromParam('projectId'),
    metadata: (_req, data) => ({ kind: data?.kind ?? null, deficiencies: data?.deficiencyCount ?? null }),
  }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    const projectId = param(req, 'projectId', 'projectId');
    res.status(201).json({ success: true, data: await fdaLetterService.create(orgId, userId, projectId, parse(letterBody, req.body)) });
  }),
);

fdaLettersRouter.get(
  '/api/fda-letters/:letterId',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.status(200).json({ success: true, data: await fdaLetterService.get(orgId, param(req, 'letterId', 'letterId')) });
  }),
);

fdaLettersRouter.patch(
  '/api/fda-letters/:letterId',
  guard('projects:write'),
  audit('fda_letter.updated', { targetType: 'fda_letter', targetId: fromParam('letterId'), metadata: (req) => ({ fields: Object.keys(req.body ?? {}) }) }),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.status(200).json({ success: true, data: await fdaLetterService.update(orgId, param(req, 'letterId', 'letterId'), parse(letterPatch, req.body ?? {})) });
  }),
);

fdaLettersRouter.delete(
  '/api/fda-letters/:letterId',
  guard('projects:write'),
  audit('fda_letter.deleted', { targetType: 'fda_letter', targetId: fromParam('letterId') }),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    await fdaLetterService.remove(orgId, param(req, 'letterId', 'letterId'));
    res.status(204).end();
  }),
);

fdaLettersRouter.post(
  '/api/fda-letters/:letterId/deficiencies',
  guard('projects:write'),
  audit('fda_deficiency.added', { targetType: 'fda_letter', targetId: fromParam('letterId') }),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.status(201).json({ success: true, data: await fdaLetterService.addDeficiency(orgId, param(req, 'letterId', 'letterId'), parse(deficiencyBody, req.body)) });
  }),
);

fdaLettersRouter.patch(
  '/api/fda-deficiencies/:deficiencyId',
  guard('projects:write'),
  audit('fda_deficiency.updated', { targetType: 'fda_deficiency', targetId: fromParam('deficiencyId'), metadata: (req) => ({ fields: Object.keys(req.body ?? {}) }) }),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res
      .status(200)
      .json({ success: true, data: await fdaLetterService.updateDeficiency(orgId, param(req, 'deficiencyId', 'deficiencyId'), parse(deficiencyPatch, req.body ?? {})) });
  }),
);

fdaLettersRouter.put(
  '/api/fda-deficiencies/:deficiencyId/links',
  guard('projects:write'),
  audit('fda_deficiency.linked', { targetType: 'fda_deficiency', targetId: fromParam('deficiencyId') }),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.status(200).json({ success: true, data: await fdaLetterService.setLinks(orgId, param(req, 'deficiencyId', 'deficiencyId'), parse(linksBody, req.body)) });
  }),
);
