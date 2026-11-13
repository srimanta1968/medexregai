import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { billingService } from '../billing/BillingService';
import { audit } from '../middleware/audit';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { requirePermission } from '../middleware/authorize';
import { AppError, ErrorCodes } from '../utils/AppError';

/**
 * F6.3 self-serve billing (Stripe).
 *   GET  /api/billing                   plan, credit balance, recent credit movements, what can be bought (billing:manage)
 *   POST /api/billing/checkout          { priceId } -> a Stripe Checkout page URL (billing:manage; audited)
 *   POST /api/billing/stripe/webhook    Stripe's signed events (no sign-in; Stripe-Signature verified)
 */
export const billingRouter = Router();

const handle =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };
const guard = [authenticate, requirePermission('billing:manage')];

billingRouter.get(
  '/api/billing',
  ...guard,
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await billingService.get(orgId) });
  }),
);

const checkoutBody = z
  .object(
    { priceId: z.string({ error: (iss) => (iss.input === undefined ? 'priceId is required' : 'priceId must be text') }).trim().regex(/^price_[A-Za-z0-9]{8,64}$/, 'priceId must be a Stripe price id') },
    { error: (iss) => (iss.code === 'unrecognized_keys' ? `Unknown field: ${(iss.keys ?? []).join(', ')}` : undefined) },
  )
  .strict();

billingRouter.post(
  '/api/billing/checkout',
  ...guard,
  audit('billing.checkout_started', { targetType: 'firm', metadata: (req) => ({ priceId: req.body?.priceId ?? null }) }),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    const r = checkoutBody.safeParse(req.body ?? {});
    if (!r.success) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, r.error.issues[0]?.message ?? 'Invalid request', r.error.issues.map((i) => ({ field: i.path.join('.') || 'body', message: i.message })));
    }
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await billingService.checkout(orgId, r.data.priceId) });
  }),
);

// Public by design: Stripe calls it; the Stripe-Signature header over the raw body is the authentication.
// projexlight-ignore SEC-AUTHZ-01: signed webhook, declared requiresAuth:false
billingRouter.post(
  '/api/billing/stripe/webhook',
  handle(async (req, res) => {
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    const sig = req.get('stripe-signature');
    res.status(200).json({ success: true, data: await billingService.webhook(raw, sig) });
  }),
);
