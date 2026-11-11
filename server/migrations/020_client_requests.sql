-- F2.4 client requests and no-login upload links (PRD FR-14.9).
--
-- A consultant drafts a request for missing evidence (items), edits and approves it;
-- approval issues an expiring upload link. The client opens the link on a phone and
-- uploads files without an account; each file becomes a file version of the project
-- (source 'request') and marks its item received. Nothing is sent before approval.
--
-- client_requests.status  draft -> open (approved, link issued) -> closed
CREATE TABLE IF NOT EXISTS client_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  project_id       uuid NOT NULL,
  title            varchar(200) NOT NULL,
  -- The message the client reads, written or edited by the consultant.
  message          text NOT NULL DEFAULT '',
  recipient_name   varchar(200),
  recipient_email  varchar(320),
  status           varchar(8) NOT NULL DEFAULT 'draft',
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at      timestamptz,
  -- Email delivery of the approved request (TK-4627): not_sent | sent | failed
  email_status     varchar(8) NOT NULL DEFAULT 'not_sent',
  email_error      text,
  emailed_at       timestamptz,
  closed_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_requests_id_org_uq UNIQUE (id, org_id),
  CONSTRAINT client_requests_project_fk FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  CONSTRAINT client_requests_status_chk CHECK (status IN ('draft', 'open', 'closed')),
  CONSTRAINT client_requests_email_status_chk CHECK (email_status IN ('not_sent', 'sent', 'failed')),
  CONSTRAINT client_requests_approved_chk CHECK (status = 'draft' OR approved_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS client_requests_project_idx ON client_requests (org_id, project_id, created_at DESC, id DESC);

-- What is asked for. section_id: the submission section the evidence is for, so a file
-- uploaded against the item is filed there. gap_ref: the gap it came from (F2.3), when it did.
-- status: requested -> received (a file arrived against it)
CREATE TABLE IF NOT EXISTS client_request_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  request_id       uuid NOT NULL,
  position         smallint NOT NULL,
  label            varchar(200) NOT NULL,
  detail           varchar(1000) NOT NULL DEFAULT '',
  section_id       varchar(64),
  gap_ref          varchar(100),
  status           varchar(10) NOT NULL DEFAULT 'requested',
  received_at      timestamptz,
  received_count   integer NOT NULL DEFAULT 0 CHECK (received_count >= 0),
  CONSTRAINT client_request_items_id_org_uq UNIQUE (id, org_id),
  CONSTRAINT client_request_items_request_fk FOREIGN KEY (request_id, org_id) REFERENCES client_requests (id, org_id) ON DELETE CASCADE,
  CONSTRAINT client_request_items_status_chk CHECK (status IN ('requested', 'received')),
  CONSTRAINT client_request_items_position_uq UNIQUE (request_id, position)
);

-- The no-login link. Only the SHA-256 of the token is stored; the token is shown to the
-- consultant once, when the link is issued. One active link per request at a time.
CREATE TABLE IF NOT EXISTS upload_links (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  request_id       uuid NOT NULL,
  token_hash       char(64) NOT NULL UNIQUE,
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  revoked_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  max_files        integer NOT NULL DEFAULT 50 CHECK (max_files > 0),
  files_received   integer NOT NULL DEFAULT 0 CHECK (files_received >= 0),
  last_used_at     timestamptz,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT upload_links_request_fk FOREIGN KEY (request_id, org_id) REFERENCES client_requests (id, org_id) ON DELETE CASCADE,
  CONSTRAINT upload_links_expiry_chk CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS upload_links_one_active_uq ON upload_links (request_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS upload_links_request_idx ON upload_links (org_id, request_id, created_at DESC);

-- Malware scan result of every stored upload (link and API): not_scanned | clean.
-- Infected files are refused before anything is stored, so there is no 'infected' row.
ALTER TABLE file_versions ADD COLUMN IF NOT EXISTS scan_status varchar(12) NOT NULL DEFAULT 'not_scanned';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'file_versions_scan_status_chk') THEN
    ALTER TABLE file_versions ADD CONSTRAINT file_versions_scan_status_chk CHECK (scan_status IN ('not_scanned', 'clean'));
  END IF;
END $$;
