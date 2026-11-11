# ⚠️ API Definition Description / Error-Case Gaps (MUST-42 / MUST-43)

Single reused backlog — regenerated every commit; entries drop off as they are
fixed. Each api_definition below is missing a QA-grade `description` (what it does
+ EDGE CASES) and/or a root-level `errorCases` array (every error the handler
returns: {status, code, message, when}). These feed **api_library.description**
and the **LLM test-data generator**. Fix EVERY file below — read each handler to
enumerate real errors; do not guess.

- [ ] `POST /api/inbound/email` — tests/api_definitions/inbound/inbound-email-relay-post.json → missing: negative testCase for 2 errorCase(s) (MUST-64): 404/RECIPIENT_UNKNOWN, 413/FILE_TOO_LARGE
- [ ] `PATCH /api/projects/:projectId/inbound-email` — tests/api_definitions/inbound/project-inbound-email-patch.json → missing: negative testCase for 1 errorCase(s) (MUST-64): 409/INBOUND_EMAIL_NOT_CONFIGURED
- [ ] `POST /api/projects/:projectId/inbound-email` — tests/api_definitions/inbound/project-inbound-email-post.json → missing: negative testCase for 1 errorCase(s) (MUST-64): 409/INBOUND_EMAIL_NOT_CONFIGURED
- [ ] `POST /api/requests/:requestId/draft-message` — tests/api_definitions/requests/request-draft-message-post.json → missing: negative testCase for 1 errorCase(s) (MUST-64): 409/REQUEST_NOT_DRAFT
- [ ] `POST /api/requests/:requestId/link` — tests/api_definitions/requests/request-link-post.json → missing: negative testCase for 1 errorCase(s) (MUST-64): 409/REQUEST_NOT_OPEN
- [ ] `POST /api/u/:token/files` — tests/api_definitions/requests/upload-link-files-post.json → missing: negative testCase for 3 errorCase(s) (MUST-64): 413/FILE_TOO_LARGE, 409/UPLOAD_LIMIT_REACHED, 422/FILE_INFECTED
- [ ] `GET /api/project-deletions/:deletionId/certificate` — tests/api_definitions/trust/project-deletion-certificate-get.json → missing: negative testCase for 1 errorCase(s) (MUST-64): 409/DELETION_IN_PROGRESS

Call `projexlight_get_api_definition_rules` for the exact format.