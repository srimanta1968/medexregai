-- F4.3 Usage per client workspace and project (PRD v2.0 FR-14.22: "Projects, pages processed and
-- drafts per client workspace, as CSV", for firms to rebill their clients).
--
-- usage_events: append-only. One row per file version read (units = the pages, sheets or slides
-- the parser read) and per section draft generated. ref_id is the file version or draft, unique
-- per kind, so a re-parse or a retried worker never counts the same thing twice.
-- usage_daily: per project and day, rebuilt from the events by the worker (UsageService.rollup).
--
-- Both cascade from projects, like every project table, so per-project deletion (NFR-14) removes them.
--
-- Existing parsed versions and generated drafts are backfilled so usage starts complete.

CREATE TABLE IF NOT EXISTS usage_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL,
  project_id    uuid NOT NULL,
  -- file_read | draft_generated
  kind          varchar(20) NOT NULL,
  units         integer NOT NULL DEFAULT 0 CHECK (units >= 0),
  ref_id        uuid NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usage_events_project_fk FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  CONSTRAINT usage_events_kind_chk CHECK (kind IN ('file_read', 'draft_generated')),
  CONSTRAINT usage_events_ref_uq UNIQUE (kind, ref_id)
);
CREATE INDEX IF NOT EXISTS usage_events_org_time_idx ON usage_events (org_id, occurred_at);
CREATE INDEX IF NOT EXISTS usage_events_workspace_idx ON usage_events (org_id, workspace_id, occurred_at);

CREATE TABLE IF NOT EXISTS usage_daily (
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  workspace_id     uuid NOT NULL,
  project_id       uuid NOT NULL,
  day              date NOT NULL,
  files_read       integer NOT NULL DEFAULT 0,
  units_read       integer NOT NULL DEFAULT 0,
  drafts_generated integer NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, project_id, day),
  CONSTRAINT usage_daily_project_fk FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS usage_daily_workspace_idx ON usage_daily (org_id, workspace_id, day);

INSERT INTO usage_events (org_id, workspace_id, project_id, kind, units, ref_id, occurred_at)
SELECT v.org_id, f.workspace_id, f.project_id, 'file_read', COALESCE(v.unit_count, 0), v.id, COALESCE(v.parsed_at, v.created_at)
  FROM file_versions v JOIN files f ON f.id = v.file_id AND f.org_id = v.org_id
 WHERE v.parse_status = 'parsed'
ON CONFLICT (kind, ref_id) DO NOTHING;

INSERT INTO usage_events (org_id, workspace_id, project_id, kind, units, ref_id, occurred_at)
SELECT d.org_id, p.workspace_id, p.id, 'draft_generated', 0, d.id, COALESCE(d.finished_at, d.created_at)
  FROM section_drafts d
  JOIN project_sections ps ON ps.id = d.project_section_id AND ps.org_id = d.org_id
  JOIN projects p ON p.id = ps.project_id AND p.org_id = ps.org_id
 WHERE d.origin = 'generated' AND d.status = 'ready'
ON CONFLICT (kind, ref_id) DO NOTHING;
