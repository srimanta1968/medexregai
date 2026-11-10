-- F7.1 AI metering: one row per AI request, per-project rollups, and a 2x-estimate
-- alert. Cost is in US dollars at the price list in server/src/ai/pricing.ts; our
-- self-hosted models cost $0 per token, so tokens are metered and alerted too.

-- What the firm expects a project to use. Either or both may be set.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS ai_cost_estimate_usd numeric(12, 4)
  CHECK (ai_cost_estimate_usd IS NULL OR ai_cost_estimate_usd > 0);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS ai_token_estimate bigint
  CHECK (ai_token_estimate IS NULL OR ai_token_estimate > 0);
-- Composite key so tenant children can reference (id, org_id).
DO $$ BEGIN
  ALTER TABLE projects ADD CONSTRAINT projects_id_org_uq UNIQUE (id, org_id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS ai_calls (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- NULL for firm-level calls not tied to a submission (e.g. a provider connection test).
  project_id     uuid,
  route          varchar(32) NOT NULL,
  provider       varchar(24) NOT NULL,
  model          varchar(128) NOT NULL,
  -- Who supplied the model: our platform, or the firm's own key (F7.1 BYO).
  source         varchar(8) NOT NULL DEFAULT 'platform',
  input_tokens   integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens  integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  -- NULL when the price is unknown (a firm's own endpoint); 0 for our self-hosted models.
  cost_usd       numeric(12, 6) CHECK (cost_usd IS NULL OR cost_usd >= 0),
  latency_ms     integer NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
  status         varchar(8) NOT NULL,
  error_code     varchar(32),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_calls_project_fk FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  CONSTRAINT ai_calls_status_chk CHECK (status IN ('ok', 'error')),
  CONSTRAINT ai_calls_source_chk CHECK (source IN ('platform', 'firm'))
);
CREATE INDEX IF NOT EXISTS ai_calls_project_created_idx ON ai_calls (org_id, project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_calls_org_created_idx ON ai_calls (org_id, created_at DESC);

-- Running totals, updated in the same transaction as each ai_calls insert.
CREATE TABLE IF NOT EXISTS ai_project_usage (
  project_id     uuid PRIMARY KEY,
  org_id         uuid NOT NULL,
  calls          integer NOT NULL DEFAULT 0,
  failed_calls   integer NOT NULL DEFAULT 0,
  input_tokens   bigint NOT NULL DEFAULT 0,
  output_tokens  bigint NOT NULL DEFAULT 0,
  cost_usd       numeric(14, 6) NOT NULL DEFAULT 0,
  -- Calls whose price was unknown, so cost_usd is a lower bound when > 0.
  unpriced_calls integer NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_project_usage_project_fk FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE
);

-- One alert per project and kind, raised the first time usage passes 2x the estimate.
CREATE TABLE IF NOT EXISTS ai_cost_alerts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  project_id     uuid NOT NULL,
  kind           varchar(8) NOT NULL,
  estimate       numeric(16, 4) NOT NULL,
  actual         numeric(16, 4) NOT NULL,
  raised_at      timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  CONSTRAINT ai_cost_alerts_project_fk FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  CONSTRAINT ai_cost_alerts_kind_chk CHECK (kind IN ('cost', 'tokens')),
  CONSTRAINT ai_cost_alerts_once_uq UNIQUE (project_id, kind)
);
CREATE INDEX IF NOT EXISTS ai_cost_alerts_open_idx ON ai_cost_alerts (raised_at DESC) WHERE acknowledged_at IS NULL;
