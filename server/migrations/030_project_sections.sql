-- F3.1 Review board: each eSTAR section of a submission (server/migrations/025) with
-- its status and the reviewer assigned to it, plus the history of every status change.
-- Rows are created for a project's applicable sections the first time its board is read.
--
-- Status: not_started -> drafting -> in_review -> approved. A reviewer can send a section
-- back (in_review -> drafting) and an approved section can be reopened (approved -> drafting).

CREATE TABLE IF NOT EXISTS project_sections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  project_id    uuid NOT NULL,
  section_id    varchar(40) NOT NULL REFERENCES estar_sections(id),
  status        varchar(12) NOT NULL DEFAULT 'not_started',
  reviewer_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_sections_id_org_uq UNIQUE (id, org_id),
  CONSTRAINT project_sections_project_fk FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  CONSTRAINT project_sections_section_uq UNIQUE (project_id, section_id),
  CONSTRAINT project_sections_status_chk CHECK (status IN ('not_started', 'drafting', 'in_review', 'approved')),
  CONSTRAINT project_sections_approved_chk CHECK (status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS project_sections_project_idx ON project_sections (org_id, project_id, status);
CREATE INDEX IF NOT EXISTS project_sections_reviewer_idx ON project_sections (org_id, reviewer_id) WHERE reviewer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS section_status_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL,
  project_section_id  uuid NOT NULL,
  -- status_changed | reviewer_assigned | reviewer_removed
  event               varchar(20) NOT NULL,
  from_status         varchar(12),
  to_status           varchar(12),
  reviewer_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  note                varchar(1000),
  actor_id            uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT section_status_events_section_fk FOREIGN KEY (project_section_id, org_id) REFERENCES project_sections (id, org_id) ON DELETE CASCADE,
  CONSTRAINT section_status_events_event_chk CHECK (event IN ('status_changed', 'reviewer_assigned', 'reviewer_removed'))
);
CREATE INDEX IF NOT EXISTS section_status_events_section_idx ON section_status_events (org_id, project_section_id, created_at DESC);
