import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { publicCodeService } from '../publicPages/PublicCodeService';
import { AppError, ErrorCodes } from '../utils/AppError';

/**
 * F6.1 public product-code pages (UI 2.0 §8.1). No sign-in: FDA data only, nothing from any firm.
 *   GET  /api/public/product-codes/:code   classification, likely pathway, clearances and review
 *                                          times over 5 years, recalls and their root causes, sources
 *   POST /api/public/device-checks         the free device check (201); rate-limited per hashed IP;
 *                                          email and description kept only with contact consent
 */
export const publicCodesRouter = Router();

const handle =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch((err: unknown) => {
      if (err instanceof AppError && err.code === ErrorCodes.RATE_LIMITED) res.set('Retry-After', '3600');
      next(err);
    });
  };

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

const productCode = (field: string) =>
  z
    .string({ error: (iss) => (iss.input === undefined ? `${field} is required` : `${field} must be text`) })
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, `${field} must be a three-letter FDA product code`);

publicCodesRouter.get(
  '/api/public/product-codes/:code',
  handle(async (req, res) => {
    const code = parse(productCode('code'), req.params.code, 'code');
    // Public FDA data: cacheable by browsers and the CDN for an hour.
    res.set('Cache-Control', 'public, max-age=3600');
    res.status(200).json({ success: true, data: await publicCodeService.page(code) });
  }),
);

const checkBody = z
  .object(
    {
      productCode: productCode('productCode'),
      description: z
        .string({ error: (iss) => (iss.input === undefined ? 'description is required' : 'description must be text') })
        .trim()
        .min(10, 'Describe your device in at least 10 characters')
        .max(2000, 'description is at most 2000 characters'),
      contactConsent: z.boolean({ error: 'contactConsent must be true or false' }).default(false),
      email: z.string().trim().toLowerCase().email('email must be an email address').max(254).optional(),
      // Honeypot: hidden on the page; people leave it empty.
      website: z.string().max(200).optional(),
    },
    { error: (iss) => (iss.code === 'unrecognized_keys' ? `Unknown field: ${iss.keys.join(', ')}` : undefined) },
  )
  .strict()
  .refine((v) => !v.contactConsent || !!v.email, { message: 'Give an email address if you want us to contact you', path: ['email'] });

publicCodesRouter.post(
  '/api/public/device-checks',
  handle(async (req, res) => {
    const { website, ...input } = parse(checkBody, req.body ?? {});
    if (website && website.trim() !== '') {
      throw new AppError(400, ErrorCodes.REQUEST_REJECTED, 'This request could not be accepted.');
    }
    res.set('Cache-Control', 'no-store');
    res.status(201).json({ success: true, data: await publicCodeService.check(input, req.ip ?? 'unknown') });
  }),
);
