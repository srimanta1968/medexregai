-- F2.3: when a project's problems were last worked out, so the worker re-checks only
-- projects whose files or sorting changed since.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS problems_checked_at timestamptz;
