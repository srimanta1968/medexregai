import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { audit, fromParam } from '../middleware/audit';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { requirePermission } from '../middleware/authorize';
import { introductionService, SPECIALTIES } from '../introductions/IntroductionService';
import { AppError, ErrorCodes } from '../utils/AppError';

/**
 * F6.2 opt-in introductions (UI 2.0 §8.2).
 *   POST /api/public/introduction-requests     a company asks to be introduced (no sign-in; consent required; 201)
 *   GET  /api/introductions/settings           the firm's opt-in, specialties, pathways, profile      (firm:manage)
 *   PUT  /api/introductions/settings           change them                                           (firm:manage)
 *   GET  /api/introductions                    introductions offered to the firm, newest first      (firm:manage)
 *   GET  /api/introductions/:introductionId    one; the company's contact only once accepted        (firm:manage)
 *   POST /api/introductions/:introductionId/accept | /decline                                       (firm:manage)
 */
export const introductionsRouter = Router();

const handle =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch((err: unknown) => {
      if (err instanceof AppError && err.code === ErrorCodes.RATE_LIMITED) res.set('Retry-After', '3600');
      next(err);
    });
  };
const guard = [authenticate, requirePermission('firm:manage')];

function parse<T>(schema: z.ZodType<T>, value: unknown, where = 'body'): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new AppError(
      400,
      ErrorCodes.VALIDATION_ERROR,
      r.error.issues[0]?.message ?? 'Invalid request',
      r.error.issues.map((i) => ({ field: i.path.join('.') || where, message: i.message })),
    );
  }
  return r.data;
}

const strictKeys = { error: (iss: { code: string; keys?: string[] }) => (iss.code === 'unrecognized_keys' ? `Unknown field: ${(iss.keys ?? []).join(', ')}` : undefined) };
const text = (field: string, min: number, max: number) =>
  z
    .string({ error: (iss) => (iss.input === undefined ? `${field} is required` : `${field} must be text`) })
    .trim()
    .min(min, min > 1 ? `${field} must be at least ${min} characters` : `${field} is required`)
    .max(max, `${field} is at most ${max} characters`);
const specialty = z.enum(Object.keys(SPECIALTIES) as [string, ...string[]], { error: 'specialty must be an FDA medical specialty code, e.g. CV or HO' });
const pathway = z.enum(['510k', 'de_novo', 'pma'], { error: 'pathways must be 510k, de_novo or pma' });
const introId = (req: Request) => parse(z.string().uuid('introductionId must be a valid id'), req.params.introductionId, 'introductionId');

const requestBody = z
  .object(
    {
      companyName: text('companyName', 1, 200),
      contactName: text('contactName', 1, 200),
      contactEmail: z.string({ error: 'contactEmail is required' }).trim().toLowerCase().email('contactEmail must be an email address').max(254),
      brief: text('brief', 20, 2000),
      productCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'productCode must be a three-letter FDA product code').optional(),
      specialty: specialty.optional(),
      pathway: z.enum(['510k', 'de_novo', 'pma', 'unsure'], { error: 'pathway must be 510k, de_novo, pma or unsure' }),
      consent: z.literal(true, { error: 'You must agree that your request may be shared with consultant firms' }),
      // Honeypot: hidden on the page; people leave it empty.
      website: z.string().max(200).optional(),
    },
    strictKeys,
  )
  .strict();

introductionsRouter.post(
  '/api/public/introduction-requests',
  handle(async (req, res) => {
    const { website, ...input } = parse(requestBody, req.body ?? {});
    if (website && website.trim() !== '') throw new AppError(400, ErrorCodes.REQUEST_REJECTED, 'This request could not be accepted.');
    res.set('Cache-Control', 'no-store');
    res.status(201).json({ success: true, data: await introductionService.submitRequest(input, req.ip ?? 'unknown') });
  }),
);

const settingsBody = z
  .object(
    {
      optedIn: z.boolean({ error: 'optedIn must be true or false' }),
      specialties: z.array(specialty).max(19).default([]),
      pathways: z.array(pathway).max(3).default([]),
      profile: z.string().trim().max(1000, 'profile is at most 1000 characters').nullish(),
    },
    strictKeys,
  )
  .strict();

introductionsRouter.get(
  '/api/introductions/settings',
  ...guard,
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await introductionService.getSettings(orgId) });
  }),
);

introductionsRouter.put(
  '/api/introductions/settings',
  ...guard,
  audit('introductions.settings_updated', { targetType: 'firm', metadata: (req) => ({ optedIn: req.body?.optedIn ?? null }) }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    const body = parse(settingsBody, req.body ?? {});
    res.status(200).json({ success: true, data: await introductionService.putSettings(orgId, userId, { ...body, profile: body.profile || null }) });
  }),
);

const listQuery = z
  .object(
    {
      status: z.enum(['offered', 'accepted', 'declined'], { error: 'status must be offered, accepted or declined' }).optional(),
      limit: z.coerce.number().int().min(1, 'limit must be 1-50').max(50, 'limit must be 1-50').default(20),
      cursor: z.string().max(200, 'cursor is invalid').optional(),
    },
    strictKeys,
  )
  .strict();

introductionsRouter.get(
  '/api/introductions',
  ...guard,
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await introductionService.list(orgId, parse(listQuery, req.query, 'query')) });
  }),
);

introductionsRouter.get(
  '/api/introductions/:introductionId',
  ...guard,
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await introductionService.get(orgId, introId(req)) });
  }),
);

for (const decision of ['accept', 'decline'] as const) {
  introductionsRouter.post(
    `/api/introductions/:introductionId/${decision}`,
    ...guard,
    audit(`introduction.${decision === 'accept' ? 'accepted' : 'declined'}`, { targetType: 'introduction', targetId: fromParam('introductionId') }),
    handle(async (req, res) => {
      const { orgId, userId } = requireAuth(req);
      res.set('Cache-Control', 'no-store');
      res.status(200).json({ success: true, data: await introductionService.decide(orgId, userId, introId(req), decision) });
    }),
  );
}
