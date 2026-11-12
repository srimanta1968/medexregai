-- F3.3 Revision impact.
--
-- statement_sources: the statement -> source graph. One row per client citation of a draft
-- statement (draft_statements.citations, migration 031), naming the file version (and its
-- file) it cites. When a client sends a new version of a file, every statement citing an
-- older version of that file is found through file_id.
--
-- impact_actions: what the consultant chose for an item a new version affects (re-draft,
-- re-check, mark received, keep as is). Nothing is changed for them; this records the choice.

CREATE TABLE IF NOT EXISTS statement_sources (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  statement_id     uuid NOT NULL REFERENCES draft_statements(id) ON DELETE CASCADE,
  draft_id         uuid NOT NULL,
  file_version_id  uuid NOT NULL,
  file_id          uuid NOT NULL,
  locator          varchar(40) NOT NULL,
  CONSTRAINT statement_sources_uq UNIQUE (statement_id, file_version_id, locator)
);
CREATE INDEX IF NOT EXISTS statement_sources_file_idx ON statement_sources (org_id, file_id, file_version_id);
CREATE INDEX IF NOT EXISTS statement_sources_draft_idx ON statement_sources (org_id, draft_id);

-- Backfill the drafts written before this migration.
INSERT INTO statement_sources (org_id, statement_id, draft_id, file_version_id, file_id, locator)
SELECT st.org_id, st.id, st.draft_id, v.id, v.file_id, m[2]
  FROM draft_statements st
  CROSS JOIN LATERAL jsonb_array_elements(st.citations) c
  CROSS JOIN LATERAL regexp_match(c->>'marker', '^\[C:([0-9a-fA-F-]{36})#([^\]]{1,40})\]$') m
  JOIN file_versions v ON v.id = m[1]::uuid AND v.org_id = st.org_id
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS impact_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  project_id      uuid NOT NULL,
  new_version_id  uuid NOT NULL REFERENCES file_versions(id) ON DELETE CASCADE,
  -- draft:<project_section_id> | problem:<id> | request_item:<id>
  item_key        varchar(80) NOT NULL,
  -- redraft | recheck | mark_received | keep
  action          varchar(16) NOT NULL,
  result          jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT impact_actions_project_fk FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  CONSTRAINT impact_actions_item_uq UNIQUE (new_version_id, item_key),
  CONSTRAINT impact_actions_action_chk CHECK (action IN ('redraft', 'recheck', 'mark_received', 'keep'))
);
CREATE INDEX IF NOT EXISTS impact_actions_version_idx ON impact_actions (org_id, new_version_id);
