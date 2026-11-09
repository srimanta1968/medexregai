# MedexRegAI: Final Analysis for the 510(k) Consulting Pilot
### Veeva RIM demo vs customer needs vs our business plan and requirements, and what is missing

**Status:** Final · 2026-10-08

**Inputs analysed**
- Veeva Vault RIM Suite end-to-end demo: 40 screens in `screens/` and `transcript.txt` (see `README.md`)
- Customer pilot scope: six areas for an FDA 510(k) consulting practice, with a 50% target for reducing effort
- `docs/businessPlan/MedexRegAI-BusinessPlan-PreSeed-v6.html` (MRA-BIZ-001 r6, 2026-08-30)
- `docs/MedexRegAI-Requirements.docx` (17 Aug) and `docs/MedexRegAI-Requirements.html` (30 Aug), both MRA-REQ-001 r0.2. They carry the same 80 FR/NFR IDs and priorities. The differences are listed in §6.5

**Where to look**
- §1 bottom line
- §2–4 demo mapping
- §5 scope decision
- **§6 gap register: what is missing**
- §7–9 pilot plan
- §10 changes to the plan
- §11 questions for the customer

---

## 1. Bottom line

1. **The Veeva demo answers a different problem from the customer's.** The demo is a **pharma** RIM system (Enalapril tablets, eCTD, MAA, decentralised procedure, xEVMPD/IDMP). It runs one post-approval change across 48 registrations in many countries. Most of it starts *after* a product is approved. A 510(k) consultancy works on **one FDA market, mostly pre-market**, and its biggest cost is research done **before** anything is written. Copying Veeva wholesale would mean building the expensive part and skipping the part that saves the hours.
2. **The two most time-consuming activities on the customer's list do not appear in the Veeva demo at all.** These are finding and evaluating predicates, and organising FDA research and evidence. Veeva has no predicate intelligence. These two areas are also **the core of our business plan** (PR-2 Predicate & Comparative Study, FR-3.x, FR-10.2 citations, snapshots). They are where the 50% saving can realistically come from, and building them for this customer is the same work as building the platform.
3. **The other four pilot areas match Veeva's patterns, but our own plan scopes them out or defers them.** These are the content plan, traceability, FDA questions and versions, and the audit record. Our plan says we are *not* a document control system or system of record (REQ §2). It defers eSTAR drafting past the Series A and puts the content checklist in Release 2. **This is the main decision to make** (§5). The full gap list is in §6.
4. **Recommendation:** run a 6-month, low-cost pilot built as **two releases of intelligence (Predicate, Research) and one release of lightweight workflow registers (Content plan, Traceability, FDA interactions, Submission record)**. Keep documents in the customer's own storage. Stop or continue at a measured gate in week 12.

---

## 2. Translating the Veeva demo into 510(k) terms

The table below goes through each demo capability and asks what the 510(k) equivalent is and whether the pilot needs it.

