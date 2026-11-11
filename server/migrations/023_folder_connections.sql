-- F2.1 Read-only folder connections (PRD v2.0 FR-14.1): a firm connects Dropbox,
-- Box, SharePoint/OneDrive or Google Drive with a read-only OAuth grant, links a
-- client folder to a project, and changes in that folder become new file versions
-- (provider change feed, plus a nightly hash sweep).
--
-- Tokens are stored sealed (AES-256-GCM, utils/secretBox.ts) with the connection id
-- bound as associated data, so a copied ciphertext never decrypts on another row.
-- They are never returned by the API. Disconnecting revokes the grant at the provider,
-- clears both tokens here and stops every link that used the connection.

CREATE TABLE IF NOT EXISTS folder_connections (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  provider             varchar(16) NOT NULL,
  -- Who connected it at the provider (shown to the firm; e.g. "ana@client-files.com").
  account_label        varchar(320) NOT NULL,
  -- The provider's own id for that account: one active connection per provider account.
  external_account_id  varchar(255) NOT NULL,
  -- The scopes the provider actually granted (checked to be read-only on connect).
  scopes               text[] NOT NULL DEFAULT '{}',
  -- active | needs_reauth (refresh failed; links paused) | revoked
  status               varchar(12) NOT NULL DEFAULT 'active',
  access_token_sealed  text,
  refresh_token_sealed text,
  token_expires_at     timestamptz,
  last_error           varchar(500),
  created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  revoked_at           timestamptz,
  revoked_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT folder_connections_id_org_uq UNIQUE (id, org_id),
  CONSTRAINT folder_connections_provider_chk CHECK (provider IN ('dropbox', 'box', 'onedrive', 'google_drive')),
  CONSTRAINT folder_connections_status_chk CHECK (status IN ('active', 'needs_reauth', 'revoked')),
  -- A revoked connection keeps no token material at all.
  CONSTRAINT folder_connections_revoked_chk CHECK (
    status <> 'revoked' OR (access_token_sealed IS NULL AND refresh_token_sealed IS NULL AND revoked_at IS NOT NULL)),
  CONSTRAINT folder_connections_active_token_chk CHECK (status = 'revoked' OR access_token_sealed IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS folder_connections_account_uq
  ON folder_connections (org_id, provider, external_account_id) WHERE status <> 'revoked';
CREATE INDEX IF NOT EXISTS folder_connections_org_idx ON folder_connections (org_id, created_at DESC, id DESC);

-- A client folder linked to a project through a connection.
CREATE TABLE IF NOT EXISTS project_folder_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  project_id      uuid NOT NULL,
  connection_id   uuid NOT NULL,
  -- The provider's stable id for the folder, and its path when linked (for display).
  folder_id       varchar(512) NOT NULL,
  folder_path     varchar(1024) NOT NULL,
  -- active | paused (connection needs re-authorisation) | unlinked
  status          varchar(10) NOT NULL DEFAULT 'active',
  -- Provider change-feed cursor (Dropbox list_folder cursor, Box stream position,
  -- Graph deltaLink, Drive pageToken); NULL until the first full listing.
  change_cursor   text,
  last_sync_at    timestamptz,
  -- Nightly hash sweep: compares every linked file's content hash with ours.
  last_sweep_at   timestamptz,
  next_sync_at    timestamptz NOT NULL DEFAULT now(),
  sync_claimed_at timestamptz,
  sync_attempts   integer NOT NULL DEFAULT 0 CHECK (sync_attempts >= 0),
  last_error      varchar(500),
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  unlinked_at     timestamptz,
  CONSTRAINT project_folder_links_id_org_uq UNIQUE (id, org_id),
  CONSTRAINT project_folder_links_project_fk FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  CONSTRAINT project_folder_links_connection_fk FOREIGN KEY (connection_id, org_id) REFERENCES folder_connections (id, org_id) ON DELETE CASCADE,
  CONSTRAINT project_folder_links_status_chk CHECK (status IN ('active', 'paused', 'unlinked'))
);
-- A folder is linked to a project at most once while active.
CREATE UNIQUE INDEX IF NOT EXISTS project_folder_links_active_uq
  ON project_folder_links (project_id, connection_id, folder_id) WHERE status <> 'unlinked';
CREATE INDEX IF NOT EXISTS project_folder_links_project_idx ON project_folder_links (org_id, project_id, created_at DESC, id DESC);
-- The sync job's work list: active links that are due.
CREATE INDEX IF NOT EXISTS project_folder_links_due_idx ON project_folder_links (next_sync_at) WHERE status = 'active';

-- One OAuth round trip (authorize -> callback). The callback arrives from the
-- browser without our session, so it is found by the SHA-256 of the state value;
-- PKCE's code verifier is sealed. Rows expire after 10 minutes and are single-use.
CREATE TABLE IF NOT EXISTS connection_oauth_states (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id                uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider               varchar(16) NOT NULL,
  token_hash             char(64) NOT NULL UNIQUE,  -- SHA-256 of the OAuth state value
  code_verifier_sealed   text NOT NULL,
  -- Where to send the browser back (an app path, validated on the way in).
  return_path            varchar(300) NOT NULL DEFAULT '/app/connections',
  created_at             timestamptz NOT NULL DEFAULT now(),
  expires_at             timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
  used_at                timestamptz,
  CONSTRAINT connection_oauth_states_provider_chk CHECK (provider IN ('dropbox', 'box', 'onedrive', 'google_drive')),
  CONSTRAINT connection_oauth_states_return_chk CHECK (return_path ~ '^/app(/[A-Za-z0-9/_-]*)?$')
);
CREATE INDEX IF NOT EXISTS connection_oauth_states_expiry_idx ON connection_oauth_states (expires_at) WHERE used_at IS NULL;

-- Files can now come from a linked folder through a specific link.
ALTER TABLE files ADD COLUMN IF NOT EXISTS folder_link_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'files_folder_link_fk') THEN
    ALTER TABLE files ADD CONSTRAINT files_folder_link_fk FOREIGN KEY (folder_link_id, org_id)
      REFERENCES project_folder_links (id, org_id) ON DELETE SET NULL (folder_link_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS files_folder_link_idx ON files (folder_link_id) WHERE folder_link_id IS NOT NULL;
