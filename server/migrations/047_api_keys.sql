-- F6.3 API keys: a firm's scoped keys for the public API (/api/v1). The secret is shown once at
-- creation; only its SHA-256 (token_hash) is stored, plus a short prefix to recognise it.
-- Keys work only on /api/v1 routes, each of which names the scope it needs.

CREATE TABLE IF NOT EXISTS api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name          varchar(100) NOT NULL,
  -- First characters of the secret (e.g. "mrk_AbC123"), safe to show in lists.
  prefix        varchar(16) NOT NULL,
  token_hash    char(64) NOT NULL,
  -- portfolio:read | fda:read
  scopes        text[] NOT NULL,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  revoked_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT api_keys_token_hash_uq UNIQUE (token_hash),
  CONSTRAINT api_keys_scopes_chk CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY['portfolio:read','fda:read']::text[]),
  CONSTRAINT api_keys_revoked_chk CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) OR revoked_by IS NULL)
);
-- A firm's keys, newest first (cursor paging).
CREATE INDEX IF NOT EXISTS api_keys_org_created_idx ON api_keys (org_id, created_at DESC, id DESC);
