-- F0.3 Append-only, hash-chained audit log (PRD P1-03, NFR audit).
--
-- One chain per firm: every row stores the previous row's hash, and its own hash
-- covers that link plus all of its fields, so altering or removing any past row
-- breaks every later hash. The chain is computed HERE, in a trigger, so no
-- application code path can write an unchained or forged row. UPDATE, DELETE and
-- TRUNCATE are refused by triggers.
--
-- org_id has no foreign key on purpose: deleting a firm must not cascade into (and
-- be blocked by, or erase) its audit trail. Rows hold ids and small metadata only,
-- never client content, so per-project deletion (NFR-14) leaves hashes, not data.
--
-- Operational escape hatch (DBA only, recorded in change control): triggers do not
-- fire under `SET session_replication_role = replica`.

CREATE TABLE IF NOT EXISTS audit_events (
  id             bigserial PRIMARY KEY,
  org_id         uuid NOT NULL,
  seq            bigint NOT NULL,
  actor_user_id  uuid,
  action         varchar(64) NOT NULL,
  target_type    varchar(32) NOT NULL,
  target_id      uuid,
  workspace_id   uuid,
  project_id     uuid,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  prev_hash      char(64) NOT NULL,
  hash           char(64) NOT NULL,
  CONSTRAINT audit_events_org_seq_uq UNIQUE (org_id, seq),
  CONSTRAINT audit_events_action_chk CHECK (action ~ '^[a-z][a-z0-9_.]*$'),
  CONSTRAINT audit_events_metadata_size_chk CHECK (octet_length(metadata::text) <= 4096)
);

-- Recent activity for a submission, newest first.
CREATE INDEX IF NOT EXISTS audit_events_project_idx ON audit_events (org_id, project_id, created_at DESC, id DESC) WHERE project_id IS NOT NULL;
-- Firm-wide activity feed.
CREATE INDEX IF NOT EXISTS audit_events_org_created_idx ON audit_events (org_id, created_at DESC, id DESC);

-- Canonical text that a row's hash covers (stable field order and formats).
CREATE OR REPLACE FUNCTION audit_event_payload(e audit_events) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT concat_ws('|',
    e.prev_hash, e.org_id::text, e.seq::text, coalesce(e.actor_user_id::text, ''), e.action, e.target_type,
    coalesce(e.target_id::text, ''), coalesce(e.workspace_id::text, ''), coalesce(e.project_id::text, ''),
    e.metadata::text, to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
$$;

CREATE OR REPLACE FUNCTION audit_events_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  last_seq  bigint;
  last_hash char(64);
BEGIN
  -- One writer per firm chain at a time; other firms are not blocked.
  PERFORM pg_advisory_xact_lock(hashtext('audit:' || NEW.org_id::text));
  SELECT seq, hash INTO last_seq, last_hash
    FROM audit_events WHERE org_id = NEW.org_id ORDER BY seq DESC LIMIT 1;
  NEW.seq := coalesce(last_seq, 0) + 1;
  NEW.prev_hash := coalesce(last_hash, repeat('0', 64));
  NEW.created_at := now();
  NEW.hash := encode(sha256(convert_to(audit_event_payload(NEW), 'UTF8')), 'hex');
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS audit_events_chain_trg ON audit_events;
CREATE TRIGGER audit_events_chain_trg BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_chain();

DROP TRIGGER IF EXISTS audit_events_no_update_delete_trg ON audit_events;
CREATE TRIGGER audit_events_no_update_delete_trg BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

DROP TRIGGER IF EXISTS audit_events_no_truncate_trg ON audit_events;
CREATE TRIGGER audit_events_no_truncate_trg BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_immutable();

-- First broken link in a firm's chain (NULL = intact): a wrong prev_hash, a hash
-- that no longer matches the row, or a gap in seq.
CREATE OR REPLACE FUNCTION audit_verify_chain(p_org uuid)
RETURNS TABLE (broken_seq bigint, reason text)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  r          audit_events;
  expected   char(64) := repeat('0', 64);
  next_seq   bigint := 1;
BEGIN
  FOR r IN SELECT * FROM audit_events WHERE org_id = p_org ORDER BY seq LOOP
    IF r.seq <> next_seq THEN
      broken_seq := next_seq; reason := 'missing sequence number'; RETURN NEXT; RETURN;
    END IF;
    IF r.prev_hash <> expected THEN
      broken_seq := r.seq; reason := 'previous hash does not match'; RETURN NEXT; RETURN;
    END IF;
    IF r.hash <> encode(sha256(convert_to(audit_event_payload(r), 'UTF8')), 'hex') THEN
      broken_seq := r.seq; reason := 'row content does not match its hash'; RETURN NEXT; RETURN;
    END IF;
    expected := r.hash;
    next_seq := r.seq + 1;
  END LOOP;
END;
$$;
