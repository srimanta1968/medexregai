# ⚠️ API Definition Description / Error-Case Gaps (MUST-42 / MUST-43)

Single reused backlog — regenerated every commit; entries drop off as they are
fixed. Each api_definition below is missing a QA-grade `description` (what it does
+ EDGE CASES) and/or a root-level `errorCases` array (every error the handler
returns: {status, code, message, when}). These feed **api_library.description**
and the **LLM test-data generator**. Fix EVERY file below — read each handler to
enumerate real errors; do not guess.

- [ ] `POST /api/auth/login` — tests/api_definitions/auth/login-post.json → missing: negative testCase for 1 errorCase(s) (MUST-64): 403/NO_ACTIVE_MEMBERSHIP
- [ ] `GET /api/auth/me` — tests/api_definitions/auth/me-get.json → missing: negative testCase for 1 errorCase(s) (MUST-64): 401/TOKEN_EXPIRED
- [ ] `POST /api/auth/register` — tests/api_definitions/auth/register-post.json → missing: negative testCase for 1 errorCase(s) (MUST-64): 409/EMAIL_TAKEN
- [ ] `GET /health` — tests/api_definitions/health/health-get.json → missing: errorCases[] (MUST-43)

Call `projexlight_get_api_definition_rules` for the exact format.