# ⚠️ API Definition Description / Error-Case Gaps (MUST-42 / MUST-43)

Single reused backlog — regenerated every commit; entries drop off as they are
fixed. Each api_definition below is missing a QA-grade `description` (what it does
+ EDGE CASES) and/or a root-level `errorCases` array (every error the handler
returns: {status, code, message, when}). These feed **api_library.description**
and the **LLM test-data generator**. Fix EVERY file below — read each handler to
enumerate real errors; do not guess.

- [ ] `GET /health` — tests/api_definitions/health/health-get.json → missing: errorCases[] (MUST-43)

Call `projexlight_get_api_definition_rules` for the exact format.