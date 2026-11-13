# MedexRegAI operational runbooks

Status: draft for Phase 3 hardening (F4.4). Source: Architecture v2.0 (MRA-PRD-203) §15, which
names five runbooks: connector token revoked, provider outage, OCR backlog, injection alert and
deletion request. Each runbook below describes what the system already does, how to see it, what
the on-call person does, and what to tell the firm.

Facts quoted from the code (file paths given) were current at commit time; re-check them after a
change. Items marked **TO CONFIRM** need a decision or a production fact we do not have yet.

Common ground for all five:

- **Who is on call.** TO CONFIRM: the rota and the paging tool. Until then, the alert address is
  `OPS_ALERT_EMAIL` (server/src/config/env.ts).
- **Never** read client document text to diagnose a problem unless the firm asks in writing; use
  ids, hashes, counts and statuses. Every action you take through the app is audited.
- **We never file with FDA and never sign** (Architecture §3). Nothing here changes that.
- Write a short incident note afterwards: what happened, start and end time (UTC), firms
  affected, what was done, and what we change.

---

## 1. Connector token revoked

**What it is.** A firm's Dropbox, Box, Microsoft (SharePoint/OneDrive) or Google Drive grant stops
working: a user revoked MedexRegAI in the provider's connected-apps list, an admin changed policy,
a password reset ended the session, or the refresh token expired.

**What the system does already.**
- When the provider refuses our token, the connection is set to `needs_reauth` and its error is
  kept in `folder_connections.last_error` (server/src/connections/ConnectionStore.ts). Its folder
  links pause; nothing is deleted (server/src/connections/FolderSync.ts).
- Calls on that connection answer 409 `CONNECTION_NEEDS_REAUTH`, "Reconnect this account to resume
  syncing". A connection the firm disconnected is `revoked` and answers 409 `CONNECTION_REVOKED`.
- Files already read stay readable in MedexRegAI; only new changes in the folder stop arriving.

**How to see it.**
- The firm sees the account as needing reconnection on the project's Connect page
  (`/app/projects/:projectId/connect`).
- Operator: count connections by status and provider (no client data involved):
  `SELECT provider, status, count(*) FROM folder_connections GROUP BY 1, 2;`
  A jump in `needs_reauth` for one provider at once points at the provider or at our app
  registration, not at one firm.

**What to do.**
1. One firm: tell the firm owner to reconnect the account on the Connect page. Syncing resumes from
   the provider's change cursor; the nightly hash sweep catches anything missed.
2. Many firms, one provider: check the provider's status page, then our app registration (client
   secret expiry, redirect URI, granted scopes). An expired client secret is the usual cause;
   rotate it in the secret store and redeploy, then ask firms to reconnect only if the provider
   requires it.
3. Do not try to restore access by any route other than the firm reconnecting. We hold read-only,
   user-granted access and never ask for passwords.

**Tell the firm.** "Your <provider> connection needs to be renewed. Files already read are safe in
MedexRegAI; new changes will arrive again once you reconnect on the Connect page."

---

## 2. AI provider outage

**What it is.** The model provider (the platform default or a firm's own override, set in
`/app/settings/ai`) is unreachable, slow, or returns errors.

