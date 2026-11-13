-- F6.1 free device checks from the public product-code pages.
-- Platform-scoped (a visitor, no firm). The check itself runs on FDA data only and its result
-- is returned to the visitor. What is kept:
--   - always: the product code, the time and an HMAC of the IP (per-IP rate limiting, same
--     scheme as pilot_requests; the IP itself is never stored);
--   - only when the visitor ticks "contact me": their email and the device description they
--     typed, so we can follow up. Without consent neither is stored.

CREATE TABLE IF NOT EXISTS device_checks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_code    varchar(3) NOT NULL,
  contact_consent boolean NOT NULL DEFAULT false,
  email           varchar(254),
  description     varchar(2000),
  source_ip_hash  char(64) NOT NULL,
  status          varchar(16) NOT NULL DEFAULT 'new',
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_checks_code_chk CHECK (product_code ~ '^[A-Z]{3}$'),
  CONSTRAINT device_checks_email_lower_chk CHECK (email IS NULL OR email = lower(email)),
  -- Nothing personal without consent.
  CONSTRAINT device_checks_consent_chk CHECK (contact_consent OR (email IS NULL AND description IS NULL)),
  CONSTRAINT device_checks_contact_chk CHECK (NOT contact_consent OR email IS NOT NULL),
  CONSTRAINT device_checks_status_chk CHECK (status IN ('new', 'contacted', 'closed'))
);

-- Rate-limit lookup: recent checks from one hashed IP.
CREATE INDEX IF NOT EXISTS device_checks_ip_recent_idx ON device_checks (source_ip_hash, created_at DESC);
-- Operator follow-up queue: leads that asked to be contacted.
CREATE INDEX IF NOT EXISTS device_checks_leads_idx ON device_checks (status, created_at DESC) WHERE contact_consent;
