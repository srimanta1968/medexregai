import { createHash } from 'crypto';
import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireScope } from '../auth/apiClients';
import { eventCounts, meta, recalls, search510k, udi } from './catalog';
import { lookups } from './lookups';
import { openapi } from './openapi';

/**
 * fda-data /v1 read API (ADR-017). Every route needs a service key with fda:read.
 * Responses use the main app's envelope { success, data }. Express sets a weak
 * ETag and answers If-None-Match with 304; Cache-Control lets callers (the SDK)
 * reuse answers for five minutes.
 */
export const v1ReadRouter = Router();

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
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'dates must be YYYY-MM-DD');
const limit = z.coerce.number().int().min(1).max(100).default(25);
const cursor = z.string().max(400).optional();

/** Weak ETag over the exact response body. */
const etagOf = (body: string): string => `W/"${Buffer.byteLength(body).toString(16)}-${createHash('sha1').update(body).digest('base64url')}"`;

/**
 * Send { success, data } with an ETag, answering 304 when If-None-Match matches.
 * Done here rather than by Express's freshness check, which refuses 304 whenever the
 * request says Cache-Control: no-cache, as Node's fetch does on every conditional GET.
 * An origin server may still validate in that case; only intermediaries may not reuse.
 */
const read =
  (fn: (req: Request) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req)
      .then((data) => {
        const body = JSON.stringify({ success: true, data });
        const etag = etagOf(body);
        res.set({ 'Cache-Control': 'private, max-age=300', ETag: etag });
        const inm = req.header('if-none-match');
        if (inm && inm.split(',').some((t) => t.trim() === etag || t.trim() === '*')) {
          res.status(304).end();
          return;
        }
        res.status(200).type('application/json').send(body);
      })
      .catch(next);
  };

const guard = requireScope('fda:read');

/** The OpenAPI contract for this API. */
v1ReadRouter.get('/v1/openapi.json', guard, (_req: Request, res: Response) => {
  res.status(200).json(openapi);
});

/** Data freshness per dataset. */
v1ReadRouter.get(
  '/v1/meta',
  guard,
  read(() => meta()),
);

/** Verify one K or DEN number. */
v1ReadRouter.get(
  '/v1/510k/:kNumber',
  guard,
  read((req) => lookups.verify510k(kNumber.parse(req.params.kNumber))),
);

/** Search 510(k)s (newest decision first, cursor paging). */
v1ReadRouter.get(
  '/v1/510k',
  guard,
  read((req) => {
    const p = z
      .object({
        productCode: productCode.optional(),
        applicant: z.string().trim().min(2).max(100).optional(),
        q: z.string().trim().min(2).max(100).optional(),
        decidedFrom: isoDate.optional(),
        decidedTo: isoDate.optional(),
        limit,
        cursor,
      })
      .refine(
        (v) => v.productCode || v.applicant || v.q || v.decidedFrom || v.decidedTo,
        'Give at least one filter: productCode, applicant, q, decidedFrom or decidedTo',
      )
      .parse(req.query);
    return search510k(p);
  }),
);

/** Classification of a product code. */
v1ReadRouter.get(
  '/v1/product-codes/:code',
  guard,
  read((req) => lookups.productCode(productCode.parse(req.params.code))),
);

/** Recall and MAUDE flags for a K-number. */
v1ReadRouter.get(
  '/v1/flags/:kNumber',
  guard,
  read((req) => lookups.flags(kNumber.parse(req.params.kNumber))),
);

/** Recalls by K-number or product code (cursor paging). */
v1ReadRouter.get(
  '/v1/recalls',
  guard,
  read((req) => {
    const p = z
      .object({
        kNumber: kNumber.optional(),
        productCode: productCode.optional(),
        limit,
        cursor,
      })
      .refine((v) => v.kNumber || v.productCode, 'Give kNumber or productCode')
      .parse(req.query);
    return recalls(p);
  }),
);

/** A GUDID device by primary UDI-DI. */
v1ReadRouter.get(
  '/v1/udi/:di',
  guard,
  read((req) =>
    udi(
      z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9+$/.-]{6,23}$/, 'di must be 6-23 letters, digits or + $ / . -')
        .parse(req.params.di),
    ),
  ),
);

/** MAUDE report counts per day for a product code. */
v1ReadRouter.get(
  '/v1/event-counts/:code',
  guard,
  read((req) => {
    const p = z.object({ from: isoDate, to: isoDate }).parse(req.query);
    return eventCounts(productCode.parse(req.params.code), p.from, p.to);
  }),
);
