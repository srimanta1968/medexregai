-- F2.1 folder sync: what the sync job needs to know about a linked file without
-- downloading it again.
--   source_hash  the provider's own content hash as "<algorithm>:<value>" (Dropbox
--                content_hash, Box sha1, Graph quickXorHash, Drive sha256/md5), or
--                "mtime:<iso>" when the provider has none (native Google files).
--                Equal hash -> the file is not fetched again.
--   source_path  path inside the linked folder, for display and because Dropbox
--                reports deletions by path only.
ALTER TABLE files ADD COLUMN IF NOT EXISTS source_hash varchar(200);
ALTER TABLE files ADD COLUMN IF NOT EXISTS source_path varchar(1024);
CREATE INDEX IF NOT EXISTS files_folder_link_path_idx ON files (folder_link_id, lower(source_path)) WHERE folder_link_id IS NOT NULL;

-- The worker looks for due links one firm at a time.
CREATE INDEX IF NOT EXISTS project_folder_links_org_due_idx ON project_folder_links (org_id, next_sync_at) WHERE status = 'active';
