-- F7.1 Bring-your-own model: a firm adds its own provider (OpenAI-compatible
-- endpoint or Claude API) with its own API key. The key is stored encrypted
-- (AES-256-GCM, bound to org and row, see server/src/utils/secretBox.ts) and is
-- write-only: no API ever returns it, only its last four characters.
-- Embeddings always stay on our platform model so every index uses one vector space.

CREATE TABLE IF NOT EXISTS firm_model_providers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name              varchar(80) NOT NULL,
  kind              varchar(24) NOT NULL,
  base_url          varchar(500) NOT NULL,
  generation_model  varchar(128) NOT NULL,
  key_ciphertext    text NOT NULL,
  key_hint          varchar(4) NOT NULL,
  key_version       smallint NOT NULL DEFAULT 1,
  -- Connection test: reachable, key accepted, model present.
  test_status       varchar(8) NOT NULL DEFAULT 'untested',
  tested_at         timestamptz,
  test_error        varchar(300),
  -- Evaluation gate (F7.4): must pass before the model drafts submission text.
  eval_status       varchar(8) NOT NULL DEFAULT 'not_run',
  eval_at           timestamptz,
  -- AI routes this firm sends to this provider instead of our platform model.
  enabled_routes    text[] NOT NULL DEFAULT '{}',
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT firm_model_providers_id_org_uq UNIQUE (id, org_id),
  CONSTRAINT firm_model_providers_kind_chk CHECK (kind IN ('openai_compatible', 'anthropic')),
  CONSTRAINT firm_model_providers_test_chk CHECK (test_status IN ('untested', 'passed', 'failed')),
  CONSTRAINT firm_model_providers_eval_chk CHECK (eval_status IN ('not_run', 'running', 'passed', 'failed')),
  -- Firm endpoints are called from our servers: HTTPS only (SSRF checks run in the service).
  CONSTRAINT firm_model_providers_https_chk CHECK (base_url ~ '^https://'),
  -- No route may use a provider that has not passed its connection test.
  CONSTRAINT firm_model_providers_routes_need_test_chk CHECK (cardinality(enabled_routes) = 0 OR test_status = 'passed'),
  -- Drafting additionally needs the evaluation gate.
  CONSTRAINT firm_model_providers_draft_needs_eval_chk CHECK (NOT ('draft' = ANY (enabled_routes)) OR eval_status = 'passed')
);
CREATE UNIQUE INDEX IF NOT EXISTS firm_model_providers_org_name_uq ON firm_model_providers (org_id, lower(name));
CREATE INDEX IF NOT EXISTS firm_model_providers_org_created_idx ON firm_model_providers (org_id, created_at DESC, id DESC);
