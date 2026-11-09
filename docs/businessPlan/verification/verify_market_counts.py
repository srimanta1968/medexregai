"""Reproduce every FDA-derived count in the business plan's market evidence section (§22).

Usage:  python verify_market_counts.py [cache_dir]

Downloads four public files from FDA (about 1 GB in total, of which about 2.4 GB is
unzipped), then prints each count twice:
  raw    - distinct names exactly as FDA spells them (what an Excel pivot gives you)
  clean  - names upper-cased with punctuation and legal suffixes removed (Inc, LLC, GmbH ...),
           which merges "Acme, Inc." and "ACME INC" and is the figure quoted in the plan.
Needs Python 3.9+ and about 8 GB of free RAM for the 510(k) and registration JSON files.
"""
import collections
import io
import json
import re
import sys
import urllib.request
import zipfile
from datetime import datetime
from pathlib import Path

UA = {"User-Agent": "Mozilla/5.0 (market-count verification)"}
FILES = {
    "510k": "https://download.open.fda.gov/device/510k/device-510k-0001-of-0001.json.zip",
    "reg1": "https://download.open.fda.gov/device/registrationlisting/device-registrationlisting-0001-of-0002.json.zip",
    "reg2": "https://download.open.fda.gov/device/registrationlisting/device-registrationlisting-0002-of-0002.json.zip",
    "drugsfda": "https://download.open.fda.gov/drug/drugsfda/drug-drugsfda-0001-of-0001.json.zip",
    "bmis": "https://www.fda.gov/media/189929/download?attachment",
}
SUFFIXES = r"\b(INC|INCORPORATED|LLC|L L C|LTD|LIMITED|CO|CORP|CORPORATION|COMPANY|GMBH|AG|SA|S A|SAS|SRL|SPA|BV|B V|AB|AS|OY|KK|PLC|PTY|USA|US|THE|DBA)\b"


def clean(name):
    s = re.sub(r"[^A-Z0-9 ]", " ", (name or "").upper())
    return " ".join(re.sub(SUFFIXES, " ", s).split())


def fetch(key, cache):
    path = cache / (key + ".zip")
    if not path.exists():
        print(f"downloading {FILES[key]}", file=sys.stderr)
        with urllib.request.urlopen(urllib.request.Request(FILES[key], headers=UA)) as r:
            path.write_bytes(r.read())
    z = zipfile.ZipFile(path)
    return z, z.namelist()[0]


def load_json(key, cache):
    z, name = fetch(key, cache)
    with z.open(name) as f:
        return json.load(f)["results"]


def buckets(counter):
    b = {"1": 0, "2-4": 0, "5-9": 0, "10+": 0}
    for n in counter.values():
        b["1" if n == 1 else "2-4" if n <= 4 else "5-9" if n <= 9 else "10+"] += 1
    return b


def device_filers(cache):
    raw, cln, country, n, us = collections.Counter(), collections.Counter(), {}, 0, 0
    for r in load_json("510k", cache):
        d = r.get("decision_date") or ""
        if not ("2021-01-01" <= d <= "2025-12-31") or not (r.get("decision_code") or "").startswith("SE"):
            continue
        n += 1
        us += r.get("country_code") == "US"
        raw[r.get("applicant") or ""] += 1
        k = clean(r.get("applicant"))
        cln[k] += 1
        country[k] = r.get("country_code")
    print("\n[1] 510(k) clearances (decision code SE*), decided 2021-01-01..2025-12-31")
    print(f"    clearances {n:,}  US applicants {us:,}  non-US {n - us:,} ({(n - us) / n:.1%})")
    print(f"    distinct applicants raw {len(raw):,}  clean {len(cln):,}")
    print(f"    by clearances (clean)  {buckets(cln)}")
    print(f"    by clearances (raw)    {buckets(raw)}")
    print(f"    US-domiciled applicants (clean) {sum(1 for k in cln if country[k] == 'US'):,}")


