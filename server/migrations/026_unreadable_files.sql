-- F2.2 Unreadable files are listed with the reason, never skipped.
--
-- file_versions.unreadable_kind: why a stored version could not be read (or was read
-- with no text at all), set by the ingest pass.
-- files.unreadable_kind / unreadable_reason: a file seen in a linked folder but not
-- fetched (native CAD, a type we do not read, larger than the limit). Such a file has
-- no versions; it is "listed only", so the consultant still knows it exists.
--
-- Kinds (labels in server/src/ingest/unreadable.ts):
--   native_cad, password_protected, legacy_office, unsupported_format, corrupt,
--   too_large, no_text, parse_timeout, not_stored
ALTER TABLE file_versions ADD COLUMN IF NOT EXISTS unreadable_kind varchar(24);
ALTER TABLE files ADD COLUMN IF NOT EXISTS unreadable_kind varchar(24);
ALTER TABLE files ADD COLUMN IF NOT EXISTS unreadable_reason varchar(500);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'file_versions_unreadable_chk') THEN
    ALTER TABLE file_versions ADD CONSTRAINT file_versions_unreadable_chk CHECK (unreadable_kind IS NULL OR unreadable_kind IN
      ('native_cad', 'password_protected', 'legacy_office', 'unsupported_format', 'corrupt', 'too_large', 'no_text', 'parse_timeout', 'not_stored'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'files_unreadable_chk') THEN
    ALTER TABLE files ADD CONSTRAINT files_unreadable_chk CHECK (unreadable_kind IS NULL OR (unreadable_reason IS NOT NULL AND unreadable_kind IN
      ('native_cad', 'password_protected', 'legacy_office', 'unsupported_format', 'corrupt', 'too_large', 'no_text', 'parse_timeout', 'not_stored')));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS files_unreadable_idx ON files (org_id, project_id) WHERE unreadable_kind IS NOT NULL;
CREATE INDEX IF NOT EXISTS file_versions_unreadable_idx ON file_versions (org_id, file_id) WHERE unreadable_kind IS NOT NULL OR parse_status IN ('failed', 'unsupported');