| Veeva demo capability (screens) | 510(k) consulting equivalent | Pilot? |
|---|---|---|
| Product Overview dashboard: registrations by country, sites, shelf life, storage (`002`–`009`) | **Client/project portfolio dashboard**: each 510(k) by stage, FDA review clock, AI-hold days left, open deficiencies. Country breakdown is irrelevant for a single FDA market | Yes, simple |
| Change Event + **Impact Assessment** across 48 registrations (`011`–`014`) | **510(k) change assessment** for a cleared device (letter-to-file vs new 510(k)), plus: "which claims, tests and documents does this design change touch?" | Later (BP puts this at M16–22) |
| Local disposition by country affiliates (`015`) | Not applicable (single regulator) | No |
| **Submission content plan**: eCTD tree, owners, due dates, status (`016`, `023`) | **eSTAR section plan and checklist**: device description, IFU, SE comparison, labeling, biocompatibility, sterilization, shelf life, software, EMC/electrical, performance testing… with owner, status and evidence links | **Yes, core** |
| Project dashboards: status by module and owner (`017`–`019`) | Readiness by eSTAR section and by owner (consultant vs client engineer vs test lab) | Yes |
| **Continuous publishing & validation**: errors by severity, missing documents (`020`–`022`) | **Pre-submission completeness / gap check**: a missing section, test report or justification is caught *before* FDA technical screening or an AI request | **Yes, high value** |
| Collaborative authoring in MS Word (`023`–`024`) | Use the customer's existing SharePoint / Google Drive / Word | No, don't build |
| Viewer + eCTD XML backbone (`025`–`026`) | Not needed; eSTAR is a PDF form | No |
| **Submit to Gateway** (`027`) | Customer uploads through the CDRH Portal. We **record** what went in, when, and its hash | Record only |
| Dispatch / on-time dashboard (`028`–`030`) | Submission timeline: target date vs actual, FDA review days vs hold days | Yes, simple |
| **HA Question ingestion by "RIMbot"** + **related past questions** (`031`–`032`) | **FDA AI request / deficiency tracker**: ingest the AI letter, split it into individual deficiencies, tag each by eSTAR section and topic, and retrieve similar deficiencies **from the firm's own past projects** (FDA does not publish AI letters, so a consultancy's history is the asset) | **Yes, core** |
| Regulatory Objective → approval → **bulk registration update wizard** (`033`–`036`) | Record the clearance: K-number, decision date, cleared IFU, any final product-code change. No bulk wizard needed | Minimal |
| Updated dashboard after approval (`037`–`038`) | Project closed and portfolio updated | Free with dashboard |
| **Active Dossier Viewer**: current version of each document per market (`039`) | **Submission record**: which version of each document went in the original submission, each AI response and each resubmission | **Yes, core** |

---

## 3. Customer pilot areas × Veeva demo × our business plan

