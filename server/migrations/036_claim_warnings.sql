-- F3.6 Claim checker: warnings on a drafted statement that claims more than the project's
-- Indications for Use or the statement's own cited source supports. Kept apart from
-- draft_statements.warnings (the citation gate's) so a re-check replaces only its own.
-- Advisory: a warned statement stays in the draft for the consultant to decide.

ALTER TABLE draft_statements ADD COLUMN IF NOT EXISTS claim_warnings jsonb NOT NULL DEFAULT '[]'::jsonb;
