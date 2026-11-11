-- fda_db 005 (F1.2): searchable passages of the public 510(k) summaries.
-- The PDFs fetched in 004 are parsed in the docproc sandbox, cut into page-bounded
-- chunks and embedded (bge-m3, 1024 dimensions, the same model as the app's index).
-- This is the PUBLIC corpus index: it lives only in fda_db and never holds tenant
-- text or vectors (ADR-017).
CREATE EXTENSION IF NOT EXISTS vector;

-- Index status per fetched PDF (only rows with status = 'fetched' are indexed).
--   pending    fetched, waiting for the indexer
--   indexing   claimed by a worker (stale claims are re-queued)
--   indexed    passages stored and embedded
--   needs_ocr  a scanned PDF with no text layer; this docproc build has no OCR
--   failed     parse/embed trouble; retried after index_next_attempt_at
ALTER TABLE fda_510k_documents
  ADD COLUMN IF NOT EXISTS index_status varchar(16) NOT NULL DEFAULT 'pending'
    CHECK (index_status IN ('pending', 'indexing', 'indexed', 'needs_ocr', 'failed')),
  ADD COLUMN IF NOT EXISTS index_error text,
  ADD COLUMN IF NOT EXISTS index_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS index_next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS index_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS indexed_at timestamptz,
  ADD COLUMN IF NOT EXISTS page_count integer,
  ADD COLUMN IF NOT EXISTS passage_count integer,
  ADD COLUMN IF NOT EXISTS embedding_model text;

CREATE INDEX IF NOT EXISTS fda_510k_documents_index_due_idx
  ON fda_510k_documents (index_next_attempt_at)
  WHERE status = 'fetched' AND index_status IN ('pending', 'failed');

CREATE TABLE IF NOT EXISTS fda_510k_passages (
  id              bigserial PRIMARY KEY,
  k_number        varchar(16) NOT NULL REFERENCES fda_510k_documents (k_number) ON DELETE CASCADE,
  ordinal         integer NOT NULL,
  page            integer,
  section_path    text,
  text            text NOT NULL,
  token_count     integer NOT NULL,
  embedding       vector(1024),
  embedding_model text,
  tsv             tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  UNIQUE (k_number, ordinal)
);

CREATE INDEX IF NOT EXISTS fda_510k_passages_tsv_idx ON fda_510k_passages USING gin (tsv);
CREATE INDEX IF NOT EXISTS fda_510k_passages_embedding_idx
  ON fda_510k_passages USING hnsw (embedding vector_cosine_ops);
