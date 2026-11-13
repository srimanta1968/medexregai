-- F5.2 substantial-equivalence comparison tables (UI 2.0 §7.2): one per project and predicate
-- 510(k), built from the subject device's client files and the predicate's FDA records and public
-- summary, every cell cited, then edited by the consultant. rows is the ordered list of
-- attributes: { key, attribute, subject: {text, citations[]}, predicate: {text, citations[]},
-- comparison: same | different | review, note, edited }. MedexRegAI never decides substantial
-- equivalence: text rows stay 'review' until the consultant sets them.
--
-- Cascades from projects, so per-project deletion (NFR-14) removes it.

CREATE TABLE IF NOT EXISTS se_comparisons (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL,
  workspace_id           uuid NOT NULL,
  project_id             uuid NOT NULL,
  predicate_k_number     varchar(16) NOT NULL,
  predicate_device_name  varchar(300),
  predicate_applicant    varchar(300),
  rows                   jsonb NOT NULL DEFAULT '[]'::jsonb,
  built_at               timestamptz NOT NULL DEFAULT now(),
  created_by             uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT se_comparisons_id_org_uq UNIQUE (id, org_id),
  CONSTRAINT se_comparisons_project_fk FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  CONSTRAINT se_comparisons_predicate_uq UNIQUE (project_id, predicate_k_number),
  CONSTRAINT se_comparisons_k_chk CHECK (predicate_k_number ~ '^[KDP][0-9]{6}$')
);
CREATE INDEX IF NOT EXISTS se_comparisons_project_idx ON se_comparisons (org_id, project_id, created_at DESC);
