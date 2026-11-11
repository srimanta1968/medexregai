-- F2.2 Version and duplicate detection: files that are revisions or copies of the
-- same document are grouped; the current one is chosen only when that is clear.
-- When it is not (two candidates for "latest", no revision information), the group
-- is 'unclear' and the consultant is asked: the tool never chooses silently.
CREATE TABLE IF NOT EXISTS file_revision_groups (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  project_id       uuid NOT NULL,
  -- Normalised base name the files share (revision and copy markers removed).
  base_key         varchar(300) NOT NULL,
  -- clear (one latest revision) | unclear (ask) | confirmed (a consultant chose)
  status           varchar(10) NOT NULL,
  current_file_id  uuid,
  reason           varchar(500) NOT NULL,
  -- Fingerprint of the members (file ids + latest sha256) when last worked out;
  -- a consultant's choice stands until this changes.
  members_hash     char(64) NOT NULL,
  confirmed_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT file_revision_groups_id_org_uq UNIQUE (id, org_id),
  CONSTRAINT file_revision_groups_project_fk FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  -- Removing the current file drops the group; the next detection works it out again from the rest.
  CONSTRAINT file_revision_groups_current_fk FOREIGN KEY (current_file_id, org_id) REFERENCES files (id, org_id) ON DELETE CASCADE,
  CONSTRAINT file_revision_groups_status_chk CHECK (status IN ('clear', 'unclear', 'confirmed')),
  CONSTRAINT file_revision_groups_current_chk CHECK (status = 'unclear' OR current_file_id IS NOT NULL),
  CONSTRAINT file_revision_groups_key_uq UNIQUE (project_id, base_key)
);
CREATE INDEX IF NOT EXISTS file_revision_groups_project_idx ON file_revision_groups (org_id, project_id, status);

CREATE TABLE IF NOT EXISTS file_revision_members (
  group_id        uuid NOT NULL,
  org_id          uuid NOT NULL,
  file_id         uuid NOT NULL,
  -- As read from the name or the drawing title block ("C", "C1", "3"); NULL if none.
  revision_label  varchar(20),
  revision_from   varchar(12),
  -- current | superseded | duplicate (same bytes as another member) | candidate (unclear group)
  role            varchar(10) NOT NULL,
  PRIMARY KEY (group_id, file_id),
  CONSTRAINT file_revision_members_group_fk FOREIGN KEY (group_id, org_id) REFERENCES file_revision_groups (id, org_id) ON DELETE CASCADE,
  CONSTRAINT file_revision_members_file_fk FOREIGN KEY (file_id, org_id) REFERENCES files (id, org_id) ON DELETE CASCADE,
  CONSTRAINT file_revision_members_role_chk CHECK (role IN ('current', 'superseded', 'duplicate', 'candidate')),
  CONSTRAINT file_revision_members_from_chk CHECK (revision_from IS NULL OR revision_from IN ('name', 'title_block'))
);
CREATE INDEX IF NOT EXISTS file_revision_members_file_idx ON file_revision_members (file_id);