| # | Customer pilot area | In Veeva demo? | Covered by our business plan / requirements? | Gap to close for the pilot |
|---|---|---|---|---|
| 1 | **Finding and evaluating predicate devices** | **No** | **Yes, fully.** PR-2 Predicate & Comparative Study (ships M6); FR-3.1 ranked predicates; FR-3.2 IFU and tech-characteristics side-by-side; FR-3.3 recall screening; FR-3.4 lineage; FR-3.7 saved predicate set with rationale | None in scope. Narrow the corpus to the customer's product codes to cut cost |
| 2 | **Organising FDA research, public summaries, evidence** | **No** (Veeva only manages the firm's own documents) | **Mostly.** FR-1.3 accept client documents (Should); FR-4.1/4.5 standards and device-specific guidance; FR-10.2 inline citations; FR-10.4/NFR-6 snapshot reproducibility; FR-6.x MAUDE/recalls | Make it a **project research library** that also holds the customer's private evidence, not only generated reports |
| 3 | **510(k)/eSTAR content plan and document checklist** | **Yes** (`016`–`022`) | **Partially, and later.** FR-5.1 content checklist and FR-5.2 status + evidence are **Release 2**. FR-5.3 gap analysis (Should, R2). eSTAR drafting is **deferred post-Series A** (BP §11 trade-off; REQ Q6) | Pull FR-5.1–5.3 forward into the pilot. Build an eSTAR **section plan**, not eSTAR form filling |
| 4 | **Linking claims, evidence, test reports, documents** | **Partially** (content-plan leaf ↔ matched document) | **Weak.** FR-3.2 flags differences that raise new questions. PR-6 traceability matrix (requirement → risk → verification) is at **M22–28** | **New**: a claim → SE difference → evidence → test report → eSTAR section matrix. This is the differentiator over Veeva |
| 5 | **Document versions, FDA questions, changes, resubmissions** | **Yes** (`031`–`032` HAQ + reuse; archive versions) | **Not covered.** BP and REQ explicitly exclude "document control system" and "system of record". Change assessment is M16–22 | **New**: an AI-request/deficiency register and a version **register** (references + hashes to files held elsewhere) |
| 6 | **Auditable record: what was submitted, what FDA asked, what changed** | **Yes** (`025`–`026`, `039`) | **Partially.** FR-11.3 audit trail and FR-10.4 immutable versioned reports cover *our analyses*, not the *submission package* | Extend the audit model to submission events: submitted → FDA asked → responded → cleared |

**What this means:** areas 1–2 are where the plan is strongest and Veeva has nothing. Areas 3–6 are where Veeva is strongest and the plan is thin or excludes them on purpose. The customer is asking for both halves.

---

## 4. Which business-plan items the Veeva demo covers

### 4a. Plan items that appear in the demo (Veeva already does a version of them)
| Business plan / requirements item | Where in the demo | How close |
|---|---|---|
| FR-5.1 / FR-5.2 submission content checklist with status and evidence | Content plan `016`, `023` | Close; Veeva's is richer (owners, due dates) |
| FR-5.3 gap analysis / FR-5.5 readiness as evidence coverage | Validation tiles `020`–`022` | Different basis: Veeva checks technical validity; ours checks against **precedent** (what comparable clearances included) |
| 510(k) change assessment (BP §16 M3, M16–22; RegDesk gap) | Event + impact assessment `011`–`014` | The pattern carries over: "what does this change touch?" |
| Registration change intelligence (BP §16, reshaped, M16–22) | Product Overview dashboards `002`–`009` | The BP **deliberately** does not do registration management. The demo is exactly what we said we would not build |
| FR-11.1 roles / FR-11.4 reviewer approval | Deliverable owners `017`–`019` | Close |
| FR-11.3 audit trail / FR-10.4 immutable versions | Archive, viewer `025`–`026`, Active Dossier `039` | Ours covers analyses only; theirs covers submissions |
| FR-11.5 / FR-6.5 change notifications and alerts | Dashboards as the morning check | Weak; Veeva shows it on dashboards, we push alerts |
| FR-1.5 device variants | Pack sizes and variants `006`–`008` | Comparable |
| FR-8.2 manufacturing/supplier footprint (and the OEM Exchange idea) | Approved DS/DP manufacturers and site roles `005` | Same data shape: site + role + market |
| FR-4.3 shelf-life / sterilization testing in the test plan | The whole storyline is a shelf-life extension | Topic overlap only |

### 4b. Plan items the demo does **not** have (our differentiation)
PR-1 pathway determination and product-code ranking (FR-2.x) · **PR-2 predicate ranking, IFU diff, recall screening, lineage (FR-3.x)** · PR-3 standards list and precedent-derived test plan (FR-4.x) · PR-4 MDUFA-based cost/timeline with confidence intervals (FR-7.x) · PR-5 competitive landscape · FR-6 MAUDE/recall design inputs · **citation verification as a hard gate, immutable snapshots, published accuracy** · flat per-deliverable pricing, free seats, Determination Guarantee · Lead Finder · OEM Exchange and Device Marketplace.

### 4c. Demo capabilities our plan **explicitly excludes**
Filing / Gateway submission ("we never submit to a regulator") · collaborative authoring and document control ("not a document control system") · eQMS / system of record · registration management and the bulk registration wizard ("deliberately not registration management") · eCTD publishing · multi-country local disposition.

---

## 5. The decision this pilot forces: scope boundary

Pilot areas 5 and 6, and part of 3, push us toward the system of record that MRA-REQ-001 §2 and the BP rule out. The three options:

| Option | What it means | Pros | Cons |
|---|---|---|---|
| A. Hold the line | Pilot covers areas 1–2 (and 3 as a checklist only) | Stays inside the plan; least build | Customer's 50% target unlikely: the AI-response and rework hours stay manual |
| **B. Registers, not repositories (recommended)** | Areas 3–6 built as **lightweight registers**: we store links, hashes, statuses, deficiencies and relationships. Files stay in the customer's SharePoint/Drive. No check-in/out, e-signatures, Part 11 validation or eSTAR filling | Delivers the customer's six areas; becomes the BP's **consultant workspace** (FR-11.2, M-3) and fills the eSTAR/checklist gap cheaply | Some scope creep; needs a short BP/REQ amendment |
| C. Build a Veeva-lite RIM | Full document management + workflow | Closest to the demo | Months of build, validation burden, and a direct fight with Rimsys/Veeva/Greenlight Guru, which the BP explicitly avoids |

**Recommendation: option B.** It is cheaper than C and meets the customer's needs, which A does not. It also strengthens the plan: an AI-deficiency history and a claim-to-evidence matrix are exactly what a consultancy will pay a retainer for, and they feed FR-5.3 (predicting AI requests from precedent).

---

## 6. Gap register: what is missing from our business plan and requirements

Each gap is checked against both requirements files and BP r6. Proposed IDs use a new **FR-13 "Submission Workspace"** group so the existing numbering is untouched.

### 6.1 Missing entirely: new requirements needed for the pilot

| Gap | What is missing | Evidence it's missing | Seen in Veeva demo | Proposed requirement | Pilot area | Priority |
|---|---|---|---|---|---|---|
| G-1 | **eSTAR section plan** with owner, due date, status per section | FR-5.1/5.2 give a generic checklist and status only. No owners or dates, no eSTAR structure. REQ Q6 defers eSTAR output | `016`–`019` | FR-13.1 eSTAR-aligned content plan with owner, due/actual dates and status per section, versioned against the FDA eSTAR template version | 3 | Must |
| G-2 | **Claim–evidence traceability matrix** | Nothing in REQ. BP has a traceability matrix only inside PR-6 (M22–28, Series A) | Partial (`016` leaf ↔ document) | FR-13.2 Link each IFU/labeling claim and each SE difference (from FR-3.2) to evidence items, test reports and eSTAR sections; report unsupported claims and orphan evidence | 4 | Must |
| G-3 | **Client evidence as first-class items** (test reports, protocols, risk files) with metadata | FR-1.3 only "incorporates content into the profile" (Should) | `016`, `039` | FR-13.3 Register client evidence items (type, standard, version, date, lab, result) and extract key fields from test reports | 2, 4 | Must |
| G-4 | **FDA interaction register**: AI letters, deficiencies, Pre-Sub/Q-Sub feedback, responses, AI-hold clock | Not in REQ or BP. No FR covers regulator correspondence | `031` | FR-13.4 Ingest FDA correspondence (upload or forwarded email), split it into deficiencies, tag by eSTAR section/topic, link to response and evidence, and track the 180-day AI-hold deadline | 5 | Must |
| G-5 | **Reuse of past deficiencies and responses** across the firm's projects | Not in REQ. AI letters are not public, so the FDA corpus cannot supply this | `032` | FR-13.5 Search similar past deficiencies and responses **within the tenant only** (consistent with NFR-8); never across customers | 5 | Should |
| G-6 | **Document version register** for externally stored files | REQ excludes document control. No requirement to track versions of client files | `025`–`026`, `039` | FR-13.6 Record each document version as link + hash + author + date. No storage, check-in/out or e-signature | 5, 6 | Must |
| G-7 | **Submission record / timeline** | FR-11.3 audits *analyses*; FR-10.4 makes *reports* immutable. Nothing records submissions | `027`, `039` | FR-13.7 Immutable event log per 510(k): package submitted (file list + hashes), technical-screening outcome, AI request, response, resubmission, decision (K-number, date) | 6 | Must |
| G-8 | **Portfolio dashboard across projects and clients** | No FR. FR-11 covers access, not oversight | `002`–`009`, `028`–`030` | FR-13.8 Dashboard by stage, FDA review/hold clock, open deficiencies, readiness % per project and client | All | Should |
| G-9 | **Task ownership and due-date reminders** | FR-11.5 notifies on *data* changes only | `017`–`019` | FR-13.9 Assign owners to sections, deficiencies and evidence; remind on due dates | 3, 5 | Should |
| G-10 | **510(k) change assessment** (letter-to-file vs new 510(k)) for cleared devices | Only a roadmap line in the **HTML** REQ (§14 phase M2) and BP §16 M3 (M16–22). **No FR, and absent from the .docx** | `011`–`014` | FR-13.10 Given a design/labeling change, assess impact on cleared claims and evidence (21 CFR 807.81(a)(3)) | Post-pilot | Could (pilot) |

### 6.2 Exists but scheduled too late for the pilot (re-prioritise)

| Requirement | Today | Needed for pilot | Why |
|---|---|---|---|
| FR-5.1 submission content checklist | Must · **R2** | R1 | Core of pilot area 3 |
| FR-5.2 checklist status + evidence | Must · **R2** | R1 | Same |
| FR-5.3 gap analysis vs precedent (AI-request risk) | Should · **R2** | Must · R1 | Our answer to Veeva's continuous validation (`020`–`022`); largest rework saving |
| FR-11.2 multi-client isolated workspaces | Must · **R2** | R1 | The customer is a consultancy; BP mechanic M-3 depends on it |
| FR-11.4 comment/approve, reviewed-by record | Should · **R2** | R1 | Senior RA sign-off is part of the consultancy's process |
| FR-1.3 accept client documents | **Should** · R1 | Must · R1 | Evidence library and traceability need it |
| FR-3.7 save predicate set with rationale | **Should** · R1 | Must · R1 | Predicate decisions must be auditable (area 6) |
| Storage integration: Google Drive / SharePoint | **R3** | R1 | Option B (registers, not repositories) depends on linking to where files already live |
| FR-11.5 change notifications (predicate recalled, standard lapses) | Should · R2 | Keep R2 | Useful but not needed to prove the 50% target |

### 6.3 Exists, but the scope must be widened

| Requirement | Current scope | Widen to |
|---|---|---|
| FR-11.3 audit trail | Who ran which *analysis*, against which snapshot | Also submission events, deficiency handling and evidence version changes (feeds G-7) |
| FR-10.4 immutable versioned reports | Our generated *reports* | Also a frozen "as-submitted" package manifest |
| FR-3.2 IFU / tech-characteristics comparison | On-screen comparison | Exportable **SE comparison table in eSTAR layout**, with each difference becoming a traceability row (G-2) |
| FR-10.3 export PDF/DOCX/HTML | Reports | Also checklist, traceability matrix, deficiency/response log and submission record |
| REQ Integrations: eQMS/PLM connectors (R3) | Push gap items to Greenlight Guru, Jira | Add reading document references *from* the eQMS (many consultancy clients keep the DHF there) |

### 6.4 Business plan gaps (MRA-BIZ-001 r6)

| Gap | Where in BP | What to add |
|---|---|---|
| No product line for **submission management** | §3 catalogue (PR-1…PR-6) | Either a "Submission Workspace" included in the $500/mo retainer (recommended, as it justifies the retainer between projects) or a PR-7 "Submission Readiness & AI Response" project |
| Feature matrix has no rows for AI-request management, submission record, traceability | §10 Block A | Add the three rows. Competitors with them: RegDesk, Rimsys, Veeva, Greenlight Guru (partial). Our angle: precedent-driven gap prediction plus deficiency reuse |
| "Not a filing … never submit" and REQ "not a document control system" | §3 "What a project is not"; REQ §2 | Keep both. Add "**register of submission artefacts, not a document control system**" so the boundary is explicit |
| eSTAR drafting deferred post-Series A | §10 gaps, §13 re-sequencing | The pilot's eSTAR *section plan + gap check* closes most of the visible gap without the 8 weeks of form-drafting work |
| No design-partner / paid-pilot revenue line | §13 milestones, §15 model | Add the pilot as Phase 1 "signed design partner" evidence, with pilot fee terms if any |
| Lead Finder triggers are pre-market only until M22–26 | §7 | AI-request deficiencies are a natural "needs expert help" trigger. Note as a future opt-in trigger, with the same guardrail (no revenue signal into analysis) |

### 6.5 Inconsistencies between our own documents (fix before sharing with the customer)

| Issue | Detail | Fix |
|---|---|---|
| Requirements .docx is stale | `.docx` (17 Aug) lacks the US-adjacency roadmap row (change assessment, AI/ML PCCP, eSTAR drafting, non-US applicants) present in the `.html` (30 Aug) | Regenerate the .docx from the HTML |
| eSTAR wording differs | .docx: "generating eSTAR packages for direct submission in Release 1" out of scope. .html: "eSTAR drafting arrives Phase 3 (month 15)" | BP r6 now defers it **post-Series A**. Align all three |
| Billing model mismatch | REQ Integrations: "subscription tiers with usage metering". BP r6: $500/mo retainer + per-project credits, free seats | Update REQ to the credit ledger / retainer model (BP §13 already costs it at +3 weeks) |
| API timing | REQ: public REST API R2. BP r6: API + MCP at M15 as a $2,000/mo add-on | Align release and pricing |

### 6.6 Veeva capabilities we should deliberately **not** add (confirmed exclusions)
Gateway / CDRH Portal submission · collaborative authoring and check-in/out · eCTD/XML publishing and viewer · registration management and bulk registration wizard · multi-country local disposition · xEVMPD/IDMP · full document control / Part 11 e-signatures. Each one is either pharma-specific, outside the BP scope boundary, or already handled by the customer's existing tools.

---

## 7. Proposed pilot scope (3–6 months, low investment)

| Module | Customer area | What it does | Business plan link | Effort |
|---|---|---|---|---|
| **P1 Predicate Finder & Evaluator** | 1 | Search by device description → ranked predicates from 510(k) summaries; IFU and tech-characteristics side-by-side; recall/withdrawal flags; save a predicate set with rationale; export comparison table | PR-2, FR-3.1–3.3, FR-3.7 (→Must), FR-3.2 export | M |
| **P2 Research & Evidence Library** | 2 | Per-project library of FDA records (summaries, guidance, standards, recalls) and client evidence; every item cited and snapshot-dated; tagging by topic and eSTAR section | FR-1.3 (→Must), FR-4.1, 4.5, 10.2, NFR-5; **G-3**; Drive/SharePoint (R3→R1) | M |
| **P3 eSTAR Content Plan & Gap Check** | 3 | eSTAR section template per device type; owner, due date, status; evidence links; **gap check** against comparable cleared submissions (Veeva's continuous validation, rebuilt for 510(k)) | FR-5.1–5.3 (R2→R1); **G-1**, **G-9** | M |
| **P4 Claim–Evidence Matrix** | 4 | Each claim / SE difference → supporting evidence → test report → eSTAR section; shows unsupported claims and orphan reports | **G-2** (early slice of PR-6 traceability) | S–M |
| **P5 FDA Interaction Tracker** | 5 | Paste or forward an AI letter → split into deficiencies → tag by section → link to response and new evidence → **find similar past deficiencies from the firm's history**; 180-day AI-hold clock; version register for resubmissions | **G-4**, **G-5**, **G-6** | M |
| **P6 Submission Record** | 6 | Immutable timeline per 510(k): package submitted (file list + hashes), FDA requests, responses, changes, decision. Exportable for audits and client hand-over | **G-7**; FR-11.3 / FR-10.4 widened | S |
| Portfolio dashboard | All | Projects by stage, review clock, open deficiencies, readiness % | **G-8**; FR-11.2, 11.4 (R2→R1) | S |

**What keeps the investment low**
- **Narrow corpus**: ingest 510(k) summaries only for the product codes the customer actually works in (dozens of codes, not ~6,000). This also retires the BP's top technical risk (extraction quality) on a small, measurable set.
- **No document storage**: link to SharePoint/Drive; we store metadata and hashes.
- **No eSTAR form filling and no submission.** The customer uploads to the CDRH Portal; we record what they uploaded.
- **One customer, one deployment** at first, but with client-workspace isolation (FR-11.2) from day one, since the consultancy must keep its clients apart.
- **Customer's RA staff as the evaluation panel**, which also produces the BP's design-partner evidence.
- **Skip from the Veeva demo:** collaborative authoring, XML viewer, gateway, bulk registration wizard, country disposition.

**Indicative team:** ~2 engineers (full-stack + data/AI) plus a fractional RA expert and part-time product lead, for about 6 months. This is an estimate to refine once the baseline in §8 is known.

---

## 8. Proving the 50% reduction

The 50% target is credible **only if it is measured against a baseline and limited to the activities in scope.** Expert judgement, test-lab coordination and FDA review time are not reducible by software. For reference, the BP cites 40–120 consultant research hours per filing, and a competitor (Complizen) publishes a 30–60% workload reduction. Our 50% is at the upper end of that range.

**Weeks 0–2: baseline.** Reconstruct hours by activity from timesheets on 2–3 recently completed 510(k)s:

| Activity | Baseline hrs (measure) | Pilot hrs (measure) | Target |
|---|---|---|---|
| Product-code and predicate search, shortlist, SE comparison table | ? | ? | ≥ 60% less |
| Collecting FDA research (summaries, guidance, standards, recalls) | ? | ? | ≥ 60% less |
| Building and maintaining the eSTAR checklist / document tracker | ? | ? | ≥ 50% less |
| Cross-checking claims vs evidence before submission | ? | ? | ≥ 40% less |
| AI-letter triage and assembling the response package | ? | ? | ≥ 40% less |
| Reconstructing "what did we submit / what changed" for audits and client hand-over | ? | ? | ≥ 70% less |
| **Total of scoped activities** | ? | ? | **≥ 50% less** |

**Quality metrics, so speed isn't bought with errors:** number of AI-request deficiencies per submission, technical-screening holds, predicates rejected late, missing items found after submission.

**Gates**
- **Week 12 (after P1–P2 on a live project):** predicate + research hours ≥ 50% lower and the customer's RA lead accepts the outputs. If not, stop or re-scope before building P3–P6.
- **Week 24–26:** total scoped-activity hours ≥ 50% lower on ≥ 2 live 510(k)s, with no rise in AI deficiencies. Then go/no-go on commercial terms.

---

## 9. Timeline

| Weeks | Release | Content |
|---|---|---|
| 0–2 | Discovery | Baseline time study; select 2 live pilot 510(k)s; list product codes; eSTAR section template |
| 3–8 | **A: Research** | P1 Predicate Finder, P2 Research Library (narrow corpus) |
| 9–12 | Measure A | Use on a live project → **week-12 gate**. Meanwhile, design B and C (eSTAR template, data model for G-1…G-9) without building them |
| 13–18 | **B: Plan** (only if gate passed) | P3 eSTAR content plan + gap check, P4 claim–evidence matrix, portfolio dashboard |
| 17–22 | **C: Record** | P5 FDA interaction tracker, P6 submission record |
| 23–26 | Measure & decide | Compare to baseline; customer go/no-go; feed results into BP r7 |

---

## 10. What this changes in our business plan if the pilot succeeds

- **Pull forward** FR-5.1–5.3 (content checklist and gap audit) from R2 into the M6 baseline. This partly closes the "eSTAR-aware drafting" gap the BP lists as our largest against Complizen and Cruxi, without building form filling.
- **Add** an AI-deficiency register and claim–evidence matrix to the consultant workspace (FR-11.2) as retainer-justifying features. They support the BP's argument that the platform sits in the consultancy's cost of delivery (M-3).
- **Amend** REQ §2 out-of-scope wording from "not a document control system" to "a register of submission artefacts, not a document control system", so the boundary is explicit rather than eroded.
- **Use** the pilot as the "signed design partner" and "extraction proven" milestones in BP Phase 1.
- **Add** FR-13 "Submission Workspace" (G-1…G-10) to MRA-REQ-001. Apply the re-prioritisations in §6.2 and the scope widenings in §6.3.
- **Fix now, whatever the pilot outcome:** the document inconsistencies in §6.5. Regenerate the stale .docx, align eSTAR timing, and move REQ billing to the BP r6 retainer + credit model.

## 11. Questions for the customer
1. Which product codes / device types make up most of their 510(k) work?
2. Where do their documents live today (SharePoint, Drive, eQMS such as Greenlight Guru)?
3. Can they share timesheets or activity estimates from 2–3 past 510(k)s for the baseline?
4. Can they share past AI letters and responses (anonymised) to seed the deficiency history?
5. Do they need multi-client separation from day one?
6. Who is the RA lead who will accept or reject outputs at the week-12 gate?
