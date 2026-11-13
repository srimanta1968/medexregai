-- F4.4 hardening before the external penetration test (docs/compliance/pentest-scope.md §7;
-- SOC 2 register CC6-04, CC6-05).
--
-- auth_attempts: sign-in attempts, kept for a day, so repeated failures are throttled per
-- account and per IP address across every API instance. subject is a SHA-256 of
-- "acct:<email or user id>" or "ip:<address>", so the table holds no emails or addresses.
--
-- user_mfa: an authenticator-app (TOTP, RFC 6238) second factor for password sign-in. The
-- secret is encrypted with the app's secret box; recovery codes are stored as SHA-256 hashes
-- and each works once. enabled_at is NULL while setup is pending.

CREATE TABLE IF NOT EXISTS auth_attempts (
  id         bigserial PRIMARY KEY,
  action     varchar(20) NOT NULL,
  subject    char(64) NOT NULL,
  failed     boolean NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_attempts_action_chk CHECK (action IN ('login', 'password_reset', 'sso_exchange', 'mfa'))
);
CREATE INDEX IF NOT EXISTS auth_attempts_lookup_idx ON auth_attempts (action, subject, at);
CREATE INDEX IF NOT EXISTS auth_attempts_at_idx ON auth_attempts (at);

CREATE TABLE IF NOT EXISTS user_mfa (
  user_id         uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_enc      text NOT NULL,
  enabled_at      timestamptz,
  last_used_step  bigint,
  recovery_hashes jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
