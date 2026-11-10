-- F7.2 Ingest and indexing (Architecture v2.0 §5, ADR-010 "registers, not repositories").
--
--   files            one logical client file in a project (an upload, or a file in the
--                    firm's connected client folder). Its identity survives new versions.
--   file_versions    every copy we have processed. A re-upload or a changed linked file
--                    adds a version; old versions are kept so citations stay resolvable.
--   source_locations where a passage sits in that version: page, sheet + cell range, slide,
--                    or a region (drawing title block). Citations point here.
--   chunks           retrieval units with full-text and vector (bge-m3, 1024-d) indexes.
--
-- Fetched copies of linked files are deleted after processing; the version keeps its
-- SHA-256, size, extracted text and locations (storage_key is cleared, discarded_at set).
-- Every row carries org_id + workspace_id for the F8.1 row-level security policies, and
-- composite foreign keys keep children inside the same firm.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS files (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL,
  workspace_id        uuid NOT NULL,
  project_id          uuid NOT NULL,
  -- upload: sent to us (kept in our storage); linked: read from the firm's connected
  -- folder (copy discarded after processing); request: supplied through a client upload link.
  source              varchar(8) NOT NULL,
  -- Provider path or id for linked files (e.g. "/Acme/V&V/Bench report.docx"); NULL for uploads.
  source_ref          varchar(1024),
  name                varchar(255) NOT NULL,
  current_version_id  uuid,
  version_count       integer NOT NULL DEFAULT 0 CHECK (version_count >= 0),
  status              varchar(10) NOT NULL DEFAULT 'active',
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT files_project_fk FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  CONSTRAINT files_workspace_fk FOREIGN KEY (workspace_id, org_id) REFERENCES client_workspaces (id, org_id) ON DELETE CASCADE,
  CONSTRAINT files_id_org_uq UNIQUE (id, org_id),
  CONSTRAINT files_source_chk CHECK (source IN ('upload', 'linked', 'request')),
  CONSTRAINT files_linked_ref_chk CHECK (source <> 'linked' OR source_ref IS NOT NULL),
  CONSTRAINT files_status_chk CHECK (status IN ('active', 'removed'))
);
-- One logical file per linked path in a project, so a changed file becomes a new version.
CREATE UNIQUE INDEX IF NOT EXISTS files_project_source_ref_uq ON files (project_id, source_ref) WHERE source_ref IS NOT NULL;
-- Re-uploading the same name in a project adds a version instead of a second file.
CREATE UNIQUE INDEX IF NOT EXISTS files_project_upload_name_uq ON files (project_id, lower(name)) WHERE source_ref IS NULL AND status = 'active';
CREATE INDEX IF NOT EXISTS files_project_updated_idx ON files (org_id, project_id, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS file_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  workspace_id    uuid NOT NULL,
  file_id         uuid NOT NULL,
  version_no      integer NOT NULL CHECK (version_no >= 1),
  sha256          char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes      bigint NOT NULL CHECK (size_bytes >= 0),
  mime_type       varchar(127) NOT NULL,
  -- docx | xlsx | pptx | pdf | image | csv | other: decides the parser and location kind.
  format          varchar(8) NOT NULL,
  -- Object key of our copy; NULL once a fetched copy is discarded (linked files).
  storage_key     varchar(512),
  discarded_at    timestamptz,
  -- Linked-file change detection (provider revision / etag), when the provider gives one.
  source_revision varchar(255),
  parse_status    varchar(10) NOT NULL DEFAULT 'queued',
  parse_error     varchar(500),
  parser          varchar(40),
  -- Pages for PDF/images, slides for PPTX, sheets for XLSX.
  unit_count      integer CHECK (unit_count IS NULL OR unit_count >= 0),
  ocr_used        boolean NOT NULL DEFAULT false,
  -- Likely-PHI scan (NFR-9): the consultant is warned and asked to redact.
  phi_status      varchar(12) NOT NULL DEFAULT 'not_scanned',
  phi_findings    jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Structure profile for raw-data files, title-block fields for drawings (FR-14.4/14.5).
  profile         jsonb,
  uploaded_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  parsed_at       timestamptz,
  CONSTRAINT file_versions_file_fk FOREIGN KEY (file_id, org_id) REFERENCES files (id, org_id) ON DELETE CASCADE,
  CONSTRAINT file_versions_id_org_uq UNIQUE (id, org_id),
  CONSTRAINT file_versions_file_no_uq UNIQUE (file_id, version_no),
  CONSTRAINT file_versions_format_chk CHECK (format IN ('docx', 'xlsx', 'pptx', 'pdf', 'image', 'csv', 'other')),
  CONSTRAINT file_versions_parse_chk CHECK (parse_status IN ('queued', 'parsing', 'parsed', 'failed', 'unsupported')),
  CONSTRAINT file_versions_phi_chk CHECK (phi_status IN ('not_scanned', 'clean', 'flagged', 'redacted', 'accepted')),
  CONSTRAINT file_versions_discard_chk CHECK (discarded_at IS NULL OR storage_key IS NULL)
);
CREATE INDEX IF NOT EXISTS file_versions_file_idx ON file_versions (file_id, version_no DESC);
-- Same bytes seen again (dedupe and "unchanged" detection).
CREATE INDEX IF NOT EXISTS file_versions_org_sha_idx ON file_versions (org_id, sha256);
-- Worker pick-up of queued work.
CREATE INDEX IF NOT EXISTS file_versions_queue_idx ON file_versions (created_at) WHERE parse_status IN ('queued', 'parsing');

DO $$ BEGIN
  ALTER TABLE files ADD CONSTRAINT files_current_version_fk
    FOREIGN KEY (current_version_id, org_id) REFERENCES file_versions (id, org_id)
    ON DELETE SET NULL (current_version_id) DEFERRABLE INITIALLY DEFERRED;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS source_locations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  workspace_id     uuid NOT NULL,
  file_version_id  uuid NOT NULL,
  -- Reading order within the version.
  ordinal          integer NOT NULL CHECK (ordinal >= 0),
  kind             varchar(10) NOT NULL,
  page             integer CHECK (page IS NULL OR page >= 1),
  sheet            varchar(100),
  cell_range       varchar(40),
  slide            integer CHECK (slide IS NULL OR slide >= 1),
  -- Heading path ("5 Results > 5.2 Tensile") for paragraph and table locations.
  section_path     varchar(500),
  -- Normalised box [x0, y0, x1, y1] in 0..1 page coordinates, when the parser gives one.
  bbox             real[] CHECK (bbox IS NULL OR cardinality(bbox) = 4),
  text             text NOT NULL,
  CONSTRAINT source_locations_version_fk FOREIGN KEY (file_version_id, org_id) REFERENCES file_versions (id, org_id) ON DELETE CASCADE,
  CONSTRAINT source_locations_id_org_uq UNIQUE (id, org_id),
  CONSTRAINT source_locations_version_ordinal_uq UNIQUE (file_version_id, ordinal),
  CONSTRAINT source_locations_kind_chk CHECK (kind IN ('page', 'paragraph', 'table', 'cell', 'slide', 'region')),
  -- Every location must say where it is in a way a reviewer can open.
  CONSTRAINT source_locations_where_chk CHECK (
    (kind = 'cell' AND sheet IS NOT NULL AND cell_range IS NOT NULL)
    OR (kind = 'slide' AND slide IS NOT NULL)
    OR (kind IN ('page', 'region') AND page IS NOT NULL)
    OR (kind IN ('paragraph', 'table') AND (page IS NOT NULL OR slide IS NOT NULL OR sheet IS NOT NULL OR section_path IS NOT NULL))
  )
);

