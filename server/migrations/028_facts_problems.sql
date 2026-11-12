-- F2.3 Problems: gaps and contradictions.
--
-- facts: what a client document states (a value with its unit, a standard, a date,
-- an identifier...), each with the exact quote and where it was read (file version,
-- chunk, first location -> page/sheet/slide), so a finding can be checked in seconds.
-- problems: a contradiction between two facts on the same topic, or a gap (evidence
-- the submission needs that is not in the project). The consultant decides; nothing
-- in the client's documents is changed.

CREATE TABLE IF NOT EXISTS facts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  project_id      uuid NOT NULL,
  file_id         uuid NOT NULL,
  version_id      uuid NOT NULL,
  chunk_id        uuid,
  location_id     uuid,
  -- quantity | standard | date | identifier | material | method | result (FACT_KINDS)
  kind            varchar(12) NOT NULL,
  -- What the fact is about, normalised so facts from different files can be compared
  -- ("shelf life", "sample size", "tubing outer diameter").
  topic_key       varchar(120) NOT NULL,
  label           varchar(120) NOT NULL,
  value           varchar(200) NOT NULL,
  unit            varchar(32),
  -- The value converted to the topic's base unit (months, mm, n...) when it is a number.
  value_num       numeric,
  base_unit       varchar(16),
  quote           varchar(300) NOT NULL,
  -- rules | llm
  extracted_by    varchar(8) NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT facts_id_org_uq UNIQUE (id, org_id),
  CONSTRAINT facts_project_fk FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  CONSTRAINT facts_file_fk FOREIGN KEY (file_id, org_id) REFERENCES files (id, org_id) ON DELETE CASCADE,
  CONSTRAINT facts_version_fk FOREIGN KEY (version_id, org_id) REFERENCES file_versions (id, org_id) ON DELETE CASCADE,
  CONSTRAINT facts_chunk_fk FOREIGN KEY (chunk_id) REFERENCES chunks (id) ON DELETE SET NULL,
  CONSTRAINT facts_location_fk FOREIGN KEY (location_id) REFERENCES source_locations (id) ON DELETE SET NULL,
  CONSTRAINT facts_kind_chk CHECK (kind IN ('quantity', 'standard', 'date', 'identifier', 'material', 'method', 'result')),
  CONSTRAINT facts_by_chk CHECK (extracted_by IN ('rules', 'llm'))
);
CREATE INDEX IF NOT EXISTS facts_project_topic_idx ON facts (org_id, project_id, topic_key);
CREATE INDEX IF NOT EXISTS facts_version_idx ON facts (version_id);

CREATE TABLE IF NOT EXISTS problems (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  project_id        uuid NOT NULL,
  -- contradiction | gap
  kind              varchar(14) NOT NULL,
  topic_key         varchar(120) NOT NULL,
  title             varchar(300) NOT NULL,
  detail            varchar(1000),
  -- high | medium | low, and why (shown with the problem)
  severity          varchar(6) NOT NULL,
  severity_reason   varchar(300) NOT NULL,
  -- The two facts that disagree (contradiction).
  fact_a_id         uuid,
  fact_b_id         uuid,
  -- The eSTAR section a gap belongs to.
  section_id        varchar(40) REFERENCES estar_sections(id),
  -- open | resolved | dismissed
  status            varchar(10) NOT NULL DEFAULT 'open',
  -- The consultant's choice (e.g. "source_a_wrong", "request_data", "accepted") and note.
  decision          varchar(40),
  decision_note     varchar(1000),
  decided_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at        timestamptz,
  -- Same problem found again on a re-run: matched by this, never duplicated.
  fingerprint       char(64) NOT NULL,
  -- Still found by the latest check (false: the cause went away, e.g. a file was replaced).
  still_present     boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT problems_id_org_uq UNIQUE (id, org_id),
  CONSTRAINT problems_project_fk FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  CONSTRAINT problems_fact_a_fk FOREIGN KEY (fact_a_id, org_id) REFERENCES facts (id, org_id) ON DELETE SET NULL (fact_a_id),
  CONSTRAINT problems_fact_b_fk FOREIGN KEY (fact_b_id, org_id) REFERENCES facts (id, org_id) ON DELETE SET NULL (fact_b_id),
  CONSTRAINT problems_kind_chk CHECK (kind IN ('contradiction', 'gap')),
  CONSTRAINT problems_severity_chk CHECK (severity IN ('high', 'medium', 'low')),
  CONSTRAINT problems_status_chk CHECK (status IN ('open', 'resolved', 'dismissed')),
  -- A decision always carries the consultant's note.
  CONSTRAINT problems_decision_chk CHECK (status = 'open' OR (decision IS NOT NULL AND decision_note IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT problems_fingerprint_uq UNIQUE (project_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS problems_project_idx ON problems (org_id, project_id, status, severity, created_at DESC, id DESC);
