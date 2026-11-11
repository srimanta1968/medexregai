-- F2.5 Trust pack (PRD v2.0 FR-14.16, FR-14.17, NFR-8, NFR-14).
--
-- Data-use settings live on the firm. AI training on client data is not a setting:
-- it is never allowed (NFR-8), so there is no column that could turn it on.
-- Product-improvement use is consent the firm gives; it is off by default.

ALTER TABLE orgs ADD COLUMN IF NOT EXISTS product_improvement_use boolean NOT NULL DEFAULT false;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS data_use_updated_at timestamptz;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS data_use_updated_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- Per-project deletion (NFR-14). The request removes the project's database rows in
-- one transaction (every project table cascades from projects); the worker then
-- removes the stored file objects and issues the certificate. The row outlives the
-- project on purpose: it is the deletion record the certificate is built from.
-- project_name and client_name are the firm's own labels, kept so the certificate
-- says what was deleted; no client file content is kept here.
CREATE TABLE IF NOT EXISTS project_deletions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id          uuid NOT NULL,
  -- Names as they were at deletion: the certificate's fingerprint covers them.
  firm_name           varchar(200) NOT NULL,
  project_name        varchar(200) NOT NULL,
  client_name         varchar(200) NOT NULL,
  device_name         varchar(200) NOT NULL,
  -- removing_files: database rows are gone, stored objects are being removed.
  status              varchar(16) NOT NULL DEFAULT 'removing_files',
  -- Rows removed per category, counted in the deleting transaction.
  counts              jsonb NOT NULL DEFAULT '{}'::jsonb,
  objects_total       integer NOT NULL DEFAULT 0 CHECK (objects_total >= 0),
  objects_removed     integer NOT NULL DEFAULT 0 CHECK (objects_removed >= 0),
  -- Backup retention stated on the certificate (config BACKUP_RETENTION_DAYS at request time).
  backup_retention_days integer NOT NULL CHECK (backup_retention_days > 0),
  attempts            integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error          varchar(500),
  requested_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_by_name   varchar(200) NOT NULL,
  requested_at        timestamptz NOT NULL DEFAULT now(),
  -- The committed deadline (requested_at + 30 days, NFR-14).
  due_by              timestamptz NOT NULL,
  rows_deleted_at     timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  -- SHA-256 of the certificate's canonical text, fixed when the deletion completes.
  certificate_sha256  char(64),
  CONSTRAINT project_deletions_id_org_uq UNIQUE (id, org_id),
  CONSTRAINT project_deletions_project_uq UNIQUE (project_id),
  CONSTRAINT project_deletions_status_chk CHECK (status IN ('removing_files', 'completed')),
  CONSTRAINT project_deletions_done_chk CHECK (
    (status = 'completed') = (completed_at IS NOT NULL AND certificate_sha256 IS NOT NULL)
  ),
  CONSTRAINT project_deletions_due_chk CHECK (due_by > requested_at)
);
CREATE INDEX IF NOT EXISTS project_deletions_org_idx ON project_deletions (org_id, requested_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS project_deletions_pending_idx ON project_deletions (requested_at) WHERE status = 'removing_files';

-- Storage prefixes still to remove (one per file of the deleted project). A prefix
-- covers every version of the file, including an object written by an upload that
-- was in flight when the project was deleted. Rows are removed as prefixes are.
CREATE TABLE IF NOT EXISTS project_deletion_objects (
  deletion_id  uuid NOT NULL,
  org_id       uuid NOT NULL,
  prefix       varchar(512) NOT NULL,
  PRIMARY KEY (deletion_id, prefix),
  CONSTRAINT project_deletion_objects_deletion_fk FOREIGN KEY (deletion_id, org_id)
    REFERENCES project_deletions (id, org_id) ON DELETE CASCADE
);
