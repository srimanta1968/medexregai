-- fda_db 004 (F1.2): public 510(k) summary PDFs, fetched once from accessdata.fda.gov
-- into the FDA document bucket (never the client-file bucket) and never fetched again.
--   queued      waiting for the polite fetcher
--   fetching    claimed by a worker (stale claims are re-queued)
--   fetched     PDF cached at storage_key; parse and embed follow (F1.2 parse task)
--   no_summary  "no summary on file": the FDA lists a statement, or no summary PDF exists
--   failed      temporary trouble (429, 5xx, timeout); retried after next_attempt_at
CREATE TABLE IF NOT EXISTS fda_510k_documents (
  k_number         varchar(16) PRIMARY KEY,
  status           varchar(16) NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'fetching', 'fetched', 'no_summary', 'failed')),
  reason           text,
  source_url       text,
  storage_key      text,
  sha256           char(64),
  size_bytes       integer CHECK (size_bytes IS NULL OR size_bytes > 0),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  claimed_at       timestamptz,
  fetched_at       timestamptz,
  checked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'fetched' OR (storage_key IS NOT NULL AND sha256 IS NOT NULL AND size_bytes IS NOT NULL))
);

-- The fetcher's work list: due queued or failed rows, oldest due first.
CREATE INDEX IF NOT EXISTS fda_510k_documents_due_idx
  ON fda_510k_documents (next_attempt_at) WHERE status IN ('queued', 'failed');
