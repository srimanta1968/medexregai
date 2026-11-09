# ProjexLight Code Generation

## STEP 0: VERIFY CURL IS INSTALLED (MANDATORY)

Before proceeding, you MUST verify curl is available. Run this check:

```bash
curl --version
```

### If curl is NOT installed:

**Windows (run in PowerShell as Admin):**
```powershell
winget install curl.curl
```
Or download from: https://curl.se/windows/

**macOS:**
```bash
brew install curl
```

**Linux (Ubuntu/Debian):**
```bash
sudo apt-get update && sudo apt-get install -y curl
```

**Linux (CentOS/RHEL/Fedora):**
```bash
sudo yum install -y curl
```

**Alpine Linux:**
```bash
apk add curl
```

### ⚠️ STOP IF CURL INSTALLATION FAILS

If curl cannot be installed automatically:
1. **STOP code generation immediately**
2. **Tell the user:** "curl is required but not installed. Please install curl manually and restart."
3. **DO NOT proceed** until curl is confirmed working

### Verify curl works:
```bash
curl --version
```
If this shows version info, proceed to Step 1.

---

## STEP 1: DETECT PROJECT PATH

First, get your project path in Unix format:

**Windows:** Convert `C:\Users\name\project` to `/c/Users/name/project`
**Mac/Linux:** Use path as-is (e.g., `/Users/name/project`)

---

## STEP 2: READ PROJECT CONFIGURATION

```
.projexlight/context/framework-config.json
```

This tells you the language/framework. If all values are null, this is likely a legacy extraction project — its stack is not known at export time and gets DETECTED from the code in Task 3.

---

## STEP 3: GET COMPLETE WORKFLOW

Fetch the complete development workflow:

```bash
curl "http://localhost:8766/api/instruction/bootstrap"
```

It returns the EXECUTION_FLOW for all phases plus the curl/MCP mapping. Follow
NEXT_STEP from the response.

> The response is the same for every project — it carries no PROJECT_TYPE or
> MCP_TOOLS key, so do not wait for one. Your language and framework come from
> .projexlight/context/framework-config.json, read in STEP 2.

---

## STEP 3.5: SET UP MCP AND USE `projexlight_*` TOOLS (MANDATORY)

**After the initial bootstrap curl call in Step 3, every subsequent *workflow* API interaction MUST go through `projexlight_*` MCP tools. curl is NOT an acceptable fallback for running the ProjexLight workflow.**

### The one exception: repairing a broken bridge

There is exactly one case where curl is not only allowed but expected — **diagnosing and fixing the MCP bridge itself when it is not correctly configured in the current session.** The rule below draws the line:

| Call type | Examples | Use |
|---|---|---|
| **Workflow** — reading tasks, writing code, validating, completing | `/api/instruction/get`, `/api/instruction/validate`, `/api/instruction/complete` | **MCP tools only.** Never curl, even when the bridge is down — repair the bridge first. |
| **Bridge repair** — proving the server is reachable and pointed at the right project | `/health`, `/api/projects`, `/api/context/current`, `/api/context/set`, `DELETE /api/projects/{id}` | **curl is fine.** These diagnose and repair configuration; they do not advance the workflow. |

Why the asymmetry: workflow calls depend on `sessionToken`, `projectId`, and `projectPath` that the bridge injects for you, so hand-rolled curl silently corrupts state. Repair calls concern the bridge's *own* configuration — refusing curl there would leave you unable to fix the very thing that unblocks the tools.

**Once the bridge is repaired, restart the CLI host. From that new session onward, use `projexlight_*` tool calls for everything — the curl exception does not carry over.**

### Step 3.5.a — Check whether MCP tools are already loaded

Your CLI host (Claude Code / Cursor / Windsurf / Copilot / Goose / Cline / Amazon Q / Antigravity) exposes connected MCP tools in your tool list. Look for any tool whose name starts with `projexlight_`.

- **If one or more `projexlight_*` tools are visible** → MCP is connected. Skip to Step 3.5.c and use them.
- **If zero `projexlight_*` tools are visible** → MCP is not yet set up. Go to Step 3.5.b.

### Step 3.5.b — Set up MCP from PROJEXLIGHT_SETUP.md

**Read `PROJEXLIGHT_SETUP.md` at the project root and follow it end-to-end.** That file is the authoritative setup guide shipped with every export — it covers Docker Compose prerequisites, the `mcp-server/setup-all.sh` bootstrap script, health checks on `http://localhost:8766/health`, and CLI-host registration.

