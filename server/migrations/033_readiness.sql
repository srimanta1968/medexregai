-- F3.4 Readiness and records.
--
-- projects.estar_template: which eSTAR template (and so which attachment rules,
-- server/src/readiness/estarRules.ts) the submission is checked against.
--
-- record_exports: every dated record generated for the firm's eQMS (project record, problem
-- log, client request log), with the SHA-256 of the exact bytes handed out, so a record can be
-- matched to what was filed later. The document itself is regenerated from the data on demand.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS estar_template varchar(16) NOT NULL DEFAULT 'nIVD-7.1';

CREATE TABLE IF NOT EXISTS record_exports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  project_id    uuid NOT NULL,
  -- project_record | problem_log | request_log
  kind          varchar(16) NOT NULL,
  -- pdf | docx
  format        varchar(4) NOT NULL,
  sha256        char(64) NOT NULL,
  size_bytes    integer NOT NULL,
  estar_template varchar(16) NOT NULL,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT record_exports_project_fk FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  CONSTRAINT record_exports_kind_chk CHECK (kind IN ('project_record', 'problem_log', 'request_log')),
  CONSTRAINT record_exports_format_chk CHECK (format IN ('pdf', 'docx'))
);
CREATE INDEX IF NOT EXISTS record_exports_project_idx ON record_exports (org_id, project_id, created_at DESC);
