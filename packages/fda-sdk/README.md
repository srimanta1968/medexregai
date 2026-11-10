# @medexregai/fda-sdk

Typed client for the **fda-data** `/v1` API (ADR-017). It is the only way MedexRegAI
code reads FDA data; nothing outside `services/fda-data` touches the FDA database.
Server-side only: the API key must never reach a browser.

```ts
import { FdaClient, FdaServiceError } from '@medexregai/fda-sdk';

const fda = new FdaClient({ baseUrl: process.env.FDA_SERVICE_URL!, apiKey: process.env.FDA_SERVICE_KEY! });

const clearance = await fda.getClearance('K031698');       // 404 -> FdaServiceError NOT_FOUND
const page = await fda.search510k({ productCode: 'FRN', limit: 25 });
const next = await fda.search510k({ productCode: 'FRN', cursor: page.nextCursor! });
```

| Method | Route | Scope |
|---|---|---|
| `meta()` | `GET /v1/meta` | fda:read |
| `getClearance(k)` | `GET /v1/510k/{k}` | fda:read |
| `search510k(params)` | `GET /v1/510k` | fda:read |
| `getProductCode(code)` | `GET /v1/product-codes/{code}` | fda:read |
| `getFlags(k)` | `GET /v1/flags/{k}` | fda:read |
| `listRecalls(params)` | `GET /v1/recalls` | fda:read |
| `getUdi(di)` | `GET /v1/udi/{di}` | fda:read |
| `getEventCounts(code, from, to)` | `GET /v1/event-counts/{code}` | fda:read |
| `putTrackedProductCodes(codes)` | `PUT /v1/tracked-product-codes` | fda:track |

**Errors.** Every failure is an `FdaServiceError` with `status`, `code` (the service's
code, or `FDA_SERVICE_UNAVAILABLE` / `FDA_SERVICE_TIMEOUT` / `FDA_BAD_RESPONSE`) and
`retryable`. Network errors, timeouts, 429 and 5xx are retried (default 2 retries,
backoff 200 ms doubling, capped at `maxBackoffMs`, honouring the server's
`Retry-After`); 4xx are not. Callers should turn a retryable error into a 503 for
their own users ("FDA data is unavailable, try again shortly").

**Caching.** GETs are cached in memory (LRU, `cacheEntries`, default 500) for the
service's `max-age` (5 minutes); after that the SDK revalidates with `If-None-Match`
and a 304 reuses the cached body.

Types mirror `services/fda-data/openapi.json`. Build with `npm run build`; the
`prepare` script builds on install, so `"@medexregai/fda-sdk": "file:../packages/fda-sdk"`
works as a dependency.
