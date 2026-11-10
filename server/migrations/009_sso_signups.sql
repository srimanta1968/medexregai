-- F0.1 Sign up with Google / Microsoft.
-- When a provider-verified identity has no MedexRegAI account, the callback stores
-- it here behind a one-time code and sends the browser to /signup/sso, where the
-- person names their firm. Single use, 15-minute lifetime; the identity details
-- come only from the verified ID token, never from the browser.
CREATE TABLE IF NOT EXISTS sso_signups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  char(64) NOT NULL UNIQUE,
  provider    varchar(32) NOT NULL,
  subject     varchar(255) NOT NULL,
  email       varchar(254) NOT NULL,
  full_name   varchar(200),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sso_signups_expires_idx ON sso_signups (expires_at) WHERE used_at IS NULL;
