-- F2.1 Per-project forwarding address (PRD v2.0 FR-14.2): where no folder connector
-- is allowed, the consultant (or the client, if allowed) forwards attachments to the
-- project's own address and they land in the project within 2 minutes.
--
-- The address's local part carries a random token, so it cannot be guessed from the
-- project name; it can be turned off and replaced. Mail is accepted only from the
-- firm's members and the senders the consultant allows (an address, or @domain).
-- The relay posts the raw message; it is stored, then parsed by the worker. The raw
-- copy is deleted once processed; only the outcome per attachment is kept.

CREATE TABLE IF NOT EXISTS project_inbound_addresses (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  project_id       uuid NOT NULL,
  -- e.g. dc-100-traditional-510-k.k7m2q9xw4t (the domain comes from INBOUND_EMAIL_DOMAIN)
  local_part       varchar(64) NOT NULL UNIQUE,
  -- SHA-256 of local_part: the relay looks the address up by it before any firm is known.
  token_hash       char(64) NOT NULL UNIQUE,
  -- Allowed besides the firm's members: "name@client.com" or "@client.com".
  allowed_senders  text[] NOT NULL DEFAULT '{}',
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz,
  revoked_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT project_inbound_addresses_id_org_uq UNIQUE (id, org_id),
  CONSTRAINT project_inbound_addresses_project_fk FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  CONSTRAINT project_inbound_addresses_local_chk CHECK (local_part ~ '^[a-z0-9][a-z0-9.-]{2,63}$'),
  CONSTRAINT project_inbound_addresses_senders_chk CHECK (cardinality(allowed_senders) <= 50)
);
-- One active address per project.
CREATE UNIQUE INDEX IF NOT EXISTS project_inbound_addresses_active_uq ON project_inbound_addresses (project_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS inbound_emails (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  project_id     uuid NOT NULL,
  address_id     uuid NOT NULL,
  -- queued -> processing -> accepted | rejected | failed
  status         varchar(10) NOT NULL DEFAULT 'queued',
  reason         varchar(300),
  from_address   varchar(320),
  subject        varchar(300),
  message_id     varchar(300),
  size_bytes     integer NOT NULL CHECK (size_bytes >= 0),
  -- Raw message until processed (NULL afterwards).
  storage_key    varchar(512),
  -- [{ name, sizeBytes, outcome: stored | unchanged | refused, reason?, fileId? }]
  attachments    jsonb NOT NULL DEFAULT '[]'::jsonb,
  attempts       integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claimed_at     timestamptz,
  received_at    timestamptz NOT NULL DEFAULT now(),
  processed_at   timestamptz,
  CONSTRAINT inbound_emails_id_org_uq UNIQUE (id, org_id),
  CONSTRAINT inbound_emails_project_fk FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  CONSTRAINT inbound_emails_address_fk FOREIGN KEY (address_id, org_id) REFERENCES project_inbound_addresses (id, org_id) ON DELETE CASCADE,
  CONSTRAINT inbound_emails_status_chk CHECK (status IN ('queued', 'processing', 'accepted', 'rejected', 'failed')),
  CONSTRAINT inbound_emails_raw_chk CHECK (status IN ('queued', 'processing') OR storage_key IS NULL)
);
CREATE INDEX IF NOT EXISTS inbound_emails_project_idx ON inbound_emails (org_id, project_id, received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS inbound_emails_queue_idx ON inbound_emails (received_at) WHERE status IN ('queued', 'processing');
-- The same message delivered twice (relay retry) is stored once.
CREATE UNIQUE INDEX IF NOT EXISTS inbound_emails_message_uq ON inbound_emails (address_id, message_id) WHERE message_id IS NOT NULL;

-- Files can now arrive by email.
ALTER TABLE files DROP CONSTRAINT IF EXISTS files_source_chk;
ALTER TABLE files ADD CONSTRAINT files_source_chk CHECK (source IN ('upload', 'linked', 'request', 'email'));
