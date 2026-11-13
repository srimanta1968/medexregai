-- F5.1 FDA letters (PRD v2.0 FR-14.23; UI 2.0 §7.1): an Additional Information (AI) request or an
-- RTA (Refuse to Accept) hold letter for a project, split into numbered deficiencies that the
-- consultant confirms before saving, each linked to an eSTAR section, client files and drafted
-- statements, with a deadline clock.
--
-- Deadline (FDA, "510(k) Submission Process", fda.gov): an AI request places the submission on
-- hold and "FDA must receive a complete response within 180 calendar days of the date of the AI
-- Request. No extensions beyond 180 days are granted"; an RTA hold likewise gives "180 calendar
-- days to fully address the deficiencies". due_on defaults to issued_on + 180 days and stays
-- editable, because the consultant reads the date FDA states on the letter.
--
-- Everything cascades from projects, so per-project deletion (NFR-14) removes it.

CREATE TABLE IF NOT EXISTS fda_letters (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  workspace_id    uuid NOT NULL,
  project_id      uuid NOT NULL,
  -- ai_request | rta_hold
  kind            varchar(12) NOT NULL,
  -- FDA's reference on the letter, e.g. the 510(k) number K251234.
  fda_reference   varchar(40),
  issued_on       date NOT NULL,
  received_on     date,
  due_on          date NOT NULL,
  -- The letter as a project file (uploaded or forwarded by email), when there is one.
  file_version_id uuid,
  -- open | responded | closed
  status          varchar(10) NOT NULL DEFAULT 'open',
  responded_on    date,
  notes           text,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fda_letters_id_org_uq UNIQUE (id, org_id),
  CONSTRAINT fda_letters_project_fk FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  CONSTRAINT fda_letters_version_fk FOREIGN KEY (file_version_id, org_id) REFERENCES file_versions (id, org_id) ON DELETE SET NULL (file_version_id),
  CONSTRAINT fda_letters_kind_chk CHECK (kind IN ('ai_request', 'rta_hold')),
  CONSTRAINT fda_letters_status_chk CHECK (status IN ('open', 'responded', 'closed')),
  CONSTRAINT fda_letters_dates_chk CHECK (due_on >= issued_on AND (received_on IS NULL OR received_on >= issued_on)),
  CONSTRAINT fda_letters_notes_len CHECK (notes IS NULL OR length(notes) <= 4000)
);
CREATE INDEX IF NOT EXISTS fda_letters_project_idx ON fda_letters (org_id, project_id, issued_on DESC);
CREATE INDEX IF NOT EXISTS fda_letters_open_due_idx ON fda_letters (org_id, due_on) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS fda_deficiencies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  letter_id   uuid NOT NULL,
  project_id  uuid NOT NULL,
  -- FDA's own number for the deficiency, as on the letter.
  number      integer NOT NULL CHECK (number BETWEEN 1 AND 999),
  -- A short summary for the tracker, and FDA's full text.
  summary     varchar(300) NOT NULL,
  fda_text    text NOT NULL,
  section_id  varchar(40) REFERENCES estar_sections(id),
  -- consultant | client
  owner       varchar(10) NOT NULL DEFAULT 'consultant',
  -- open | requested (asked of the client) | drafting | ready | answered
  status      varchar(10) NOT NULL DEFAULT 'open',
  due_on      date,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fda_deficiencies_id_org_uq UNIQUE (id, org_id),
  CONSTRAINT fda_deficiencies_letter_fk FOREIGN KEY (letter_id, org_id) REFERENCES fda_letters (id, org_id) ON DELETE CASCADE,
  CONSTRAINT fda_deficiencies_project_fk FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  CONSTRAINT fda_deficiencies_number_uq UNIQUE (letter_id, number),
  CONSTRAINT fda_deficiencies_owner_chk CHECK (owner IN ('consultant', 'client')),
  CONSTRAINT fda_deficiencies_status_chk CHECK (status IN ('open', 'requested', 'drafting', 'ready', 'answered')),
  CONSTRAINT fda_deficiencies_text_len CHECK (length(fda_text) <= 20000)
);
CREATE INDEX IF NOT EXISTS fda_deficiencies_letter_idx ON fda_deficiencies (letter_id, number);

-- What each deficiency affects: client files and drafted statements.
CREATE TABLE IF NOT EXISTS fda_deficiency_links (
  org_id         uuid NOT NULL,
  deficiency_id  uuid NOT NULL,
  -- file | statement
  kind           varchar(10) NOT NULL,
  ref_id         uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (deficiency_id, kind, ref_id),
  CONSTRAINT fda_deficiency_links_def_fk FOREIGN KEY (deficiency_id, org_id) REFERENCES fda_deficiencies (id, org_id) ON DELETE CASCADE,
  CONSTRAINT fda_deficiency_links_kind_chk CHECK (kind IN ('file', 'statement'))
);
CREATE INDEX IF NOT EXISTS fda_deficiency_links_ref_idx ON fda_deficiency_links (org_id, kind, ref_id);
