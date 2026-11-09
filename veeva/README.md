# Veeva Vault RIM Suite – End-to-End Demo (Screen Capture & Walkthrough)

**Source:** https://www.veeva.com/resources/veeva-rim-suite-end-to-end-demo/ (Wistia video `n00cu0xq2j`, 9m 24s, 1080p)

**What's in this folder**

| File | Contents |
|---|---|
| `screens/NNN_MMmSSs.jpg` | 40 distinct screens captured from the video, named by order and timestamp |
| `transcript.txt` | Narration with timestamps |
| `captions.en.vtt` | Original English captions |
| `veeva-rim-suite-end-to-end-demo.mp4` | The full video |

---

## TL;DR – what the demo shows

The demo follows one regulatory affairs user through the **full lifecycle of a post-approval CMC change**: a **shelf-life extension of Enalapril tablets from 12 to 24 months**, run across ~48 registrations in many EU/global markets, entirely inside **Veeva Vault RIM**. Along the way it touches every module of the RIM Suite:

| RIM Suite module | Where it appears in the story |
|---|---|
| **Registrations** (product/registration master data) | Product Overview dashboard, impact assessment, registration update wizard |
| **Submissions** (content planning & authoring) | Submission content plan, deliverable-owner dashboards, collaborative authoring in MS Word |
| **Submissions Publishing** | Continuous publishing & validation, eCTD XML backbone viewer, Gateway dispatch |
| **Submissions Archive** | Published PDFs, Active Dossier Viewer |
| **HA Interactions** (Health Authority Questions/Commitments) | Email ingestion via "RIMbot", related-question lookup |

The same dashboard opens and closes the demo: at the start it shows a 12-month shelf life; at the end the newly approved **24-month** shelf life appears, showing the data stays consistent from start to finish.

### End-to-end flow

```
Product Overview dashboard ─► Change Event (planning) ─► Impact Assessment (48 registrations)
      ▲                                                          │
      │                                                          ▼
Updated dashboard  ◄─ Registration wizard (bulk)   Country Activities + Local Disposition
& Active Dossier        ▲                                        │
                        │                                        ▼
               HA Approval ◄─ HA Questions (RIMbot) ◄─ Submit via Gateway ◄─ Content Plan
                                                       ▲                      + Authoring
                                                       └─ Continuous publishing & validation
```

---

## Detailed walkthrough (by screen)

### 1. Morning check – Product Overview dashboard (00:00 – 02:05)
Reports › Dashboards › **Product Overview**, filtered to product family *Vevasumab*.

| Screen | What you see |
|---|---|
| `001_00m00s` | Title card |
| `002_00m05s` | **Registrations and Marketing Status** – a bar per country, colored Marketed / Not Marketed / Withdrawn. Below it: Approved DS Manufacturers, Approved DP Manufacturers, Approved Site Roles |
| `003_00m32s` – `004_00m34s` | Clicking the legend removes "Not Marketed" and the dashboard updates live |
| `005_00m43s` | Supply chain detail. **DS manufacturers** (VeevaPharm Allentown, Cork) and **DP manufacturers** (Barcelona, Brussels, Vertex Pleasanton) broken down by country, plus **site roles** (batch release, active substance manufacture, primary/secondary packaging, QC testing…) |
| `006_01m28s` – `008_01m41s` | **Approved Pack Sizes**, **Approved Shelf Life** (12 vs 24 months by market), **Approved Storage Conditions** (protect from light, refrigerate 2–8 °C) |
| `009_01m48s` | Outstanding work: **HA Questions** by department (Clinical, QA, Safety; open vs ongoing), **Commitments**, and **On-going Regulatory Activities** per application (BLA, EMEA/H/C, JP, NDS, PL, UK…) |

### 2. Plan the change – Event & Impact Assessment (02:05 – 03:00)
| Screen | What you see |
|---|---|
| `010_02m12s` | Drill-down report: **Global Events and Submission Status by Product Family** (activities per application, lifecycle state, impacted market, local disposition, planned dates) |
| `011_02m18s` | **Manufacturing Event: Enalapril – DP Shelf Life Extension (24 months)**. Lifecycle: *Planned → Impact Assessment Complete → In Progress → Closed*. Fields include regulatory risk assessment (Low), justification, planned dates, global content plan, labeling impact, change control number. The left nav lists event products, packaging, shelf life & storage, site roles and more |
| `012_02m33s` – `013_02m36s` | **Impact Assessment Report Options**, for example *Packaging Across Registered Details*, *Shelf Life Across Registered Details*, *Manufacturers*, *Clinical*, *Labeling*, *Ingredients* |
| `014_02m38s` | Impact assessment result: **48 registrations** across Australia, Belgium, Denmark… with product, variant, application and packaging |

### 3. Local disposition by affiliates (03:00 – 03:25)
| Screen | What you see |
|---|---|
| `015_02m58s` | Event › **Activities** – one per country (AU, CH, DE, ES, FR, NL) with **Local Disposition** (e.g., "Prior approval required", "No action") supplied by local affiliates, plus related application/submission and planned submission date |

