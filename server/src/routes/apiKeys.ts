import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { API_SCOPES, apiKeyService, requireApiKey } from '../apiKeys/ApiKeyService';
import { fda } from '../fda/fdaService';
import { audit, fromParam } from '../middleware/audit';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { requirePermission } from '../middleware/authorize';
import { portfolioService } from '../portfolio/PortfolioService';
import { AppError, ErrorCodes } from '../utils/AppError';

/**
 * F6.3 API keys and the public API.
 *   Key management (firm:manage, signed in):
 *     GET    /api/api-keys               the firm's keys, newest first (never the secret)
 *     POST   /api/api-keys               { name, scopes, expiresInDays? } -> the secret, shown once (201)
 *     DELETE /api/api-keys/:keyId        revoke at once (204)
 *   Public API (API key only, one scope per route):
 *     GET /api/v1/portfolio                       portfolio:read
 *     GET /api/v1/fda/product-codes/:code          fda:read
 *     GET /api/v1/fda/510k/:kNumber                fda:read
 */
export const apiKeysRouter = Router();

const handle =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
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
const strictKeys = { error: (iss: { code: string; keys?: string[] }) => (iss.code === 'unrecognized_keys' ? `Unknown field: ${(iss.keys ?? []).join(', ')}` : undefined) };
const guard = [authenticate, requirePermission('firm:manage')];

const createBody = z
  .object(
    {
      name: z
        .string({ error: (iss) => (iss.input === undefined ? 'name is required' : 'name must be text') })
        .trim()
        .min(1, 'name is required')
        .max(100, 'name is at most 100 characters'),
      scopes: z
        .array(z.enum(API_SCOPES, { error: `scopes must be from: ${API_SCOPES.join(', ')}` }), { error: 'scopes is required' })
        .min(1, 'Give the key at least one scope'),
      expiresInDays: z.number().int('expiresInDays must be a whole number').min(1, 'expiresInDays must be 1-730').max(730, 'expiresInDays must be 1-730').optional(),
    },
    strictKeys,
  )
  .strict();

apiKeysRouter.get(
  '/api/api-keys',
  ...guard,
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    const q = parse(
      z.object({ limit: z.coerce.number().int().min(1, 'limit must be 1-50').max(50, 'limit must be 1-50').default(20), cursor: z.string().max(200).optional() }, strictKeys).strict(),
      req.query,
      'query',
    );
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await apiKeyService.list(orgId, q) });
  }),
);

apiKeysRouter.post(
  '/api/api-keys',
  ...guard,
  audit('api_key.created', { targetType: 'api_key', targetId: (_req, data) => (data?.key as { id?: string } | undefined)?.id, metadata: (req) => ({ scopes: req.body?.scopes ?? [] }) }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    const out = await apiKeyService.create(orgId, userId, parse(createBody, req.body ?? {}));
    res.set('Cache-Control', 'no-store');
    res.status(201).json({ success: true, data: out });
  }),
);

apiKeysRouter.delete(
  '/api/api-keys/:keyId',
  ...guard,
  audit('api_key.revoked', { targetType: 'api_key', targetId: fromParam('keyId') }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    await apiKeyService.revoke(orgId, userId, parse(z.string().uuid('keyId must be a valid id'), req.params.keyId, 'keyId'));
    res.status(204).end();
  }),
);

// ---- Public API (API key only) ----

apiKeysRouter.get(
  '/api/v1/portfolio',
  requireApiKey('portfolio:read'),
  handle(async (req, res) => {
    const q = parse(
      z
        .object(
          {
            status: z.enum(['open', 'active', 'submitted', 'cleared', 'archived', 'all'], { error: 'status must be open, active, submitted, cleared, archived or all' }).default('open'),
            limit: z.coerce.number().int().min(1, 'limit must be 1-50').max(50, 'limit must be 1-50').default(25),
            cursor: z.string().max(200, 'cursor is invalid').optional(),
          },
          strictKeys,
        )
        .strict(),
      req.query,
      'query',
    );
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await portfolioService.get(req.apiKey!.orgId, q) });
  }),
);

apiKeysRouter.get(
  '/api/v1/fda/product-codes/:code',
  requireApiKey('fda:read'),
  handle(async (req, res) => {
    const code = parse(z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'code must be a three-letter FDA product code'), req.params.code, 'code');
    res.status(200).json({ success: true, data: await fda((c) => c.getProductCode(code)) });
  }),
);

apiKeysRouter.get(
  '/api/v1/fda/510k/:kNumber',
  requireApiKey('fda:read'),
  handle(async (req, res) => {
    const k = parse(z.string().trim().toUpperCase().regex(/^(K|DEN)\d{6}$/, 'kNumber must look like K251234 or DEN250012'), req.params.kNumber, 'kNumber');
    res.status(200).json({ success: true, data: await fda((c) => c.getClearance(k)) });
  }),
);
