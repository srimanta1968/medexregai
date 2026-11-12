import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { audit, fromParam } from '../middleware/audit';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { Permission, requirePermission } from '../middleware/authorize';
import { styleSourceService } from '../style/StyleSourceService';
import { AppError, ErrorCodes } from '../utils/AppError';

/**
 * F3.6 firm style sources: the firm's section templates and its library of past wording.
 *   GET    /api/style-sources                          whether the firm has style sources on
 *   PUT    /api/style-sources            { enabled }    turn them on or off (firm:manage)
 *   GET    /api/templates                ?limit&cursor  the firm's templates, newest first
 *   POST   /api/templates                { sectionId, name, body, enabled? }  (201)
 *   GET    /api/templates/:templateId
 *   PATCH  /api/templates/:templateId    { name?, body?, enabled? }
 *   DELETE /api/templates/:templateId    (204)
 *   GET    /api/precedents               ?sectionId&limit&cursor
 *   POST   /api/precedents               { sectionId, sourceLabel, text, enabled? }  (201)
 *   PATCH  /api/precedents/:precedentId  { sourceLabel?, text?, enabled? }
 *   DELETE /api/precedents/:precedentId  (204)
 *   GET    /api/project-sections/:sectionId/precedents  past wording drafting may use for this section now
 * Every read and write is scoped to the caller's firm. Reading needs projects:read; writing
 * templates and precedents needs projects:write; the firm switch needs firm:manage.
 */
export const styleSourcesRouter = Router();

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
const sectionKey = z
  .string({ required_error: 'sectionId is required' })
  .regex(/^[a-z][a-z0-9_]{1,39}$/, 'sectionId must be an eSTAR section id, such as device_description');
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().max(200).optional(),
});
const enabled = z.boolean({ invalid_type_error: 'enabled must be true or false' });
const templateName = z.string({ required_error: 'name is required' }).trim().min(1, 'name is required').max(200, 'name must be at most 200 characters');
const templateBody = z.string({ required_error: 'body is required' }).trim().min(1, 'body is required').max(20000, 'body must be at most 20000 characters');
const sourceLabel = z
  .string({ required_error: 'sourceLabel is required' })
  .trim()
  .min(1, 'sourceLabel is required')
  .max(200, 'sourceLabel must be at most 200 characters');
const precedentText = z.string({ required_error: 'text is required' }).trim().min(1, 'text is required').max(4000, 'text must be at most 4000 characters');

const settingsBody = z.object({ enabled: z.boolean({ required_error: 'enabled is required', invalid_type_error: 'enabled must be true or false' }) }).strict();
const templateCreate = z.object({ sectionId: sectionKey, name: templateName, body: templateBody, enabled: enabled.optional() }).strict();
const templateUpdate = z
  .object({ name: templateName.optional(), body: templateBody.optional(), enabled: enabled.optional() })
  .strict()
  .refine((v) => v.name !== undefined || v.body !== undefined || v.enabled !== undefined, 'Nothing to update');
const precedentCreate = z.object({ sectionId: sectionKey, sourceLabel, text: precedentText, enabled: enabled.optional() }).strict();
const precedentUpdate = z
  .object({ sourceLabel: sourceLabel.optional(), text: precedentText.optional(), enabled: enabled.optional() })
  .strict()
  .refine((v) => v.sourceLabel !== undefined || v.text !== undefined || v.enabled !== undefined, 'Nothing to update');

// --- firm switch --------------------------------------------------------------------------

styleSourcesRouter.get(
  '/api/style-sources',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.status(200).json({ success: true, data: await styleSourceService.settings(orgId) });
  }),
);

styleSourcesRouter.put(
  '/api/style-sources',
  guard('firm:manage'),
  audit('style_sources.updated', { targetType: 'org' }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    const { enabled: on } = parse(settingsBody, req.body);
    res.status(200).json({ success: true, data: await styleSourceService.setEnabled({ orgId, userId }, on) });
  }),
);

// --- templates ----------------------------------------------------------------------------

styleSourcesRouter.get(
  '/api/templates',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.status(200).json({ success: true, data: await styleSourceService.listTemplates(orgId, parse(listQuery, req.query)) });
  }),
);

styleSourcesRouter.post(
  '/api/templates',
  guard('projects:write'),
  audit('template.created', { targetType: 'firm_template' }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    res.status(201).json({ success: true, data: await styleSourceService.createTemplate({ orgId, userId }, parse(templateCreate, req.body)) });
  }),
);

styleSourcesRouter.get(
  '/api/templates/:templateId',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.status(200).json({ success: true, data: await styleSourceService.getTemplate(orgId, parse(uuid('templateId'), req.params.templateId)) });
  }),
);

styleSourcesRouter.patch(
  '/api/templates/:templateId',
  guard('projects:write'),
  audit('template.updated', { targetType: 'firm_template', targetId: fromParam('templateId') }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    const id = parse(uuid('templateId'), req.params.templateId);
    res.status(200).json({ success: true, data: await styleSourceService.updateTemplate({ orgId, userId }, id, parse(templateUpdate, req.body)) });
  }),
);

styleSourcesRouter.delete(
  '/api/templates/:templateId',
  guard('projects:write'),
  audit('template.deleted', { targetType: 'firm_template', targetId: fromParam('templateId') }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    await styleSourceService.deleteTemplate({ orgId, userId }, parse(uuid('templateId'), req.params.templateId));
    res.status(204).end();
  }),
);

// --- precedents ---------------------------------------------------------------------------

styleSourcesRouter.get(
  '/api/precedents',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    const q = parse(listQuery.extend({ sectionId: sectionKey.optional() }), req.query);
    res.status(200).json({ success: true, data: await styleSourceService.listPrecedents(orgId, q) });
  }),
);

styleSourcesRouter.post(
  '/api/precedents',
  guard('projects:write'),
  audit('precedent.created', { targetType: 'firm_precedent' }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    res.status(201).json({ success: true, data: await styleSourceService.createPrecedent({ orgId, userId }, parse(precedentCreate, req.body)) });
  }),
);

styleSourcesRouter.patch(
  '/api/precedents/:precedentId',
  guard('projects:write'),
  audit('precedent.updated', { targetType: 'firm_precedent', targetId: fromParam('precedentId') }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    const id = parse(uuid('precedentId'), req.params.precedentId);
    res.status(200).json({ success: true, data: await styleSourceService.updatePrecedent({ orgId, userId }, id, parse(precedentUpdate, req.body)) });
  }),
);

styleSourcesRouter.delete(
  '/api/precedents/:precedentId',
  guard('projects:write'),
  audit('precedent.deleted', { targetType: 'firm_precedent', targetId: fromParam('precedentId') }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    await styleSourceService.deletePrecedent({ orgId, userId }, parse(uuid('precedentId'), req.params.precedentId));
    res.status(204).end();
  }),
);

styleSourcesRouter.get(
  '/api/project-sections/:sectionId/precedents',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.status(200).json({ success: true, data: await styleSourceService.forProjectSection(orgId, parse(uuid('sectionId'), req.params.sectionId)) });
  }),
);
