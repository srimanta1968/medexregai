import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireScope } from '../auth/apiClients';
import { primaryPool } from '../db/pool';

/**
 * PUT /v1/tracked-product-codes (scope fda:track). A client sends its complete list
 * of three-letter FDA product codes; the service follows their MAUDE counts. The list
 * replaces only this client's own codes. Nothing but public product codes is accepted:
 * no firm, client or device identity reaches this service (ADR-017).
 */
export const v1TrackingRouter = Router();

const body = z
  .object({
    productCodes: z
      .array(
        z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z]{3}$/, 'each product code must be three letters'),
      )
      .max(5000, 'at most 5,000 product codes'),
  })
  .strict();

v1TrackingRouter.put('/v1/tracked-product-codes', requireScope('fda:track'), (req: Request, res: Response, next: NextFunction): void => {
  (async () => {
    const codes = [...new Set(body.parse(req.body ?? {}).productCodes)].sort();
    const clientName = req.apiClient?.name ?? 'unknown';
    const client = await primaryPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM tracked_product_codes WHERE source_client = $1 AND NOT (product_code = ANY($2::text[]))', [clientName, codes]);
      // Codes no client tracked before this call: their MAUDE counts are not loaded yet.
      const { rows: fresh } = await client.query<{ product_code: string }>(
        `SELECT c AS product_code FROM unnest($1::text[]) AS c WHERE NOT EXISTS (SELECT 1 FROM tracked_product_codes t WHERE t.product_code = c)`,
        [codes],
      );
      await client.query(
        `INSERT INTO tracked_product_codes (product_code, source_client)
         SELECT c, $2 FROM unnest($1::text[]) AS c
         ON CONFLICT (product_code, source_client) DO UPDATE SET last_seen_at = now()`,
        [codes, clientName],
      );
      // Load counts for newly tracked codes now instead of at the nightly sync.
      let syncQueued = false;
      if (fresh.length) {
        const { rowCount } = await client.query(
          `INSERT INTO sync_requests (dataset, requested_by)
           SELECT 'event_counts', $1 WHERE NOT EXISTS (SELECT 1 FROM sync_requests WHERE dataset = 'event_counts' AND status IN ('queued', 'running'))`,
          [clientName],
        );
        syncQueued = (rowCount ?? 0) > 0;
      }
      await client.query('COMMIT');
      res.status(200).json({ success: true, data: { tracked: codes.length, added: fresh.length, syncQueued } });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  })().catch(next);
});