```bash
# Follow PROJEXLIGHT_SETUP.md — the canonical steps are:
cd mcp-server && ./setup-all.sh          # creates containers, registers project
curl http://localhost:8766/health         # confirm server is up
```

### Step 3.5.b.1 — Clean the project registry (MANDATORY after every `setup-all.sh`)

`setup-all.sh` REGISTERS this project. It does not REMOVE earlier registrations — so a
re-export (new sprint, re-download, renamed or moved folder) leaves stale rows behind, and
several projects share one MCP server. A registry with two rows claiming one path is not a
cosmetic problem: `/api/context/current` then returns `projectId: null` with
`activeProjectCount: 0` and `warning: null` — it reports *nothing registered* rather than
*ambiguous* — and any code path that falls back to path resolution can silently run against
another project's credentials and task list.

Prune it every time, immediately after setup:

```bash
curl http://localhost:8766/api/projects
```

Compare every row against THIS export's authoritative values:

| Value | Source of truth |
|---|---|
| `projectId` | `.projexlight/config.json` → `projectId` (identical to `.mcp.json` → `env.PROJECT_ID`) |
| `projectPath` | this project root, Unix form (e.g. `/c/Users/name/project`) |

Then apply exactly two rules:

**Rule 1 — same `projectPath`, different `projectId`.** Keep the row whose `projectId`
matches this export's `projectId`; that is the valid one, because its session token was
issued for this checkout. Delete the other rows for that path. If NO row matches this
export's projectId, do not guess — prefer the row with `tokenStatus: active` and the
furthest `expiresAt`, and confirm with the user before deleting anything.

**Rule 2 — the same `projectId` appearing on more than one row.** Keep the row whose
`projectPath` is the actual project root. Delete the rows pointing at stale or moved paths.

Delete a stale row with:

```bash
curl -X DELETE http://localhost:8766/api/projects/<STALE_PROJECT_ID>
```

Then confirm exactly one row remains for this path AND that it resolves:

```bash
curl http://localhost:8766/api/projects
curl "http://localhost:8766/api/context/current?projectPath=<PROJECT_PATH>"
```

`projectId` must come back non-null and equal to this export's projectId.

> ⚠️ **Never delete a row belonging to a different `projectPath`.** Other projects share this
> MCP server; removing their registration breaks their workflow. Only ever prune rows that
> collide with THIS project's path or THIS project's id.

After `setup-all.sh` completes AND the CLI host has been restarted / reloaded so the MCP server is registered, re-check your tool list.

If `projexlight_*` tools still do not appear, **diagnose the configuration with curl before escalating** — this is the repair lane described above:

```
curl http://localhost:8766/health                 # is the server even up?
curl http://localhost:8766/api/projects           # is THIS project registered?
curl http://localhost:8766/api/context/current    # does the path resolve to the right projectId?
```

Causes you can fix yourself, without the tools being loaded:
- **A duplicate or stale projectId registered for the same path** → context resolves to the wrong project, and the workflow would silently run against another project's credentials and task list. Confirm with the user which is correct, then unregister the stale one (`DELETE /api/projects/{id}`) or pin the right one (`POST /api/context/set`).
- **The CLI host has the MCP server disabled in its own settings** — e.g. Claude Code's `.claude/settings.local.json` listing `projexlight` under `disabledMcpjsonServers`. Move it to `enabledMcpjsonServers`. This is invisible from the server side, so check the host config, not just `docker ps`.
- **`.mcp.json` missing, or its `PROJECT_ID` not matching `.projexlight/config.json`** → correct it to the export's projectId.

Fix the configuration, then **ask the user to restart the CLI host** so the bridge loads. Only if the tools still fail to appear after that restart should you **STOP and ask the user to complete MCP registration manually**. Do not run the *workflow* over curl in the meantime.

### Step 3.5.c — Use the MCP tools for the workflow

Call tools by name directly (your CLI host handles the transport). Tool arguments like `sessionToken`, `projectId`, and `projectPath` are injected by the bridge — you do not pass them.

### Supported `projexlight_*` tools (74 total)

**Session & core workflow (7):**
`projexlight_init_session`, `projexlight_get_instruction`, `projexlight_get_next_task`, `projexlight_validate`, `projexlight_complete_task`, `projexlight_get_rules`, `projexlight_decision_tree`

**Quality & validation (12):**
`projexlight_set_variable_scope`, `projexlight_get_api_definition_rules`, `projexlight_get_ui_feature_rules`, `projexlight_review_api_definitions`, `projexlight_review_task_delta`, `projexlight_review_ui_features`, `projexlight_pre_commit_regression_check`, `projexlight_quality_gates`, `projexlight_get_template`, `projexlight_self_check`, `projexlight_submit_feature_validation`, `projexlight_validate_api_definition`