**What the system does already.**
- A failed call becomes 503 `AI_UNAVAILABLE` ("The AI model is not reachable right now ... Try
  again shortly.") and is marked retryable with a 30 s hint (server/src/ai/errors.ts).
- A section draft that cannot be generated is marked `failed` with the reason
  (server/src/drafting/SectionDrafter.ts); the consultant can start it again. No partial draft is
  shown as finished, and nothing bypasses the citation gate.
- Parsing, sorting by rules, problems, time logging, exports and the Word round trip keep working;
  only AI steps (classification by model, drafting, request wording) wait.
- Request timeout is `AI_REQUEST_TIMEOUT_MS` (default 120000 ms).

**How to see it.**
- Errors in the API and worker logs with code `AI_UNAVAILABLE`; drafts with `status = 'failed'`
  in the last hour: `SELECT count(*) FROM section_drafts WHERE status = 'failed' AND finished_at > now() - interval '1 hour';`
- The provider's status page.

**What to do.**
1. Confirm it is the provider (status page, one test call from the AI settings page's evaluation)
   and not our network or an expired key (an expired or revoked key fails every call at once; HTTP
   401/403 in the log).
2. Provider down: wait; retry failed drafts once it recovers. Do not switch a firm to another
   provider on its behalf. A firm's provider choice is part of what it told its clients (trust
   pack); a firm owner may switch its own override in AI settings.
3. Platform key problem: rotate `AI_API_KEY` in the secret store and redeploy.
4. Longer than 2 hours during a pilot (TO CONFIRM threshold): tell affected firms.

**Tell the firm.** "Drafting is paused because our AI provider is unavailable. Your files,
problems and drafts already made are unaffected. Drafts that failed can be started again once it is
back; we will tell you when."

---

## 3. OCR backlog

**What it is.** Files wait too long to be read, so the sorted folder is late. The SLO is 500 files
sorted in 60 minutes (Architecture §15).

**What the system does already.**
- The worker publishes the ingest queue depth (file versions queued or parsing) every 10 s as the
  CloudWatch metric `MedexRegAI/Ingest QueueDepth` when `DOCPROC_QUEUE_METRIC=true`
  (server/src/worker.ts).
- Alarm `<env>-docproc-queue-high` adds docproc tasks when the depth stays at or above
  `docproc_scale_out_depth` for 2 minutes; `<env>-docproc-queue-idle` removes one after 15 minutes
  empty (infra/terraform/modules/platform/docproc.tf).
- A parse claimed for more than 15 minutes goes back to the queue; after 3 attempts the file is
  marked failed (STALE_PARSE_MINUTES, MAX_PARSE_ATTEMPTS in server/src/ingest/IngestService.ts).
- Scanned pages with no text layer, when OCR is not installed, are recorded with the note "Some
  pages have no text layer and were not read (OCR not installed)" and listed as unreadable
  (`no_text`), so the firm sees them rather than missing them silently.

**How to see it.**
- The QueueDepth graph and the two alarms.
- docproc `/health` reports whether OCR is installed (`"ocr": true|false`).
- Oldest waiting file:
  `SELECT min(created_at) FROM file_versions WHERE parse_status IN ('queued', 'parsing');`

**What to do.**
1. Depth rising but tasks not scaling: check the scaling policy, the service's maximum task count
   and account limits. Raise the maximum if the queue is genuine load.
2. Tasks running but nothing finishing: check docproc logs for parse timeouts or crashes on one
   file type; one bad file retries 3 times and then fails, it does not block the rest.
3. Many `no_text` files: confirm `/health` shows OCR; if OCR is down, fix and re-queue those
   versions (TO CONFIRM: re-queue tool; today it is a status reset on `file_versions`, done only
   by an engineer, with an incident note).
4. docproc has no internet egress by design (Architecture §4). Do not open egress to fix a backlog.

**Tell the firm.** "Files are taking longer than usual to read; they are queued, not lost. The
sorted folder will fill in as they finish."

---

## 4. Injection alert

**What it is.** Text in a client file reads like instructions to an AI ("ignore previous
instructions", requests to reveal prompts, and similar), or the CI injection suite fails.

**What the system does already.**
- Every parsed file is scanned; matches are stored as `file_versions.injection_signals`
  (server/src/ingest/IngestService.ts). This is a warning for the reviewer, never a change in
  handling: document text goes to models only as delimited data, with no tools on document routes
  (ADR-016).
- The Files page shows "Text in this file reads like instructions to an AI (N places)" on that file
  (client/src/pages/app/ProjectFilesPage.tsx).
- `npm run test:injection` (server) runs the injection suite (server/src/ai/guard/injectionSuite.ts).

**How to see it.**
- Firm side: the notice on the file.
- Operator side: count of flagged versions per day (ids only):
  `SELECT date(parsed_at), count(*) FROM file_versions WHERE jsonb_array_length(injection_signals) > 0 GROUP BY 1 ORDER BY 1 DESC;`
- CI: a failed injection-suite job.

**What to do.**
1. A flag on a client file: normally nothing for us. The consultant decides whether the file is
   genuine. Help if asked, using the file's id and hash, not its text.
2. A sign the model followed embedded text (a draft statement or request wording that obeys the
   file instead of citing it): treat as a security incident. Stop drafting for that project, keep
   the draft, gate run and file version ids, and escalate to the engineering lead the same day.
3. CI injection suite failing: block the release until it passes; never mark the test skipped.

**Tell the firm.** For a flag: nothing beyond the notice. For a confirmed incident: what happened,
which project and outputs are affected, and what we changed, within the timeline in the firm's
agreement (TO CONFIRM).

---

## 5. Deletion request

**What it is.** A firm, or a firm on its client's behalf, asks us to delete a project's data.

**What the system does already.**
- The firm owner or admin deletes a project in one action, with typed confirmation:
  `POST /api/projects/:projectId/deletion` answers 202 (server/src/routes/trust.ts). Rows go
  first; then stored file objects are removed by the worker (status `removing_files`, then
  `completed`).
- The commitment is completion within 30 days of the request (`deletionDays: 30`,
  server/src/config/env.ts). Copies in encrypted database backups expire
  `BACKUP_RETENTION_DAYS` days (default 35) after the backup was taken; the certificate says so.
- When complete, `GET /api/project-deletions/:deletionId/certificate` gives a PDF certificate
  (409 `DELETION_IN_PROGRESS` until then). Audit events keep hashes only (NFR-14).

**How to see it.**
- The firm's Trust pack page lists its deletions and progress.
- Operator: deletions not yet complete and how close they are to their deadline:
  `SELECT id, org_id, requested_at, due_by, objects_removed, objects_total, last_error FROM project_deletions WHERE status <> 'completed' ORDER BY due_by;`

**What to do.**
1. Request by email instead of in the app: ask the firm owner or admin to run it from the app, so
   the confirmation and audit trail are theirs. Do not delete on an unverified email.
2. A deletion stuck in `removing_files` (`last_error` set): fix the cause (usually object-store
   permissions or availability); the worker resumes it. Escalate any deletion within 5 days of
   `due_by`.
3. Never restore a deleted project from backup into production. A restore for any other reason
   must re-apply completed deletions before the system is reopened (TO CONFIRM: restore procedure).

**Tell the firm.** Send the certificate when it completes, and remind them that backup copies
expire on the date the certificate states.

## 6. Database roles and row-level security (F8.1)

Every tenant table has row-level security with FORCE (migrations 049, 050): a row is visible and
writable only when its `org_id` equals the transaction's `app.org_id`, which `DataService` sets.
Token lookups before the firm is known use a one-statement exception (`app.rls_token_lookup`), and a
person may read their own memberships across firms (`app.user_id`). Superusers and roles with
BYPASSRLS skip all of this, so:

1. **The app never connects as the owner or a superuser.** Migration 049 creates `medexregai_app`
   (NOLOGIN, NOBYPASSRLS) with read/write on all tables, including tables added later.
2. **Give it a login once per environment**, as the owner:
   `ALTER ROLE medexregai_app LOGIN PASSWORD '<generated>';`
   In AWS the password is already generated: Terraform output `app_db_secret_arn` (key `password`);
   run the statement after the first `migrate` task. Dev: put it in `server/.env` (gitignored).
3. **App config:** `DB_USER=medexregai_app`, `DB_PASSWORD=<that password>`.
   **Migrations:** `DB_MIGRATION_USER` / `DB_MIGRATION_PASSWORD` = the owner (RDS master user in AWS).
4. **Check it** as `medexregai_app`: `SELECT count(*) FROM client_workspaces;` with no
   `app.org_id` set must return 0, and `SET row_security = off` must fail.

If the app ever returns no data at all after a deploy, check that `DB_USER` is not the owner (that
would hide nothing) and that `app.org_id` is being set (that would hide everything).

### Connection pooling (PgBouncer)

In AWS the api and worker connect to PgBouncer (`pgbouncer.<env>.internal:6432`, transaction mode),
not to RDS; PgBouncer holds at most `pgbouncer_count x pgbouncer_max_db_connections` RDS connections
and verifies RDS over TLS. Transaction mode is safe here because every per-request setting is
transaction-local. Rules that keep it safe:

- **Never** `SET` (session) or `set_config(..., false)`, session advisory locks, `LISTEN`, or named
  prepared statements in app code; use `SET LOCAL`, `set_config(..., true)`,
  `pg_advisory_xact_lock`.
- **Migrations go direct**: the `migrate` task (`migrate_task_definition` output) uses
  `DB_MIGRATION_HOST` = the RDS address; their advisory lock needs a real session.
- **Budget**: keep `pgbouncer_count x pgbouncer_max_db_connections` plus headroom for migrations
  and operators under RDS `max_connections`; raise `pgbouncer_default_pool_size` before adding
  app tasks if `cl_waiting` grows (PgBouncer logs pool stats every 60 s).
- **Symptoms**: "no more connections allowed (max_client_conn)" means raise
  `pgbouncer_max_client_conn` or lower `DB_POOL_MAX`; "query_wait_timeout" means the pool is too
  small for the load or a slow query holds connections.

Local: `docker compose --profile pgbouncer up -d pgbouncer` (see docker-compose.yml).

