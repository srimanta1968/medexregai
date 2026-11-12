-- F3.2 Draft in Word: drafts of one eSTAR section of a submission (project_sections, 030).
--
-- A draft is generated (RAG over the section's client files, then the citation gate in its
-- every-statement mode) or imported (a consultant's edited DOCX of an earlier draft). Each
-- draft is a new version; nothing is overwritten. Statements carry their citations; a
-- statement a person edited or added is kept as human-approved.
--
-- Named section_drafts, not drafts: the shared schema's "drafts" table is an unrelated
-- planning stub (a draft per file, integer file_id) that no migration creates.

CREATE TABLE IF NOT EXISTS section_drafts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL,
  project_section_id  uuid NOT NULL,
  version_no          integer NOT NULL,
  -- generated | imported
  origin              varchar(10) NOT NULL,
  -- queued -> generating -> ready | failed (imported drafts are ready at once)
  status              varchar(10) NOT NULL DEFAULT 'queued',
  based_on_draft_id   uuid,
  model               varchar(200),
  prompt_version      varchar(40),
  gate_run_id         uuid,
  -- Statements the citation gate removed: [{ text, code, reason }]
  removed_items       jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Imported drafts: { unchanged, edited, added, deleted: [text] }
  import_summary      jsonb,
  error               varchar(500),
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  finished_at         timestamptz,
  CONSTRAINT section_drafts_id_org_uq UNIQUE (id, org_id),
  CONSTRAINT section_drafts_section_fk FOREIGN KEY (project_section_id, org_id) REFERENCES project_sections (id, org_id) ON DELETE CASCADE,
  CONSTRAINT section_drafts_based_on_fk FOREIGN KEY (based_on_draft_id, org_id) REFERENCES section_drafts (id, org_id) ON DELETE SET NULL (based_on_draft_id),
  CONSTRAINT section_drafts_version_uq UNIQUE (project_section_id, version_no),
  CONSTRAINT section_drafts_origin_chk CHECK (origin IN ('generated', 'imported')),
  CONSTRAINT section_drafts_status_chk CHECK (status IN ('queued', 'generating', 'ready', 'failed'))
);
CREATE INDEX IF NOT EXISTS section_drafts_section_idx ON section_drafts (org_id, project_section_id, version_no DESC);
CREATE INDEX IF NOT EXISTS section_drafts_queue_idx ON section_drafts (created_at) WHERE status = 'queued';

CREATE TABLE IF NOT EXISTS draft_statements (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL,
  draft_id             uuid NOT NULL,
  ordinal              integer NOT NULL,
  paragraph            integer NOT NULL,
  -- heading | statement
  kind                 varchar(10) NOT NULL DEFAULT 'statement',
  text                 text NOT NULL,
  -- [{ marker: "[C:<version>#3]", label: "report.docx v2, page 3" }]
  citations            jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings             jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- generated | human_edited | human_added
  origin               varchar(14) NOT NULL DEFAULT 'generated',
  human_approved       boolean NOT NULL DEFAULT false,
  approved_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  -- The statement of the earlier draft this one came from (imports).
  source_statement_id  uuid,
  CONSTRAINT draft_statements_draft_fk FOREIGN KEY (draft_id, org_id) REFERENCES section_drafts (id, org_id) ON DELETE CASCADE,
  CONSTRAINT draft_statements_ordinal_uq UNIQUE (draft_id, ordinal),
  CONSTRAINT draft_statements_kind_chk CHECK (kind IN ('heading', 'statement')),
  CONSTRAINT draft_statements_origin_chk CHECK (origin IN ('generated', 'human_edited', 'human_added')),
  CONSTRAINT draft_statements_human_chk CHECK (origin = 'generated' OR human_approved)
);
CREATE INDEX IF NOT EXISTS draft_statements_draft_idx ON draft_statements (org_id, draft_id, ordinal);