**Violations & test failures (6):**
`projexlight_get_pending_violations`, `projexlight_clear_violations`, `projexlight_get_pending_test_failures`, `projexlight_clear_test_failures`, `projexlight_mark_test_manual`, `projexlight_reset_failure_counts`

**Session context (2):**
`projexlight_set_context`, `projexlight_get_context`

**Imports (6):**
`projexlight_import_validate`, `projexlight_import_full`, `projexlight_import_epics`, `projexlight_import_features`, `projexlight_import_scenarios`, `projexlight_import_status`

**API testing (6):**
`projexlight_run_api_tests`, `projexlight_start_api_tests`, `projexlight_get_api_test_status`, `projexlight_cancel_api_tests`, `projexlight_clear_api_test_result`, `projexlight_check_server_health`

**API discovery & docs (4):**
`projexlight_get_sdk_api`, `projexlight_search_apis`, `projexlight_generate_api_docs`, `projexlight_delete_api_library_entries`

**Legacy extraction (5):**
`projexlight_legacy_detect_framework`, `projexlight_legacy_scan_routes`, `projexlight_legacy_extract_apis`, `projexlight_legacy_generate_definitions`, `projexlight_legacy_bootstrap`

**Defects (2):**
`projexlight_get_defect_context`, `projexlight_resolve_defect_for_qa`

**UI features (2):**
`projexlight_sync_feature_file`, `projexlight_get_ui_feature_backlog`

**Epic / feature / scenario / task CRUD (22):**
`projexlight_create_task`, `projexlight_get_tasks_by_feature`, `projexlight_implement`, `projexlight_get_epic`, `projexlight_get_feature`, `projexlight_get_scenario`, `projexlight_update_scenario_steps`, `projexlight_create_scenario`, `projexlight_get_task`, `projexlight_list_epics`, `projexlight_get_features_by_epic`, `projexlight_get_scenarios_by_feature`, `projexlight_get_tasks_by_feature_lookup`, `projexlight_get_tasks_by_scenario`, `projexlight_list_tasks`, `projexlight_create_tasks_bulk`, `projexlight_update_task`, `projexlight_delete_task`, `projexlight_update_scenario`, `projexlight_delete_scenario`, `projexlight_update_feature`, `projexlight_update_epic`

### Finding a task, then coding it
Two lookups cover every "work on task X" request — you never need to browse the UI or guess:
- **You do NOT have an id** (`"what is left in the backlog?"`, `"which api_endpoint tasks remain?"`) → `projexlight_list_tasks` with `status` and/or `task_type`. It is the ONLY generic task query; every other task lookup demands a featureId/scenarioId/taskId you must already know. Comma-separated values match ANY (`status="backlog,todo"`). Call it once with `includeCounts=true` to see which statuses and task types this project actually uses.
- **You DO have an id** (a UUID, or a short ID the user quoted like `TK-4135`) → `projexlight_get_instruction` with `taskId` set to exactly that — **both forms work, so pass it through as-is instead of hunting for the UUID first**. It returns the full implementation instruction: description, acceptance criteria, code templates, validation rules, quality gates, and any outstanding api-definition/violation gaps you must fix as part of the task. Use `projexlight_get_task` (also UUID-or-short-ID) only when you want the task's metadata WITHOUT the instruction.

So: `list_tasks` → pick an id → `get_instruction` → write code → `projexlight_validate` → `projexlight_complete_task`.

### Common curl → MCP tool replacements
| Instead of curl to... | Use MCP tool |
|---|---|
| `POST /api/instruction/init` | `projexlight_init_session` |
| `POST /api/instruction/get` | `projexlight_get_instruction` |
| `POST /api/instruction/validate` | `projexlight_validate` |
| `POST /api/instruction/complete` | `projexlight_complete_task` |
| `GET /api/instruction/rules` | `projexlight_get_rules` |
| `POST /api/test/start` | `projexlight_start_api_tests` |
| `GET /api/test/status` | `projexlight_get_api_test_status` |

### Why MCP tools are mandatory (not a preference)
- MCP tools inject `sessionToken`, `projectId`, and `projectPath` automatically — curl calls routinely drop or mistype these, which silently breaks the workflow
- Responses are structured JSON that your CLI can reason about; curl output is unparsed text
- The curl surface is not stable across releases; the MCP tool surface is

