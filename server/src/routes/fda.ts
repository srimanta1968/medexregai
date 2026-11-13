import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { fda, fdaClient } from '../fda/fdaService';
import { authenticate } from '../middleware/authenticate';

/**
 * FDA routes for signed-in users. User authentication stays here; the data comes
 * from the fda-data service through @medexregai/fda-sdk (ADR-017). Response shapes
 * are unchanged from F1.1/F1.3, so the web app did not change.
 */
export const fdaRouter = Router();

/** K-numbers as the FDA issues them: K + 6 digits, or DEN + 6 digits for De Novo. */
const kNumber = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^(K|DEN)\d{6}$/, 'kNumber must be K or DEN followed by 6 digits, e.g. K031698');
const productCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'productCode must be three letters, e.g. FRN');

const lookup =
  (fn: (req: Request) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req)
      .then((data) => {
        res.set('Cache-Control', 'private, max-age=300');
        res.status(200).json({ success: true, data });
      })
      .catch(next);
  };

/** FDA data freshness per dataset (data-as-of badge, FDA sources page). */
fdaRouter.get(
  '/api/fda/meta',
  authenticate,
  lookup(() => fda((c) => c.meta()))
);

/** Whether the FDA data service is reachable, for status displays and health checks. Never fails. */
fdaRouter.get('/api/fda/status', authenticate, (_req: Request, res: Response): void => {
  const started = Date.now();
  (async () => {
    // Availability is checked live (/ready is never cached); the data date may come from cache.
    try {
      const client = fdaClient();
      const available = await client.ready();
      const latencyMs = Date.now() - started;
      const dataAsOf = available ? (await client.meta().catch(() => null))?.dataAsOf ?? null : null;
      return { available, dataAsOf, latencyMs };
    } catch {
      return { available: false, dataAsOf: null, latencyMs: Date.now() - started };
    }
  })().then((data) => {
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data });
  });
});

/** Verify a K-number against the FDA 510(k) data. */
fdaRouter.get(
  '/api/fda/510k/:kNumber',
  authenticate,
  lookup((req) => fda((c) => c.getClearance(kNumber.parse(req.params.kNumber))))
);

/**
 * Passages of a 510(k)'s public summary, in document order (F1.2): page, text and a
 * stable ref ("K262392#4") that F7.3 cites as [R:<ref>]. passages is empty until the
 * FDA data service has fetched and indexed the summary; summaryStatus / indexStatus say why.
 */
fdaRouter.get(
  '/api/fda/510k/:kNumber/passages',
  authenticate,
  lookup((req) => {
    const p = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).max(100_000).default(0) })
      .parse(req.query);
    return fda((c) => c.getSummaryPassages(kNumber.parse(req.params.kNumber), p));
  })
);

/** Hybrid (keyword + semantic) search across indexed public 510(k) summaries (F1.2). */
fdaRouter.get(
  '/api/fda/search/summaries',
  authenticate,
  lookup((req) => {
    const p = z
      .object({
        q: z.string({ error: (iss) => (iss.input === undefined ? 'q is required' : undefined) }).trim().min(2, 'q must be at least 2 characters').max(500),
        productCode: productCode.optional(),
        kNumber: kNumber.optional(),
        limit: z.coerce.number().int().min(1).max(50).default(10),
      })
      .parse(req.query);
    return fda((c) => c.searchSummaries(p));
  })
);

/** Device class and regulation number for a product code. */
fdaRouter.get(
  '/api/fda/product-codes/:code',
  authenticate,
  lookup((req) => fda((c) => c.getProductCode(productCode.parse(req.params.code))))
);

/** Recall and MAUDE flags for a K-number; untracked product codes get the app's guidance. */
fdaRouter.get(
  '/api/fda/flags/:kNumber',
  authenticate,
  lookup(async (req) => {
    const flags = await fda((c) => c.getFlags(kNumber.parse(req.params.kNumber)));
    if (!flags.maude.tracked) {
      flags.maude.note = 'MAUDE counts are not tracked for this product code yet. Add it to a device in your workspace to start tracking.';
    }
    return flags;
  })
);
