-- F7.4 evaluation harness. A run scores one model against the gold sets in
-- server/src/ai/eval/sets (classification, contradiction, drafting, versions,
-- injection) through the same prompts and output checks the product uses.
-- Gold sets are fictional, so neither table holds client content.
--
-- scores      { classification: { accuracy, n }, contradiction: { precision, recall, n },
--               drafting: { acceptance, citationPrecision, n }, injection: { resistance, n },
--               versions: { status: 'not_run' } }
-- thresholds  the gate applied, e.g. { classification: 0.9, contradiction: 0.7, drafting: 0.7, injection: 1 }
-- failures    a sample of failed items (id, set, why), for the report page
--
-- status: queued -> running -> passed | failed (below a threshold) | error (could not finish)

-- A firm's own model (F7.1 BYO). Passing sets firm_model_providers.eval_status = 'passed',
-- which is what lets that model serve drafting.
CREATE TABLE IF NOT EXISTS eval_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  provider_id       uuid NOT NULL,
  status            varchar(8) NOT NULL DEFAULT 'queued',
  provider          varchar(24),
  model             varchar(128),
  sets_version      varchar(32) NOT NULL,
  registry_version  varchar(32) NOT NULL,
  checks_version    varchar(32) NOT NULL,
  scores            jsonb NOT NULL DEFAULT '{}'::jsonb,
  thresholds        jsonb NOT NULL DEFAULT '{}'::jsonb,
  failures          jsonb NOT NULL DEFAULT '[]'::jsonb,
  error             text,
  requested_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz,
  CONSTRAINT eval_runs_provider_fk FOREIGN KEY (provider_id, org_id) REFERENCES firm_model_providers (id, org_id) ON DELETE CASCADE,
  CONSTRAINT eval_runs_status_chk CHECK (status IN ('queued', 'running', 'passed', 'failed', 'error'))
);
CREATE INDEX IF NOT EXISTS eval_runs_provider_idx ON eval_runs (org_id, provider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS eval_runs_queued_idx ON eval_runs (org_id, created_at) WHERE status = 'queued';
-- At most one queued or running evaluation per provider.
CREATE UNIQUE INDEX IF NOT EXISTS eval_runs_one_active_uq ON eval_runs (provider_id) WHERE status IN ('queued', 'running');

-- Our own models (platform baseline): run by operators with `npm run eval`, shown to
-- firms as the baseline a firm model is compared with, and summarised in the model card.
CREATE TABLE IF NOT EXISTS platform_eval_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status            varchar(8) NOT NULL,
  provider          varchar(24) NOT NULL,
  model             varchar(128) NOT NULL,
  sets_version      varchar(32) NOT NULL,
  registry_version  varchar(32) NOT NULL,
  checks_version    varchar(32) NOT NULL,
  scores            jsonb NOT NULL DEFAULT '{}'::jsonb,
  thresholds        jsonb NOT NULL DEFAULT '{}'::jsonb,
  failures          jsonb NOT NULL DEFAULT '[]'::jsonb,
  error             text,
  -- Who ran it and why (e.g. "model change qwen2.5:7b -> qwen2.5:14b"), free text from the operator.
  note              varchar(500),
  started_at        timestamptz NOT NULL,
  finished_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_eval_runs_status_chk CHECK (status IN ('passed', 'failed', 'error'))
);
CREATE INDEX IF NOT EXISTS platform_eval_runs_finished_idx ON platform_eval_runs (finished_at DESC);
