-- F7.3 citation gate v2 (Architecture v2.0 §9): "remove and log". Every gate run is
-- recorded with the sentences it removed and why, so removed statements can be listed
-- as open items for the consultant and the gate's behaviour can be audited.
-- Removed sentences are client-derived text: the row is tenant data and is deleted with the project.
CREATE TABLE IF NOT EXISTS citation_gate_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  project_id    uuid NOT NULL,
  -- The AI route whose output was checked (draft, extract, ...), or 'check' for a manual check.
  route         varchar(32) NOT NULL,
  sentences     integer NOT NULL CHECK (sentences >= 0),
  kept          integer NOT NULL CHECK (kept >= 0),
  removed       integer NOT NULL CHECK (removed >= 0),
  refused       boolean NOT NULL,
  -- [{ text, code, reason }]
  removed_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings      jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT citation_gate_runs_project_fk FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  CONSTRAINT citation_gate_runs_counts_chk CHECK (kept + removed = sentences)
);
CREATE INDEX IF NOT EXISTS citation_gate_runs_project_idx ON citation_gate_runs (org_id, project_id, created_at DESC, id DESC);
