-- F6.2 opt-in introductions (UI 2.0 §8.2): a device company asks to be introduced to a
-- consultant; the request is offered only to consultant firms that opted in and whose
-- specialties and pathways match. The company's contact details are shown to a firm only after
-- it accepts the introduction.
--
-- firm_intro_settings and intro_requests are platform tables: routing must read every firm's
-- opt-in, and the request comes from a visitor with no firm. Neither holds client data. Each
-- firm's offers live in the tenant table introductions.

CREATE TABLE IF NOT EXISTS firm_intro_settings (
  org_id       uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  opted_in     boolean NOT NULL DEFAULT false,
  -- FDA medical specialty (review panel) codes, e.g. CV, HO; empty = any specialty.
  specialties  text[] NOT NULL DEFAULT '{}',
  -- 510k | de_novo | pma; empty = any pathway.
  pathways     text[] NOT NULL DEFAULT '{}',
  -- What the firm tells companies about itself (shown only with an accepted introduction).
  profile      varchar(1000),
  updated_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT firm_intro_specialties_chk CHECK (specialties <@ ARRAY['AN','CV','CH','TX','DE','EN','GU','SU','HO','HE','IM','MI','NE','OB','OP','OR','PA','PM','RA']::text[]),
  CONSTRAINT firm_intro_pathways_chk CHECK (pathways <@ ARRAY['510k','de_novo','pma']::text[])
);
CREATE INDEX IF NOT EXISTS firm_intro_settings_opted_idx ON firm_intro_settings (updated_at) WHERE opted_in;

CREATE TABLE IF NOT EXISTS intro_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name    varchar(200) NOT NULL,
  contact_name    varchar(200) NOT NULL,
  contact_email   varchar(254) NOT NULL,
  -- What the company wants help with, as they wrote it (shown to offered firms as the brief).
  brief           varchar(2000) NOT NULL,
  product_code    char(3),
  specialty       varchar(2),
  -- 510k | de_novo | pma | unsure
  pathway         varchar(8) NOT NULL,
  -- The company agreed that its request may be shared with matched consultant firms.
  consent_at      timestamptz NOT NULL,
  source_ip_hash  char(64) NOT NULL,
  offered_count   integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT intro_requests_email_lower_chk CHECK (contact_email = lower(contact_email)),
  CONSTRAINT intro_requests_code_chk CHECK (product_code IS NULL OR product_code ~ '^[A-Z]{3}$'),
  CONSTRAINT intro_requests_pathway_chk CHECK (pathway IN ('510k', 'de_novo', 'pma', 'unsure'))
);
CREATE INDEX IF NOT EXISTS intro_requests_ip_recent_idx ON intro_requests (source_ip_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS introductions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  request_id   uuid NOT NULL REFERENCES intro_requests(id) ON DELETE CASCADE,
  -- offered -> accepted | declined
  status       varchar(10) NOT NULL DEFAULT 'offered',
  offered_at   timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  decided_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT introductions_org_request_uq UNIQUE (org_id, request_id),
  CONSTRAINT introductions_status_chk CHECK (status IN ('offered', 'accepted', 'declined')),
  CONSTRAINT introductions_decided_chk CHECK ((status = 'offered') = (decided_at IS NULL))
);
-- A firm's inbox, newest first (cursor paging).
CREATE INDEX IF NOT EXISTS introductions_org_offered_idx ON introductions (org_id, offered_at DESC, id DESC);
-- Routing balances load: open offers per firm.
CREATE INDEX IF NOT EXISTS introductions_open_idx ON introductions (org_id) WHERE status = 'offered';
