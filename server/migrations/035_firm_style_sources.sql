-- F3.6 Firm style sources: the firm's own section templates and its library of past wording.
--
-- Opt-in. A firm turns style sources on (orgs.style_sources_enabled, off by default); each
-- template and precedent can also be turned off on its own. Drafting reads both flags when it
-- claims a draft, so turning a source off keeps it out of every draft started after that moment
-- (a draft already being written finishes within its 15-minute claim, well inside an hour).
--
-- Isolation: every row carries org_id and every read filters on it. There is no shared or
-- cross-firm precedent table, so one firm's past wording cannot be retrieved for another.
--
-- Templates and precedents are style, not evidence: they shape the order and wording of a
-- section, never its facts. A drafted statement still needs a client-file citation (F3.2 gate).

ALTER TABLE orgs ADD COLUMN IF NOT EXISTS style_sources_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS style_sources_updated_at timestamptz;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS style_sources_updated_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- One template per eSTAR section per firm: the outline and standing wording the firm uses.
CREATE TABLE IF NOT EXISTS firm_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  section_id    varchar(40) NOT NULL REFERENCES estar_sections(id),
  name          varchar(200) NOT NULL,
  body          text NOT NULL,
  enabled       boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT firm_templates_id_org_uq UNIQUE (id, org_id),
  CONSTRAINT firm_templates_section_uq UNIQUE (org_id, section_id),
  CONSTRAINT firm_templates_body_len_chk CHECK (char_length(body) BETWEEN 1 AND 20000)
);
CREATE INDEX IF NOT EXISTS firm_templates_list_idx ON firm_templates (org_id, created_at DESC, id);

-- Past wording: passages the firm wrote in earlier submissions, labelled with where they came from.
CREATE TABLE IF NOT EXISTS firm_precedents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  section_id    varchar(40) NOT NULL REFERENCES estar_sections(id),
  -- e.g. "K201234, Device description (2021)"; the firm's own label.
  source_label  varchar(200) NOT NULL,
  text          text NOT NULL,
  enabled       boolean NOT NULL DEFAULT true,
  tsv           tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT firm_precedents_id_org_uq UNIQUE (id, org_id),
  CONSTRAINT firm_precedents_text_len_chk CHECK (char_length(text) BETWEEN 1 AND 4000)
);
CREATE INDEX IF NOT EXISTS firm_precedents_list_idx ON firm_precedents (org_id, section_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS firm_precedents_tsv_idx ON firm_precedents USING gin (tsv);

-- Which firm sources shaped a draft: [{ kind: template|precedent, id, label }]. Recorded so a
-- reviewer can see them and so a draft never claims a source that was off when it was written.
ALTER TABLE section_drafts ADD COLUMN IF NOT EXISTS style_sources jsonb NOT NULL DEFAULT '[]'::jsonb;
