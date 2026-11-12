-- F3.5 Draft check: predicate K-numbers found in a section draft, checked against the FDA
-- data service (ADR-017: the app keeps no FDA tables; this is the record of what the check
-- saw, dated, so a consultant can show what was verified and when).
--
-- section_drafts.fda_check_status: the draft's check runs in the worker (never inline in the
-- API in production). pending -> checking -> done | failed; a re-check sets it back to pending.
--
-- draft_fda_checks: one row per K-number per draft.
--   status verified     the K-number is in FDA's 510(k) data (clearance snapshot kept)
--          not_found    not in our copy of FDA's 510(k) data
--          unavailable  the FDA data service could not be reached; re-check later
--   statement_ordinals: the statements that mention it, for the inline chips.

ALTER TABLE section_drafts ADD COLUMN IF NOT EXISTS fda_check_status varchar(10) NOT NULL DEFAULT 'pending';
ALTER TABLE section_drafts ADD COLUMN IF NOT EXISTS fda_check_started_at timestamptz;
ALTER TABLE section_drafts ADD COLUMN IF NOT EXISTS fda_checked_at timestamptz;
ALTER TABLE section_drafts ADD COLUMN IF NOT EXISTS fda_check_error text;
DO $$ BEGIN
  ALTER TABLE section_drafts ADD CONSTRAINT section_drafts_fda_check_chk CHECK (fda_check_status IN ('pending', 'checking', 'done', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS section_drafts_fda_check_idx ON section_drafts (org_id, fda_check_status) WHERE fda_check_status IN ('pending', 'checking');

CREATE TABLE IF NOT EXISTS draft_fda_checks (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL,
  draft_id           uuid NOT NULL REFERENCES section_drafts(id) ON DELETE CASCADE,
  k_number           varchar(9) NOT NULL,
  statement_ordinals integer[] NOT NULL DEFAULT '{}',
  status             varchar(12) NOT NULL,
  -- verified: applicant, deviceName, productCode, decisionDate, decisionDescription, fdaUrl
  clearance          jsonb,
  -- recalls { total, open, items[] }, maude { tracked, reportsLast12Months, note }
  flags              jsonb,
  data_as_of         date,
  checked_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT draft_fda_checks_status_chk CHECK (status IN ('verified', 'not_found', 'unavailable')),
  CONSTRAINT draft_fda_checks_unique UNIQUE (draft_id, k_number)
);
CREATE INDEX IF NOT EXISTS draft_fda_checks_draft_idx ON draft_fda_checks (org_id, draft_id);

