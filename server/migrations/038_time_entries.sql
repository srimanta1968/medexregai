-- F4.1 Time capture (PRD v2.0 FR-14.20): optional, editable, one click per entry.
--
-- A timer entry starts with ended_at NULL and is closed by the next stop (or by starting
-- another timer: one running timer per person per firm, enforced by the partial unique index).
-- An entry may be typed in afterwards (source = 'manual') and any entry may be edited; edited_at
-- records that it was changed by hand. project_id is optional: time on firm-level work counts
-- under "No project". Totals by project and activity are computed from these rows.

CREATE TABLE IF NOT EXISTS time_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id    uuid,
  activity_code varchar(20) NOT NULL REFERENCES time_activities(code),
  started_at    timestamptz NOT NULL,
  ended_at      timestamptz,
  -- timer | manual
  source        varchar(10) NOT NULL DEFAULT 'timer',
  note          varchar(500),
  edited_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT time_entries_id_org_uq UNIQUE (id, org_id),
  CONSTRAINT time_entries_project_fk FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  CONSTRAINT time_entries_source_chk CHECK (source IN ('timer', 'manual')),
  CONSTRAINT time_entries_order_chk CHECK (ended_at IS NULL OR ended_at > started_at),
  -- A single entry is at most a working day and a half; longer ones are a timer left running.
  CONSTRAINT time_entries_length_chk CHECK (ended_at IS NULL OR ended_at - started_at <= interval '36 hours')
);

-- One running timer per person per firm.
CREATE UNIQUE INDEX IF NOT EXISTS time_entries_running_uq ON time_entries (org_id, user_id) WHERE ended_at IS NULL;
-- A person's entries, newest first (list and weekly summary).
CREATE INDEX IF NOT EXISTS time_entries_user_idx ON time_entries (org_id, user_id, started_at DESC, id);
-- Totals by project and activity.
CREATE INDEX IF NOT EXISTS time_entries_project_idx ON time_entries (org_id, project_id, activity_code, started_at);