def us_agents(cache):
    seen, agents, raw_agents, foreign = set(), collections.Counter(), collections.Counter(), 0
    for key in ("reg1", "reg2"):
        for r in load_json(key, cache):
            g = r["registration"]
            reg = g.get("registration_number") or g.get("fei_number")
            if reg in seen:
                continue
            seen.add(reg)
            if g.get("status_code") != "1" or g.get("iso_country_code") == "US":
                continue
            foreign += 1
            a = g.get("us_agent") or {}
            name = a.get("business_name") or a.get("name") or ""
            own = clean((g.get("owner_operator") or {}).get("firm_name"))
            k = clean(name)
            if k and k != own and k not in own and own not in k:  # exclude a firm acting as its own agent
                agents[k] += 1
                raw_agents[name] += 1
    print("\n[2] Foreign device establishments (active registrations) and their third-party US agents")
    print(f"    active foreign establishments {foreign:,}")
    print(f"    distinct third-party US agent firms raw {len(raw_agents):,}  clean {len(agents):,}")
    for k in (2, 5, 10, 25):
        print(f"    serving >= {k:>2} establishments (clean) {sum(1 for v in agents.values() if v >= k):,}")
    print("    largest:", ", ".join(f"{k.title()} {v}" for k, v in agents.most_common(8)))


def drug_sponsors(cache):
    sets = {"NDA": set(), "ANDA": set(), "BLA": set()}
    for r in load_json("drugsfda", cache):
        app = r.get("application_number", "")
        kind = next((t for t in ("ANDA", "NDA", "BLA") if app.startswith(t)), None)
        if not kind:
            continue
        for s in r.get("submissions") or []:
            if s.get("submission_status") == "AP" and "20210101" <= s.get("submission_status_date", "") <= "20251231":
                sets[kind].add(re.sub(r"[^A-Z0-9 ]", "", (r.get("sponsor_name") or "").upper()).strip())
                break
    allx = set().union(*sets.values())
    print("\n[3] Drugs@FDA sponsors with >= 1 approved submission (status AP) dated 2021-2025")
    print(f"    NDA {len(sets['NDA']):,}  ANDA {len(sets['ANDA']):,}  BLA {len(sets['BLA']):,}  any {len(allx):,}")


def bmis_cros(cache):
    z, name = fetch("bmis", cache)
    raw, cln, cln_all, us = collections.Counter(), collections.Counter(), set(), set()
    with z.open(name) as f:
        for i, line in enumerate(io.TextIOWrapper(f, encoding="latin-1")):
            p = line.rstrip("\n").split("~")
            if i == 0 or len(p) < 14 or p[13].strip() != "CRO":
                continue
            site = p[6].strip()
            if not clean(site) or site == "NG":
                continue
            cln_all.add(clean(site))
            try:
                year = datetime.strptime(p[12].strip(), "%d-%b-%Y").year
            except ValueError:
                continue
            if year >= 2021:
                raw[site] += 1
                cln[clean(site)] += 1
                if p[11].strip() == "USA":
                    us.add(clean(site))
    print(f"\n[4] FDA BMIS file ({name}): organisations recorded as TYPE = CRO")
    print(f"    distinct CRO names, all years since Oct 2008 (clean) {len(cln_all):,}")
    print(f"    on forms received 2021 or later: raw {len(raw):,}  clean {len(cln):,}  US-addressed (clean) {len(us):,}")
    for k in (2, 5, 10):
        print(f"    named on >= {k:>2} forms since 2021 (clean) {sum(1 for v in cln.values() if v >= k):,}")


if __name__ == "__main__":
    cache = Path(sys.argv[1] if len(sys.argv) > 1 else "fda_cache")
    cache.mkdir(exist_ok=True)
    device_filers(cache)
    us_agents(cache)
    drug_sponsors(cache)
    bmis_cros(cache)
