# MedexRegAI: ProjexLight backlog v2.0 (UI workflows, all phases)

Source: PRD v2.0 (MRA-PRD-201..204), UI 2.0 screens. Stack (framework-config.json): Express + TypeScript API, React + TS + Tailwind UI, Jest, Playwright, PostgreSQL.
Status: CREATED in ProjexLight 2026-11-09 (11 epics, 50 features, 110 scenarios, 249 tasks). Source of truth for what was created: projexlight-backlog-v2.0.py (section D lists changes vs this plan).

## A. Research conclusions that shape the backlog

### A1. FDA APIs: what we can use directly
| Need | Source | API? | How we use it | Scales? |
|---|---|---|---|---|
| Predicate search (510(k) clearances) | openFDA `/device/510k.json` | Yes, REST JSON | Nightly bulk load into Postgres + live query for freshness | Yes, if we query our own copy. Direct API: 240 req/min, 120K/day with key (1K/day without); limit<=1000, skip<=25000 |
| Product codes, device class, regulation no. | openFDA `/device/classification.json` | Yes | Bulk load; lookup table | Yes |
| Recalls / enforcement | `/device/recall.json`, `/device/enforcement.json` | Yes | Predicate risk flags on draft | Yes |
| Adverse events (MAUDE) | `/device/event.json` | Yes | Counts per product code/predicate; large dataset, bulk only | Yes via bulk |
| UDI / GUDID | `/device/udi.json` (+ AccessGUDID API) | Yes | Device identity checks | Yes |
| Registration and listing | `/device/registrationlisting.json` | Yes | Manufacturer lookup | Yes |
| 510(k) summary text (predicate's indications, tech characteristics) | accessdata.fda.gov `cdrh_docs/pdfNN/Kxxxxxx.pdf` | **No API**: public PDFs | Fetch once, cache, parse, embed into RAG | Yes with polite fetch + cache (never re-fetch) |
| Recognized consensus standards | FDA RCSD | No API (downloadable) | Periodic import | Yes |
| **eSTAR filing** | CDRH Portal (CDRH) / ESG (CBER) | **No public submission API found** | We do NOT file (PRD rule). We produce the attachments and an **eSTAR XML data file**: eSTAR PDFs can import/export form data as XML (attachments excluded), which the consultant imports in Acrobat | n/a. Spike needed to confirm the XML schema per eSTAR version |

Decision: **Do not call openFDA from user requests.** An `fda-sync` job loads bulk data into Postgres (weekly/monthly cadence matching openFDA updates), with the live API used only for delta checks. That removes the rate limit from the scaling path. openFDA data is "as is" with lag; the UI must show the data date.

### A2. Local open-source RAG (no third-party model)
| Layer | Dev (Docker, CPU ok) | Prod (GPU) | Licence |
|---|---|---|---|
| LLM serving | **Ollama** container | **vLLM** (OpenAI-compatible API) | Apache-2.0 / MIT |
| Generation model | Qwen2.5-7B-Instruct (Q4) | Qwen2.5-14B/32B-Instruct or Llama-3.1-8B | Apache-2.0 (Qwen 7B/14B/32B); Llama community licence |
| Embeddings | bge-m3 or nomic-embed-text | same (via TEI or vLLM) | MIT / Apache-2.0 |
| Re-ranker | bge-reranker-v2-m3 | same | Apache-2.0 |
| Vector store | **pgvector** in existing Postgres | pgvector (HNSW); move to dedicated store only if >~50M chunks | PostgreSQL licence |
| Parsing / OCR | **Docling** worker (DOCX/XLSX/PPTX/PDF, tables, OCR) | same, horizontally scaled | MIT |
| Queue | BullMQ + Redis | same | MIT / BSD |

Design rules: one `LlmProvider` interface (Ollama in dev, vLLM in prod, swappable); every generated sentence must carry `[C:file_version#loc]` or `[R:record#passage]` or the citation gate drops it; client data never leaves our infrastructure. Risk: 7B models draft weaker than frontier models. Mitigation: an eval harness with gold sections, gating model upgrades. GPU hosting is a real cost (estimate only, check provider pricing).

### A3. Services (docker-compose, dev)
`web` (React) · `api` (Express) · `worker` (BullMQ jobs: sync, sort, contradiction, draft) · `ingest` (Python Docling sidecar, HTTP) · `ollama` · `postgres+pgvector` · `redis` · `minio` (S3-compatible file cache).

## B. Backlog structure

Task types use the ProjexLight guide: database, api_endpoint, api_integration, service_layer, backend, authentication, middleware, frontend, ui_component, form_handling, testing, integration_testing, devops, config_management, data_processing, documentation. Never "development".

Existing ProjexLight items (1 epic "User Authentication & Document Processing", 4 features, 16 tasks typed "development") are superseded by E0/E2/E3. See decision D1.

### E0 Platform foundation (Phase 0, wk 1-4)
- **F0.1 Firm workspace and auth**: S: consultant signs up and creates firm · S: owner invites a reviewer with role · S: login/logout/password reset · S: role blocks unauthorised action.
  T: [database] orgs, users, memberships, roles schema · [authentication] register/login/JWT refresh/reset · [middleware] RBAC guard · [api_endpoint] invites · [frontend] sign-in, sign-up, invite accept pages · [testing] auth unit + e2e.
- **F0.2 App shell and navigation**: S: nav shows only items enabled for current phase flag · S: project switcher (client > device > submission).
  T: [ui_component] app shell, left nav with phase feature flags · [database] clients, devices, submissions schema · [api_endpoint] CRUD clients/devices/submissions · [frontend] submission list + create form · [testing].
- **F0.3 Audit log**: S: every view/accept/reject/export recorded with who/when/what.
  T: [database] audit_events (append-only) · [middleware] audit interceptor · [ui_component] activity panel · [testing].
- **F0.4 Dev infrastructure**: S: `docker compose up` starts all services healthy.
  T: [devops] compose: postgres+pgvector, redis, minio, ollama, ingest · [config_management] env, secrets, model pull script · [devops] CI lint/test.

### E1 FDA data layer (Phase 0-1, thin checks used from Phase 2)
- **F1.1 openFDA client and sync**: S: nightly job loads 510k/classification/recall/udi deltas · S: rate limit (240/min) respected with backoff · S: UI shows data-as-of date.
  T: [api_integration] openFDA client (API key, retry, search_after paging) · [data_processing] bulk download loader · [database] fda_510k, fda_classification, fda_recall, fda_udi, fda_event_counts · [backend] sync job + schedule · [testing].
- **F1.2 510(k) summary documents**: S: summary PDF fetched once, cached, parsed, embedded · S: missing PDF marked "no summary on file".
  T: [api_integration] polite fetcher (cache in minio) · [data_processing] parse + chunk + embed · [testing].
- **F1.3 FDA lookup APIs**: S: K-number verify · S: product-code lookup · S: recall/MAUDE flags for a K-number.
  T: [api_endpoint] /fda/510k/:k, /fda/product-codes/:code, /fda/flags/:k · [testing].

### E7 Local RAG and AI services (Phase 0-2)
- **F7.1 LLM runtime abstraction**: S: same code runs on Ollama (dev) and vLLM (prod) · S: model unavailable gives a clear retryable error.
  T: [service_layer] LlmProvider + EmbeddingProvider interfaces, Ollama + OpenAI-compatible adapters · [config_management] model registry · [testing].
- **F7.2 Ingest and indexing**: S: DOCX/XLSX/PPTX/PDF/scan parsed with SourceLocation (page/sheet/cell/slide) · S: re-upload creates new file_version, old kept.
  T: [backend] Docling ingest sidecar (Python) + contract · [database] files, file_versions, chunks(vector), source_locations · [data_processing] chunker · [testing] fixture corpus.
- **F7.3 Retrieval with citations**: S: query returns ranked passages with locations · S: answer without citable passage refuses.
  T: [service_layer] hybrid search (pgvector + full-text) + rerank · [service_layer] citation gate v2 validator · [testing].
- **F7.4 Evaluation harness**: S: gold set scored for citation precision and section acceptance before model change.
  T: [testing] eval runner + gold fixtures (fictional) · [documentation] model card and limits.

### E2 Phase 1: Evidence (wk 3-12), UI 2.0 s4
- **F2.1 Connect client folder (4.1)**: S: connect Dropbox read-only via OAuth · S: Box / SharePoint-OneDrive / Google Drive · S: disconnect revokes token and stops sync · S: read-only scope shown in plain words.
  T: [database] connections, tokens (encrypted) · [api_integration] Dropbox, Box, MS Graph, Google Drive adapters · [backend] change-feed sync job · [api_endpoint] /connections · [frontend] Connect screen · [testing].
- **F2.2 Sorted folder and eSTAR map (4.2)**: S: files auto-sorted into eSTAR sections with confidence · S: consultant re-assigns a file (learned) · S: eSTAR coverage panel shows empty sections · S: getting-started checklist.
  T: [database] estar_sections ref data, file_assignments · [service_layer] classifier (rules + embeddings + LLM) · [api_endpoint] /submissions/:id/files, /assignments · [frontend] sorted-folder table + coverage + checklist · [testing].
- **F2.3 Problems: gaps and contradictions (4.3)**: S: contradiction detected (e.g. IFU shelf life vs ageing report) with both sources side by side · S: consultant resolves/dismisses with note · S: required evidence missing flagged.
  T: [database] facts, problems · [service_layer] fact extraction + contradiction engine · [api_endpoint] /problems · [frontend] problems list + side-by-side source viewer (PDF page / sheet cell) · [testing].
- **F2.4 Client requests and no-login upload (4.4)**: S: consultant creates request from gaps · S: client uploads via expiring link on phone, no login · S: link expiry / revoke · S: upload lands in correct section and re-runs checks.
  T: [database] client_requests, upload_links · [api_endpoint] /requests, public /u/:token · [middleware] signed-link auth + file-type/size/malware scan · [frontend] request composer · [frontend] mobile upload page · [testing].
- **F2.5 Trust pack (4.5)**: S: download validation pack + data-handling pack (PDF) · S: client clause text copy.
  T: [backend] pack generator (PDF) · [api_endpoint] /trust-pack · [frontend] trust-pack screen · [documentation] validation pack content.

### E3 Phase 2: Drafting (wk 11-20), UI 2.0 s5
- **F3.1 Review board (5.1)**: S: section status board (not started/drafting/in review/approved) · S: assign reviewer.
  T: [database] sections, section_status · [api_endpoint] /sections · [frontend] board · [testing].
- **F3.2 Draft with source citations (5.2)**: S: generate section draft; every statement cited · S: uncited statement removed and listed · S: export DOCX with citations as Word comments/bookmarks · S: re-import edited DOCX; human edits kept as human-approved.
  T: [service_layer] section drafter (RAG + templates per eSTAR section) · [backend] DOCX writer (comments/bookmarks) · [backend] DOCX round-trip diff · [api_endpoint] /sections/:id/draft, /export, /import · [frontend] draft review view · [testing].
- **F3.3 Revision impact (5.3)**: S: new client file version lists affected statements/sections.
  T: [service_layer] dependency graph statement->source · [api_endpoint] /impact · [frontend] impact list · [testing].
- **F3.4 Readiness, eSTAR XML and records (5.4)**: S: attachment checks (size <1 GB each, total <4 GB, naming) · S: export eSTAR XML data file for import into the eSTAR PDF · S: dated PDF/DOCX record for eQMS.
  T: [backend] **spike: eSTAR XML schema per version** · [backend] XML exporter · [service_layer] readiness checks · [backend] record generator · [frontend] readiness screen · [testing].
- **F3.5 FDA checks on draft**: S: predicate K-number verified, recall/MAUDE flags shown inline.
  T: [service_layer] draft checker using E1 · [ui_component] inline flag chips · [testing].

### E4 Phase 3: Pilot proof (wk 19-26), UI 2.0 s6
- **F4.1 Time log**: S: one-click start/stop per task category · S: weekly summary.
  T: [database] time_entries · [api_endpoint] /time · [ui_component] timer widget · [testing].
- **F4.2 Pilot report**: S: hours vs firm baseline, acceptance rate, exported as PDF.
  T: [service_layer] metrics · [api_endpoint] /pilot-report · [frontend] report + PDF · [testing].

### E5 Phase 4: Workspace (M7-12), UI 2.0 s7
- **F5.1 FDA letter tracker**: S: log AI/hold letter, deficiencies linked to sections, due dates.
  T: [database] fda_letters, deficiencies · [api_endpoint] · [frontend] tracker · [testing].
- **F5.2 Predicates and SE comparison**: S: search predicates (own Postgres copy) by product code/keywords/semantic · S: build SE table from subject + predicate summary with citations.
  T: [api_endpoint] /predicates/search · [service_layer] SE table builder · [frontend] predicate search + SE editor · [testing].
- **F5.3 Portfolio**: S: all submissions with status, risks, due dates.
  T: [api_endpoint] /portfolio · [frontend] portfolio dashboard · [testing].

### E6 Phase 5: Market (M13+, gated on pilot result), UI 2.0 s8
- **F6.1 Public product-code pages**: S: SEO page per product code from FDA data only.
  T: [frontend] SSR/static page · [api_endpoint] /public/product-codes/:code · [testing].
- **F6.2 Opt-in introductions**: S: manufacturer request routed only to opted-in consultants.
  T: [database] · [api_endpoint] · [frontend] · [testing].

### Size
8 epics · 28 features · ~75 scenarios · ~130 tasks. Build order: E0 -> E7 + E1 -> E2 -> E3 -> E4 -> E5 -> E6.

## C. Open decisions
- D1: Replace the existing generic epic/16 tasks (mark superseded) vs merge into E0/E2/E3. Recommended: merge, reuse its 4 features.
- D2: Create E5/E6 now (as backlog, gated) or only E0-E4. Recommended: create all, E6 marked gated.
- D3: Python ingest sidecar is a second language. Alternative: all-TS parsing (weaker on scans/tables). Recommended: Docling sidecar.

## D. As created in ProjexLight (2026-11-09)
Generator: `projexlight-backlog-v2.0.py` (run `python projexlight-backlog-v2.0.py <outdir>` to emit import.json + tasks.json). All tasks sit in sprint "Quick Prototype Sprint" with status backlog; task titles carry the feature id, e.g. `[F2.3] ...`.

Decisions taken:
- D1: existing EP-461 (4 features, 16 "development" tasks) left untouched; superseded by E0/E2/E3. Archive it when convenient.
- D2: all epics created; E6 and F5.4 marked GATED/CONDITIONAL.
- D3: Python Docling/LibreOffice sidecar, sandboxed with no network.
- Stack: Express + TypeScript API, React + TS UI (matches framework-config and scaffold). Architecture v2.0 §4 (FastAPI/Next.js) needs updating to match.
- AI: default is our own self-hosted models (Ollama dev/test, vLLM prod). Provider models (e.g. Claude API) can be enabled per route later; a firm can bring its own model with its own API key (F7.1). Architecture v2.0 §8 needs updating to match.

Changes vs sections A-C:
- Vertical slices: every user-facing feature has backend and frontend tasks against one OpenAPI contract, and its testing task includes a Playwright e2e through the UI. Infra-only: F0.4, F8.3.
- Frontend tasks link to their UI 2.0 screen (docs/Prd/v2.0/ui2.0/index.html §4.1-§8.2).
- New E8 Scale, performance and observability: RLS + cursor pagination + indexes + PgBouncer, queued idempotent jobs with SSE progress, presigned direct uploads, Redis cache (never client content) and per-org rate limits, OpenTelemetry, k6 budgets (500 files/60 min, 1 section/10 min), bundle budget.
- New E9 MedexRegAI admin console (operators): customers, cross-tenant users, plans/subscriptions/invoices, ops console, support grants. New E10 Firm and user settings: firm profile, users/roles/permission matrix, billing and invoices, security policies, personal settings, notifications.
- From UI 2.0: forward-email intake, version "which is current?" prompt, unreadable-files list, decision panel, request drafter with approval, data-use settings and project deletion, compare-versions actions, F3.6 firm templates/summary tables/admin documents, F4.3 usage export, F6.3 billing and API.
- From PRD/Architecture: F7.5 prompt-injection defence (NFR-16), sandboxed docproc and discard-after-process (ADR-010/016), drawings title block and raw-data profile (FR-14.4/14.5), PHI scan (NFR-9), citation gate v2 match rules, deterministic contradiction engine, SSO, hash-chained audit, device with nullable UDI-DI, A3 activity codes (FR-14.20), 124-char names and no ZIP (FR-14.15), eSTAR XML moved to F5.4 (Phase 4, ADR-017), F4.4 pen test and SOC 2 readiness (NFR-18), Terraform AWS, per-tenant KMS.
- Not included: v1.0 Phase 4 items (research library, claim-evidence matrix, submission record) and Lead Finder; add from the v1.0 PRD if wanted.
