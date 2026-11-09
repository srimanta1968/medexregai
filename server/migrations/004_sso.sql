-- F0.1 Google and Microsoft SSO (OIDC).

-- A verified external identity linked to a MedexRegAI account. Once linked, sign-in
-- matches on (provider, subject), never on email, so a changed or recycled email at
-- the provider cannot take over the account.
CREATE TABLE IF NOT EXISTS user_identities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    varchar(32) NOT NULL,
  subject     varchar(255) NOT NULL,
  email       varchar(255) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  CONSTRAINT user_identities_provider_subject_uq UNIQUE (provider, subject),
  CONSTRAINT user_identities_user_provider_uq UNIQUE (user_id, provider)
);

-- One-time code the browser trades for a session after the provider redirect, so
-- access and refresh tokens never appear in a URL. Single use, 2-minute lifetime.
CREATE TABLE IF NOT EXISTS sso_handoffs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  char(64) NOT NULL UNIQUE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sso_handoffs_expires_idx ON sso_handoffs (expires_at) WHERE used_at IS NULL;
