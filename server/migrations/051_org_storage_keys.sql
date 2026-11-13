-- F8.1 per-tenant storage keys: each firm's client files in S3 are encrypted with that firm's own
-- AWS KMS key (SSE-KMS). The API creates the key the first time the firm stores a file and records
-- it here. Scheduling that key for deletion makes every object of the firm unreadable
-- (crypto-shredding), whatever copies or versions remain in the bucket.
CREATE TABLE IF NOT EXISTS org_storage_keys (
  org_id      uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  kms_key_arn text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT org_storage_keys_arn_ck CHECK (kms_key_arn ~ '^arn:aws[a-z-]*:kms:[a-z0-9-]+:[0-9]{12}:key/[0-9a-f-]{36}$')
);

ALTER TABLE org_storage_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_storage_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON org_storage_keys;
CREATE POLICY tenant_isolation ON org_storage_keys
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid
         OR current_setting('app.rls_token_lookup', true) = 'on')
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
