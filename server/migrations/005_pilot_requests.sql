-- F0.5 Pilot requests from the public website.
-- Platform-scoped (no firm exists yet). Read only by operators; the public endpoint
-- returns nothing but the new id. The visitor's IP is never stored: source_ip_hash
-- is an HMAC of it under a server secret, enough for per-IP rate limiting.

CREATE TABLE IF NOT EXISTS pilot_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            varchar(200) NOT NULL,
  work_email      varchar(254) NOT NULL,
  firm_name       varchar(200) NOT NULL,
  role            varchar(120),
  message         varchar(4000) NOT NULL,
  source_ip_hash  char(64) NOT NULL,
  user_agent      varchar(400),
  status          varchar(16) NOT NULL DEFAULT 'new',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pilot_requests_status_chk CHECK (status IN ('new', 'contacted', 'qualified', 'closed')),
  CONSTRAINT pilot_requests_email_lower_chk CHECK (work_email = lower(work_email))
);

-- Rate-limit lookup: recent requests from one hashed IP.
CREATE INDEX IF NOT EXISTS pilot_requests_ip_recent_idx ON pilot_requests (source_ip_hash, created_at DESC);
-- Operator follow-up queue.
CREATE INDEX IF NOT EXISTS pilot_requests_status_idx ON pilot_requests (status, created_at DESC);
