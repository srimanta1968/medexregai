# ADR-017: FDA data in its own service, database and SDK

- Status: Accepted
- Date: 2026-11-10
- Supersedes: the "FDA tables in the app database" part of E1 (migrations 010 and 011)
- Backlog: E1 / F1.4 (fda-data service) and F1.5 (fda-sdk and cutover)

## Context

E1 loaded the openFDA device data into the main application database. Measured on
2026-11-10 that copy is 1.4 GB with only 1 of 52 UDI partitions loaded; the full
UDI set (~5.2 million records) and the 510(k) summary text and embeddings (F1.2)
take it well past 15 GB. Keeping it next to the customer workflow data means:

- backups, restores, migrations and vacuum of customer data carry a large public corpus;
- bulk loads and nightly syncs compete for I/O with consultants' work;
- the two cannot be scaled, tuned or retained separately;
- one cross-boundary view (`fda_tracked_product_codes`) joins customer devices to FDA sync.

The FDA corpus is public, shared by every firm, write-heavy only in batch, and
read-mostly. Customer data is private, per firm, and transactional. They have
different security, scaling and lifecycle needs.

## Decision

1. **Separate database instance** `fda_db` holding only the public FDA corpus and
   the service's own operational tables. It holds **no customer data**: no firm,
   user, device or project identifiers.
2. **Separate service** `services/fda-data` (one image, two processes):
   - `fda-api`: versioned REST API `/v1` (read, track, admin), OpenAPI contract.
   - `fda-worker`: openFDA delta sync, bulk loads, later 510(k) summary fetch,
     parse and embed (F1.2). The only writer to `fda_db`.
3. **SDK** `packages/fda-sdk` (`@medexregai/fda-sdk`): the only way other code reads
   FDA data. Typed, with timeouts, retries, typed errors and an ETag-aware cache.
4. **Service-to-service auth**: API clients with hashed keys and scopes
   (`fda:read`, `fda:track`, `fda:admin`), per-client rate limits. No CORS; browsers
   go through the main app's `/api/fda/*`, which keeps user authentication.
5. **Tracked product codes** are pushed by the app (`PUT /v1/tracked-product-codes`)
   as a bare list of three-letter codes, replacing the cross-database view.
6. **Scaling**: reads go to `FDA_READ_DATABASE_URL` (a replica) when set; the API is
   stateless and scales horizontally; the worker runs one sync per dataset at a time
   under a Postgres advisory lock.

```
browser ──> main app (/api/fda/*, user auth) ──SDK──> fda-api /v1 ──> fda_db replica (reads)
                 │                                         │
                 └─ customer DB (no FDA tables)        fda-worker ──> fda_db primary (writes)
                                                              └──> openFDA, accessdata.fda.gov
```

## Consequences

- Customer database stays small; its backups and restores are fast and contain only customer data.
- The FDA corpus can be rebuilt from openFDA at any time; its backup policy can be lighter.
- An FDA service outage degrades FDA features only: the SDK returns a typed,
  retryable error and the app shows "FDA data is unavailable, try again shortly".
- Public product-code pages (F6.1) and predicate search (F5.2) read from the service
  and its replicas, never from customer data.
- One more deployable to operate (image, secrets, database, monitoring).

## Alternatives considered

- **Separate schema in the same instance**: isolates names, not I/O, backups or scaling. Rejected.
- **Query openFDA live**: rate limited (240/min), no summaries or embeddings, and an
  external dependency on every user request. Rejected (also contradicts E1).
- **Read-only foreign data wrapper from the app DB**: couples deployments and leaks
  the boundary. Rejected.
