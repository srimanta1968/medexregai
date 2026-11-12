-- F4.2 Pilot report (PRD v2.0 §12 success metrics, gates G2' and G3').
--
-- pilot_baselines: the firm's own Phase 0 baseline, hours per A3 activity on one comparable
-- past 510(k), as the consultant validation workbook asks for it (section A3, "Where the hours
-- go"). One row per activity per firm; entered by the firm, never estimated by the product.
--
-- pilot_signoffs: the firm's RA lead signing the pilot report of a project. The SHA-256 is of
-- the report data the lead saw, so a later change to the numbers is visible against it.

CREATE TABLE IF NOT EXISTS pilot_baselines (
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  activity_code varchar(20) NOT NULL REFERENCES time_activities(code),
  hours         numeric(7, 2) NOT NULL CHECK (hours >= 0 AND hours <= 10000),
  -- What the baseline is: e.g. "Traditional 510(k), infusion set, 2025".
  basis         varchar(200),
  updated_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, activity_code)
);

CREATE TABLE IF NOT EXISTS pilot_signoffs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  project_id    uuid NOT NULL,
  signed_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  signer_name   varchar(200) NOT NULL,
  signer_title  varchar(200) NOT NULL,
  note          varchar(1000),
  report_sha256 char(64) NOT NULL,
  signed_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pilot_signoffs_project_fk FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS pilot_signoffs_project_idx ON pilot_signoffs (org_id, project_id, signed_at DESC);
