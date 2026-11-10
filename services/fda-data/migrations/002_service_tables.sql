-- fda_db 002: the service's own operational tables (ADR-017). None of these may hold
-- customer data: no firm, user, client, device or project identifiers.

-- Product codes whose MAUDE counts the worker follows. Clients push a bare list of
-- three-letter FDA product codes (public identifiers) with PUT /v1/tracked-product-codes;
-- replaces the main app's cross-database view fda_tracked_product_codes.
CREATE TABLE IF NOT EXISTS tracked_product_codes (
  product_code   varchar(3) PRIMARY KEY CHECK (product_code ~ '^[A-Z]{3}$'),
  -- Which API client last pushed it (service name, not a customer).
  source_client  varchar(64) NOT NULL,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now()
);

-- Service-to-service API clients (F1.4). The key is shown once on creation; only
-- its SHA-256 hash and a short prefix (to identify it in logs) are stored.
CREATE TABLE IF NOT EXISTS api_clients (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           varchar(64) NOT NULL UNIQUE,
  key_prefix     varchar(12) NOT NULL,
  key_hash       char(64) NOT NULL UNIQUE,
  scopes         text[] NOT NULL,
  rate_per_minute integer NOT NULL DEFAULT 1200 CHECK (rate_per_minute > 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz,
  revoked_at     timestamptz,
  CONSTRAINT api_clients_scopes_chk CHECK (scopes <@ ARRAY['fda:read', 'fda:track', 'fda:admin']::text[] AND cardinality(scopes) > 0)
);

-- Sync requests from POST /v1/admin/syncs, picked up by the worker (never run inline).
CREATE TABLE IF NOT EXISTS sync_requests (
  id             bigserial PRIMARY KEY,
  dataset        varchar(32) NOT NULL,
  window_from    date,
  window_to      date,
  requested_by   varchar(64) NOT NULL,
  status         varchar(16) NOT NULL DEFAULT 'queued',
  run_id         bigint REFERENCES fda_sync_runs(id),
  requested_at   timestamptz NOT NULL DEFAULT now(),
  picked_at      timestamptz,
  CONSTRAINT sync_requests_dataset_chk CHECK (dataset IN ('510k', 'classification', 'recall', 'udi', 'event_counts')),
  CONSTRAINT sync_requests_status_chk CHECK (status IN ('queued', 'running', 'done', 'failed')),
  CONSTRAINT sync_requests_window_chk CHECK (window_from IS NULL OR window_to IS NULL OR window_from <= window_to)
);
CREATE INDEX IF NOT EXISTS sync_requests_queued_idx ON sync_requests (requested_at) WHERE status = 'queued';
