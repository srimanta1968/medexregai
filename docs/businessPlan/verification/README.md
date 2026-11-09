# Market evidence: how to check every number

This folder backs §22 of `MedexRegAI-BusinessPlan-PreSeed-v6.html` and appendix slide 29 of `MedexRegAI-InvestorDeck-PreSeed-v7.pptx`.
Every FDA-derived figure can be reproduced in two ways: by hand from FDA's own files and pages, or by running the script.
The output from the last run is in `results-2026-10-14.txt`.

## Option A: run the script (about 10 minutes)

```
python verify_market_counts.py fda_cache
```

The script downloads about 1 GB of public FDA files into `fda_cache/` and prints every count.
It needs Python 3.9+ and about 8 GB of free RAM.

Each count is printed twice:
- **raw**: distinct names exactly as FDA spells them. This is what an Excel pivot table gives you.
- **clean**: names upper-cased, with punctuation and legal suffixes (Inc, LLC, GmbH, Ltd, …) removed, so "Acme, Inc." and "ACME INC" count once. This is the figure the plan quotes.

## Option B: check by hand

### 1. Device clearances and filers: no download needed

Open these links in a browser and read `meta.results.total`:

| What | Expected | Link |
|---|---|---|
| Cleared 510(k)s decided 2021–2025 | 15,759 | https://api.fda.gov/device/510k.json?search=decision_date:[2021-01-01+TO+2025-12-31]+AND+decision_code:SE*&limit=1 |
| …of which the applicant is in the US | 7,533 | https://api.fda.gov/device/510k.json?search=decision_date:[2021-01-01+TO+2025-12-31]+AND+decision_code:SE*+AND+country_code:US&limit=1 |

To count the companies:
1. Download FDA's 510(k) text file: https://www.accessdata.fda.gov/premarket/ftparea/pmn96cur.zip (listed at https://www.fda.gov/medical-devices/510k-clearances/downloadable-510k-files).
2. Open it in Excel using Data → From Text/CSV, with `|` as the delimiter.
3. Filter `DECISIONDATE` to 01/01/2021–12/31/2025 and `DECISION` to codes beginning with `SE`. That leaves 15,759 rows.
4. Build a pivot table on `APPLICANT` with a count of `KNUMBER`. It shows 6,501 distinct spellings. Grouping by 1 / 2–4 / 5–9 / 10+ rows gives the raw buckets in the results file.

Merging spellings of the same company brings this down to 6,134 companies (3,548 / 1,869 / 492 / 225), against the plan's 3,627 / 1,900 / 496 / 223.

### 2. US regulatory consultants: firms acting as US agent for foreign device makers

Every foreign device establishment must name a US agent (21 CFR 807.40). Many US agents are regulatory consultancies, for example Registrar Corp, Emergo and mdi Consultants.
- **Spot-check a firm:** search FDA's establishment registration database (https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfRL/rl.cfm). Each establishment record shows its US agent.
- **Ranked list:** https://api.fda.gov/device/registrationlisting.json?count=registration.us_agent.business_name.exact&limit=1000 shows the 1,000 most-named agents. It counts device listings rather than establishments, so the numbers are larger than the script's.
- **Exact count (script only):** 4,019 distinct third-party agent firms across 15,437 active foreign establishments. 1,201 of them serve 2 or more establishments, and 344 serve 5 or more. A firm acting as its own agent is excluded.
- **Individuals:** RAPS reports 30,000+ members worldwide (https://www.raps.org/connect-engage/about-raps.html). That counts people, not firms, and RAPS publishes no consultant breakdown.

### 3. Pharma CROs: FDA's Bioresearch Monitoring Information System (BMIS)

BMIS lists the clinical investigators, CROs and IRBs named on Forms 1571 and 1572 in drug INDs submitted to CDER since October 2008.
1. Open the landing page: https://www.fda.gov/drugs/drug-approvals-and-databases/bioresearch-monitoring-information-system-bmis
2. Download the file: https://www.fda.gov/media/189929/download?attachment. The current file is `BMIS_2026_0831.txt`, `~`-delimited, with 1.86M rows.
3. The file is too large for an Excel sheet. Use Data → Get Data → From Text, then in Power Query filter `TYPE = CRO` (about 53,000 rows) and `RCVD` ≥ 1 Jan 2021 before loading.
4. Remove duplicates on `SITE`. That gives 4,392 raw names, or 3,748 after merging spellings. 2,214 have a US address (`COUNTRY = USA`), and 905 appear on 5 or more forms.
5. Caveat: subsidiaries are not merged (IQVIA and IQVIA Biotech count as two). Some entries are clinical-supply or lab vendors that sponsors declared as CROs.

### 4. Pharma sponsors and INDs

- **Sponsors:** Drugs@FDA bulk file https://download.open.fda.gov/drug/drugsfda/drug-drugsfda-0001-of-0001.json.zip. 1,260 distinct sponsors had at least one approved submission (NDA, ANDA or BLA, including supplements) dated 2021–2025. Script only.
- **INDs:** CDER's "INDs with activity, calendar year 2024" (https://www.fda.gov/media/185469/download) lists 9,698 commercial and 5,172 research INDs. FDA does not publish a sponsor count.

### 5. Analyst market estimates (third-party, not audited)

| Figure | Value | Link |
|---|---|---|
| Medical device CRO market, 2024 | $8.49B | https://www.towardshealthcare.com/insights/medical-device-cro-market-sizing |
| Medical device regulatory affairs, 2024 (59.1% outsourced) | $6.7B | https://www.grandviewresearch.com/industry-analysis/medical-device-regulatory-affairs-market |
| Healthcare RA outsourcing, 2024 (pharma 50.3%, device $2.1B) | $7.5B | https://www.gminsights.com/industry-analysis/healthcare-regulatory-affairs-outsourcing-market |
| RIM systems, 2024 (software $1.5B) | $2.2B | https://www.gminsights.com/industry-analysis/regulatory-information-management-system-market |
| RIM systems, 2030 (pharma 42.8% in 2023) | $4.12B | https://finance.yahoo.com/news/regulatory-information-management-system-market-111400873.html |
| All CROs, 2025 | $57.5B | https://www.gminsights.com/industry-analysis/contract-research-organization-cro-market |

## What cannot be verified from public data

- The plan's 1,500 "consultancies and CROs", 2,500 pre-market startups, 400 investors and 3,000 academics.
- Per-segment annual spend ($600–$54,000). These are pricing-model assumptions.
- The "$1.2–1.6B device regulatory software TAM, 2030". No published source was found.
