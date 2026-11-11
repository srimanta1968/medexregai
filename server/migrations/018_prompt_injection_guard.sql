-- F7.5 prompt-injection defence (NFR-16, ADR-016).
--
-- file_versions.injection_signals: text in a client file that reads like instructions
-- to an AI, found at ingest. A warning for the consultant only: the file is still
-- processed the same way, its text reaches models only as delimited data, and model
-- outputs are schema-checked whatever this says.
--   [{ kind, ordinal, where, excerpt }], at most 50 stored
ALTER TABLE file_versions ADD COLUMN IF NOT EXISTS injection_signals jsonb NOT NULL DEFAULT '[]'::jsonb;

-- ai_calls: the outcome of the output check on document routes, so rejected outputs
-- can be counted per route and investigated.
--   output_check     passed | rejected; NULL for calls that are not checked (connection tests)
--   output_problems  [{ code, message, path }] when rejected
--   input_signals    injection signals found in the data blocks sent with the call
ALTER TABLE ai_calls ADD COLUMN IF NOT EXISTS output_check varchar(8);
ALTER TABLE ai_calls ADD COLUMN IF NOT EXISTS output_problems jsonb;
ALTER TABLE ai_calls ADD COLUMN IF NOT EXISTS input_signals smallint NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_calls_output_check_chk') THEN
    ALTER TABLE ai_calls ADD CONSTRAINT ai_calls_output_check_chk CHECK (output_check IS NULL OR output_check IN ('passed', 'rejected'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_calls_input_signals_chk') THEN
    ALTER TABLE ai_calls ADD CONSTRAINT ai_calls_input_signals_chk CHECK (input_signals >= 0);
  END IF;
END $$;

-- The settings page counts rejected outputs per route over the last 30 days.
CREATE INDEX IF NOT EXISTS ai_calls_rejected_idx ON ai_calls (org_id, created_at DESC) WHERE output_check = 'rejected';