### 4. Build the submission – Content Plan & Project Management (03:25 – 05:00)
| Screen | What you see |
|---|---|
| `016_03m28s` | **Submission Content Plan** for `ES/H/5743/001-002/DC – 0007 – DP Shelf Life Extension`. The eCTD tree (Module 1 regional, 1.0 cover letter, 1.2 application form, 1.3 product info…) with deliverable owner, completeness, and planned/author/publish/review due dates |
| `017_03m57s` – `019_04m15s` | **Submission Project Management** dashboard: document status by module, by deliverable owner (approved vs draft), overall completeness, outstanding publishing items |
| `020_04m20s` – `022_04m30s` | **Continuous publishing & validation** tiles: docs not ready, sections with no matched docs, leafs with multiple docs, newer versions available, and validation errors by severity (**High 3, Medium 0, Low 15**), caught early, well before the deadline |

### 5. Author, review and publish (05:00 – 05:50)
| Screen | What you see |
|---|---|
| `023_04m58s` – `024_05m10s` | **Collaborative authoring**: content plan on the left, MS Word (co-authoring) on the right editing *3.2.P.8.1 Stability Summary and Conclusions*. Several authors edit at once and save or check in back to Vault |
| `025_05m28s` – `026_05m35s` | **Viewer**: the published PDF (`stability-summary v0.5`) with submission metadata (operation = Replace, xlink href, checksum) and navigation through the **eCTD XML backbone** |
| `027_05m47s` | **Marketing Submission 0008** (Ready for Submission) → workflow action **"Submit to Gateway"**, which sends the package straight to the health authority |

### 6. Track dispatch (05:55 – 06:30)
| Screen | What you see |
|---|---|
| `028_05m55s` – `030_06m08s` | **Global Submission Completeness (Event)** dashboard: activity status pie, **57% markets dispatched**, 4 initial submissions filed, **100% on-time**, average **14 days to spare** gauge |

### 7. Health Authority questions (06:30 – 07:45)
| Screen | What you see |
|---|---|
| `031_06m42s` | **Health Authority Question HAQ-000022** (from AEMPS, Spain), *"Additional stability data requested"*. Created by forwarding the HA email to a Vault address; the **RIMbot** ingests and auto-classifies it (topic, CTD section P.8, related application) |
| `032_07m21s` | **Related HAQs** report: a similar earlier question (FDA, HAQ-000001) with its response and documents, reused as a starting point |

### 8. Approval → update registrations in bulk (07:45 – 08:30)
| Screen | What you see |
|---|---|
| `033_07m44s` | **Regulatory Objective 005 – DP Shelf Life Extension**: Planned → In Progress → HA Approved/Authorized, with 18 registrations attached, xEVMPD/IDMP flags |
| `034_07m56s` – `036_08m05s` | **Manage Registered Details wizard**: choose the scope (update fields/lifecycle, update or add registered details), select registrations (BE, DK, DE, IE, IT, SI, ES), and add the new **24-month shelf life** registered details in one bulk pass |
| `037_08m10s` – `038_08m26s` | Back on the Product Overview dashboard, **Approved Shelf Life** now shows the 24-month entries, which is the signal to notify stakeholders and start implementation |

### 9. Supply chain view & close (08:50 – 09:24)
| Screen | What you see |
|---|---|
| `039_08m53s` | **Active Dossier Viewer** (filtered: Enalapril; EU, Europe non-EU, APAC). A document × country matrix showing the current version of each stability document (3.2.P.8.1/.2/.3) per market. Supply chain can open the source document or the submitted PDF from the Archive |
| `040_09m15s` | Closing card – veeva.com/vault-rim |

---

## Key capabilities to note (relevance for MedexRegAI)

1. **One data model across RIM.** Registrations, events, submissions, HA questions and documents are linked records, so dashboards can roll up "where is my product registered, with what shelf life, sites and packs".
2. **Change impact assessment.** Given the details a change touches (shelf life, packaging, manufacturer…), the system finds every affected registration worldwide (48 here).
3. **Affiliate input in the flow.** Local disposition per country (prior approval vs notification vs no action).
4. **eCTD content planning plus project management.** Owners, due dates and completeness on each content-plan node.
5. **Continuous publishing and validation.** Each document is published and validated as soon as it is approved, so errors (High/Medium/Low) surface early and less rework is needed at the end.
6. **Co-authoring.** MS Word co-authoring with check-in back to Vault.
7. **Gateway submission.** Dispatch directly from Vault; on-time / days-to-spare KPIs.
8. **AI-assisted HA correspondence ("RIMbot").** Forward an email, and it is ingested, classified and linked. Prior similar questions and answers are retrieved for reuse.
9. **Bulk registration update wizard.** Approval outcomes are written back to every registration in one pass, keeping data quality.
10. **Active Dossier.** The current approved version of each dossier section, per country, available to supply chain and QA.

Possible AI improvements suggested by the demo: smarter impact assessment, auto-drafting HAQ responses from historical Q&A, predicting validation errors, and recommending local dispositions.
