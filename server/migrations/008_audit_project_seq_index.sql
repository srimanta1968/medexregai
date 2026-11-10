-- F0.3 Project activity is read newest-first by chain position (seq), keyset-paged.
CREATE INDEX IF NOT EXISTS audit_events_project_seq_idx ON audit_events (org_id, project_id, seq DESC) WHERE project_id IS NOT NULL;