**The only curl calls in the entire session are Step 3's `/api/instruction/bootstrap` and the bridge-repair endpoints listed in Step 3.5 (`/health`, `/api/projects`, `/api/context/*`). Every *workflow* call MUST be an MCP tool. If you catch yourself about to curl a workflow endpoint, STOP and either use the mapped tool above or run Step 3.5.b to repair MCP setup — then restart the CLI host and use tool calls.**

---

## STEP 3.6: REFERENCE DOCUMENTATION AND TEMPLATES (READ BEFORE AUTHORING CONFIG)

This export ships **3,000+ lines of reference documentation** and a **canonical config
template**. Nothing else in this file points at them, so read this section before you write
any file under `tests/`.

### The docs — `mcp-server/docs/`

| File | Read it before |
|---|---|
| **`TEST_MCP.md`** | **writing `tests/config/test-config.json` or running ANY API test.** Owns the environment model, `baseUrl` vs `apiUrl`, how the runner resolves its target, and the report format |
| `SUT_SETUP_GUIDE.md` | making your app reachable from the MCP container (bind address, `host.docker.internal`, port detection) |
| `DEV_MCP.md` | header layering, variable resolution, pre-commit/pre-push gates |

### The template — `mcp-server/templates/test-config.json`

**COPY IT. Do not author `tests/config/test-config.json` from memory or from the MUST rules
alone.** The rules describe the *content* of that file; only the template carries its *shape*.

```bash
mkdir -p tests/config
cp mcp-server/templates/test-config.json tests/config/test-config.json
```

Then edit exactly three things:

1. `environments.development.apiUrl` — your **backend API** origin (e.g. `http://localhost:3001`)
2. `environments.development.baseUrl` — your **frontend UI** origin (e.g. `http://localhost:3020`)
3. `activeEnvironment` — normally `development`

### Four rules that are easy to get wrong

- **`baseUrl` and `apiUrl` are DIFFERENT.** `baseUrl` is the UI origin (used by `.feature`
  files and `@portal:`); `apiUrl` is the API origin (used by every api_definition). Setting
  both to the same port silently sends UI tests at the API, or API tests at the UI.
- **The environment keys are a FIXED SET: `development`, `staging`, `production`.** Renaming
  one to `local`, `dev` or `qa` means no environment resolves; the runner falls back to a
  default and — because it executes INSIDE a container — probes *itself*. The symptom is
  every api_definition returning **404 against the MCP's own port**, which reads as mass API
  failure but is one config error. If you see uniform 404s, check this first.
- **Write plain `localhost`.** The runner translates `localhost` → `host.docker.internal`
  automatically when running in Docker. Hand-writing `host.docker.internal` is unnecessary
  and breaks non-Docker runs.
- **The API test tools take NO url argument.** `projexlight_start_api_tests` /
  `projexlight_run_api_tests` resolve their target from THIS project's
  `tests/config/test-config.json`. That is what makes one shared MCP container serve many
  registered projects, each with its own URL. **Never** try to fix a wrong target by editing
  `mcp-server/*-compose.yml` or the container environment — those are shared across every
  registered project, and a change there breaks the others.

### Verify before running the suite

```
projexlight_check_server_health   → confirms config_loaded, active_environment, config_api_url
```

If `active_environment` is not the one you set, or `config_api_url` is not your API origin,
fix `test-config.json` **before** starting a run — otherwise every result is meaningless.

---

## STEP 4: FOLLOW EXECUTION_FLOW FROM RESPONSE

Execute each phase automatically. DO NOT ask for confirmation. Use MCP tools (not curl) for each step when available.

The response includes:
- **PROJECT_TYPE**: "legacy_extraction" or "new_development"
- **MCP_TOOLS**: Available tools for this project type
- **EXECUTION_FLOW**: Step-by-step workflow to follow
- **NEXT_STEP**: First action to take

---

## CRITICAL RULES

- Pass projectPath in bootstrap call to detect correct workflow
- Read framework-config.json to know language/framework
- **Use `projexlight_*` MCP tools for all workflow API calls after the initial bootstrap curl** — if the tools are not loaded in your CLI, follow `PROJEXLIGHT_SETUP.md` and Step 3.5.b to repair MCP. curl IS allowed for bridge diagnosis/repair (`/health`, `/api/projects`, `/api/context/*`), but never as a substitute for the workflow tools. After repairing, restart the CLI host and use tool calls from that session on
- Execute all steps automatically - DO NOT ask for confirmation
- Follow NEXT_STEP in each API response
- Validate before commit - only commit when validation.passed === true
- If any curl command fails, check MCP server: `docker ps | grep projexlight`

---

Project: 59fe608d... | Tasks: 16

## Notes

Instructions delivered via MCP server.