CREATE TABLE IF NOT EXISTS chunks (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL,
  workspace_id       uuid NOT NULL,
  project_id         uuid NOT NULL,
  file_version_id    uuid NOT NULL,
  ordinal            integer NOT NULL CHECK (ordinal >= 0),
  -- First and last location the chunk spans; citations resolve to these.
  start_location_id  uuid NOT NULL,
  end_location_id    uuid NOT NULL,
  section_path       varchar(500),
  text               text NOT NULL,
  token_count        integer NOT NULL CHECK (token_count > 0),
  -- NULL until the embedding step runs (queued separately from parsing).
  embedding          vector(1024),
  embedding_model    varchar(128),
  tsv                tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(section_path, '') || ' ' || text)) STORED,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chunks_version_fk FOREIGN KEY (file_version_id, org_id) REFERENCES file_versions (id, org_id) ON DELETE CASCADE,
  CONSTRAINT chunks_project_fk FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  CONSTRAINT chunks_start_fk FOREIGN KEY (start_location_id, org_id) REFERENCES source_locations (id, org_id) ON DELETE CASCADE,
  CONSTRAINT chunks_end_fk FOREIGN KEY (end_location_id, org_id) REFERENCES source_locations (id, org_id) ON DELETE CASCADE,
  CONSTRAINT chunks_version_ordinal_uq UNIQUE (file_version_id, ordinal),
  CONSTRAINT chunks_embedding_model_chk CHECK ((embedding IS NULL) = (embedding_model IS NULL))
);
-- Hybrid retrieval (F7.3): vector similarity and full text, always filtered by project.
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw_idx ON chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON chunks USING gin (tsv);
CREATE INDEX IF NOT EXISTS chunks_project_idx ON chunks (org_id, project_id);
-- Embedding backlog for the worker.
CREATE INDEX IF NOT EXISTS chunks_unembedded_idx ON chunks (created_at) WHERE embedding IS NULL;
