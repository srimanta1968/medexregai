-- F7.2 ingest bookkeeping: when a parse was claimed and how often it was tried, so the
-- sweep can return a version stuck in 'parsing' (worker died) to the queue, and give up
-- after a few attempts instead of retrying a poison file forever.
ALTER TABLE file_versions ADD COLUMN IF NOT EXISTS parse_started_at timestamptz;
ALTER TABLE file_versions ADD COLUMN IF NOT EXISTS parse_attempts smallint NOT NULL DEFAULT 0 CHECK (parse_attempts >= 0);

-- Sweep: linked copies still held after processing, per firm.
CREATE INDEX IF NOT EXISTS file_versions_undiscarded_idx ON file_versions (org_id, created_at)
  WHERE storage_key IS NOT NULL AND parse_status IN ('parsed', 'failed', 'unsupported');
-- Sweep: claims that never finished.
CREATE INDEX IF NOT EXISTS file_versions_parsing_idx ON file_versions (org_id, parse_started_at) WHERE parse_status = 'parsing';

-- 'unsupported' (11 characters) did not fit the varchar(10) of migration 015.
ALTER TABLE file_versions ALTER COLUMN parse_status TYPE varchar(12);
