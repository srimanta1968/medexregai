-- fda_db 001: the public openFDA device corpus (ADR-017). Carried over unchanged
-- from the main app's migration 010 (F1.1); from here on it lives only in fda_db.
-- No table in this database may hold customer data.

CREATE TABLE IF NOT EXISTS fda_510k (
  k_number                   varchar(16) PRIMARY KEY,
  applicant                  text,
  device_name                text,
  product_code               varchar(8),
  decision_date              date,
  decision_code              varchar(8),
  decision_description       text,
  clearance_type             varchar(32),
  date_received              date,
  advisory_committee         varchar(8),
  review_advisory_committee  varchar(8),
  statement_or_summary       varchar(16),
  third_party_flag           varchar(2),
  expedited_review_flag      varchar(2),
  device_class               varchar(2),
  regulation_number          varchar(16),
  raw                        jsonb NOT NULL,
  synced_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fda_510k_product_code_idx ON fda_510k (product_code, decision_date DESC);
CREATE INDEX IF NOT EXISTS fda_510k_decision_date_idx ON fda_510k (decision_date DESC);

CREATE TABLE IF NOT EXISTS fda_classification (
  product_code               varchar(8) PRIMARY KEY,
  device_name                text,
  device_class               varchar(2),
  regulation_number          varchar(16),
  medical_specialty          varchar(8),
  medical_specialty_description text,
  review_panel               varchar(8),
  submission_type_id         varchar(4),
  implant_flag               varchar(2),
  life_sustain_support_flag  varchar(2),
  definition                 text,
  raw                        jsonb NOT NULL,
  synced_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fda_recall (
  product_res_number         varchar(32) PRIMARY KEY,
  cfres_id                   varchar(16),
  res_event_number           varchar(16),
  -- openFDA sometimes pads product_code (e.g. 'IZL--'); product_code_norm is the 3-letter code.
  product_code               varchar(16),
  product_code_norm          varchar(3) GENERATED ALWAYS AS (upper(left(regexp_replace(coalesce(product_code, ''), '[^A-Za-z]', '', 'g'), 3))) STORED,
  k_numbers                  text[] NOT NULL DEFAULT '{}',
  recall_status              varchar(32),
  event_date_initiated       date,
  event_date_posted          date,
  event_date_terminated      date,
  recalling_firm             text,
  reason_for_recall          text,
  root_cause_description     text,
  raw                        jsonb NOT NULL,
  synced_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fda_recall_k_numbers_idx ON fda_recall USING gin (k_numbers);
CREATE INDEX IF NOT EXISTS fda_recall_product_code_idx ON fda_recall (product_code_norm, event_date_initiated DESC);

CREATE TABLE IF NOT EXISTS fda_udi (
  public_device_record_key   uuid PRIMARY KEY,
  primary_di                 varchar(64),
  brand_name                 text,
  version_or_model_number    text,
  company_name               text,
  product_codes              text[] NOT NULL DEFAULT '{}',
  premarket_submissions      text[] NOT NULL DEFAULT '{}',
  commercial_distribution_status text,
  public_version_date        date,
  raw                        jsonb NOT NULL,
  synced_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fda_udi_primary_di_idx ON fda_udi (primary_di);
CREATE INDEX IF NOT EXISTS fda_udi_product_codes_idx ON fda_udi USING gin (product_codes);
CREATE INDEX IF NOT EXISTS fda_udi_premarket_idx ON fda_udi USING gin (premarket_submissions);

-- Adverse event (MAUDE) report counts per product code and receive date, from
-- openFDA count queries (device/event.json?count=date_received).
CREATE TABLE IF NOT EXISTS fda_event_counts (
  product_code               varchar(3) NOT NULL,
  received_date              date NOT NULL,
  report_count               integer NOT NULL CHECK (report_count >= 0),
  synced_at                  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_code, received_date)
);

-- One row per sync run and dataset: what ran, how far it got, and the source's
-- own last_updated date, which is what the UI shows as "data as of".
CREATE TABLE IF NOT EXISTS fda_sync_runs (
  id                         bigserial PRIMARY KEY,
  dataset                    varchar(32) NOT NULL,
  mode                       varchar(8) NOT NULL,
  status                     varchar(16) NOT NULL DEFAULT 'running',
  started_at                 timestamptz NOT NULL DEFAULT now(),
  finished_at                timestamptz,
  window_from                date,
  window_to                  date,
  records_upserted           integer NOT NULL DEFAULT 0,
  source_last_updated        date,
  error                      text,
  CONSTRAINT fda_sync_runs_dataset_chk CHECK (dataset IN ('510k', 'classification', 'recall', 'udi', 'event_counts')),
  CONSTRAINT fda_sync_runs_mode_chk CHECK (mode IN ('delta', 'bulk')),
  CONSTRAINT fda_sync_runs_status_chk CHECK (status IN ('running', 'succeeded', 'failed'))
);
CREATE INDEX IF NOT EXISTS fda_sync_runs_dataset_idx ON fda_sync_runs (dataset, started_at DESC);

-- Search support for GET /v1/510k (applicant and device-name substring search).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS fda_510k_applicant_trgm_idx ON fda_510k USING gin (applicant gin_trgm_ops);
CREATE INDEX IF NOT EXISTS fda_510k_device_name_trgm_idx ON fda_510k USING gin (device_name gin_trgm_ops);
