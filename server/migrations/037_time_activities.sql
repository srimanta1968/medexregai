-- F4.1 Time capture by activity (PRD v2.0 FR-14.20): the activity codes time is logged against.
--
-- The codes are the A3 activities of the consultant validation workbook ("Where the hours go
-- between receiving client information and filing", MedexRegAI-Consultant-Validation-Workbook-
-- 510k v4.0 Part A, section A3). The descriptions below are that workbook's wording, so pilot
-- time logs compare line for line with what consultants reported in the workbook. They feed the
-- G2' and G3' metrics (hours on drafted sections: write + tabulate + reconcile; whole-project
-- hours). Reference data shared by every firm; firms cannot add codes.

CREATE TABLE IF NOT EXISTS time_activities (
  code        varchar(20) PRIMARY KEY,
  ordinal     smallint NOT NULL UNIQUE,
  label       varchar(40) NOT NULL,
  description varchar(200) NOT NULL
);

INSERT INTO time_activities (code, ordinal, label, description) VALUES
  ('chase',         1, 'Chase',         'Asking the client for information, and chasing what is missing or late'),
  ('find',          2, 'Find',          'Finding the right file and the latest version; sorting and naming'),
  ('version',       3, 'Version',       'Tracking versions, and rework when a new revision replaces one you already used'),
  ('map',           4, 'Map',           'Mapping client documents to eSTAR sections and FDA requirements'),
  ('trace',         5, 'Trace',         'Keeping traceability current when a document changes'),
  ('read',          6, 'Read',          'Reading reports, protocols, raw data and drawings to pull out what the submission needs'),
  ('reconcile',     7, 'Reconcile',     'Resolving conflicts between documents (for example specification vs drawing vs test report vs IFU)'),
  ('tabulate',      8, 'Tabulate',      'Building summary tables from test data'),
  ('write',         9, 'Write',         'Writing the section text once the facts are clear'),
  ('forms',        10, 'Forms',         'Filling in templates and administrative forms'),
  ('attachments',  11, 'Attachments',   'Preparing attachments for eSTAR (format, combining, naming, bookmarks)'),
  ('client_review',12, 'Client review', 'Client review rounds on the drafts')
ON CONFLICT (code) DO UPDATE SET ordinal = EXCLUDED.ordinal, label = EXCLUDED.label, description = EXCLUDED.description;
