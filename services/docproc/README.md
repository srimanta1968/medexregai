# docproc: document parsing sidecar (F7.2)

Turns one client file into passages with locations a reviewer can open: page,
sheet + cell range, slide, or heading path. Contract `docproc/1` is defined in
[`docproc/contract.py`](docproc/contract.py) and mirrored for the app in
`server/src/ingest/docproc.ts`. Locations map 1:1 onto `source_locations`
(server migration 015).

| Format | Engine | Location |
|---|---|---|
| DOCX | python-docx | heading path (pages come with the LibreOffice render step) |
| XLSX | openpyxl (saved values; formulas without one are shown and warned) | sheet + cell range per row |
| PPTX | python-pptx (text, tables, speaker notes) | slide |
| PDF with text | pypdf | page |
| Scanned PDF, PNG/JPEG/TIFF | Docling + OCR (full build only) | page + box |
| CSV / TSV | csv | row range on a sheet named after the file |

Without Docling a scan still parses, answers `needsOcr: true` and lists the pages.
Legacy `.doc/.xls/.ppt` and generic zip archives answer `415 UNSUPPORTED_FORMAT`.

## Safety

- Never fetches anything and keeps nothing: the worker posts the bytes.
- Format is read from the bytes, not the name. Office zips are checked for entry
  count, total size and compression ratio before any parser opens them (`ARCHIVE_LIMIT`).
- Each parse runs in a child process killed at `DOCPROC_PARSE_TIMEOUT_S` (`504 PARSE_TIMEOUT`).
- `X-Docproc-Key` shared secret on every `/v1` call (constant-time compare).
- Runs as a non-root user in a sandbox with no outbound network (see below).

## Sandbox

| | Local (`docker-compose.yml`) | AWS (`infra/terraform/modules/platform`) |
|---|---|---|
| Network | alone on the `internal` network `docproc_sandbox`; the host reaches it only through `docproc-gateway` on 127.0.0.1:4200 | isolated subnets with no internet route; egress only to the AWS interface endpoints and S3 (image layers); ingress only from the worker on 4200 |
| Access | none to data stores: the worker posts the bytes | no database, cache, bucket or KMS permissions; its own key (`<env>/docproc-key`) |
| Limits | 2 CPUs, 4 GB memory (no swap), 256 processes | `docproc_cpu` / `docproc_memory` (2 vCPU, 4 GB) |
| Hardening | read-only root, tmpfs `/tmp`, all capabilities dropped, no-new-privileges, init | read-only root, scratch `/tmp`, all capabilities dropped, init |
| Scaling | one container | one warm task, more on the ingest queue depth the worker logs (`MedexRegAI/Ingest QueueDepth`) up to `docproc_max_count` |

Archives: Office files are the only zips opened, after the entry-count, size and ratio
checks; generic archives are refused (`415`) and embedded files are never expanded, so
nesting depth is one by construction.

Check a running local sandbox with `scripts/verify-docproc-sandbox.sh` (no egress by IP
or name, hardening, limits, reachable through the gateway, key required).

## API

```
GET  /health        -> { status, contractVersion, ocr }
GET  /v1/contract   -> JSON Schema of the result            (X-Docproc-Key)
POST /v1/parse      body: raw file bytes                     (X-Docproc-Key, X-File-Name)
     200 { success: true, data: { sha256, sizeBytes, format, parser, unitCount, ocrUsed, needsOcr, locations[], warnings[] } }
     400 VALIDATION_ERROR  401 UNAUTHORIZED  413 FILE_TOO_LARGE  415 UNSUPPORTED_FORMAT
     422 FILE_UNREADABLE | ARCHIVE_LIMIT  504 PARSE_TIMEOUT
```

## Run locally

Sandboxed, as the app uses it (key from `scripts/setup-env.sh`):

```bash
docker compose up -d docproc docproc-gateway
scripts/verify-docproc-sandbox.sh
```

Or unsandboxed, for working on the parsers:

```bash
pip install -r requirements.txt
DOCPROC_API_KEY=<24+ chars> python -m docproc          # http://127.0.0.1:4200
python fixtures/make_fixtures.py /tmp/ingest-fixtures  # fictional fixture corpus
```

Set the same key as `DOCPROC_API_KEY` in `server/.env`.

| Setting | Default |
|---|---|
| `DOCPROC_MAX_BYTES` | 104857600 (100 MB) |
| `DOCPROC_PARSE_TIMEOUT_S` | 120 |
| `DOCPROC_MAX_UNITS` (pages/slides/sheets) | 3000 |
| `DOCPROC_MAX_ROWS_PER_SHEET` | 50000 |
| `DOCPROC_MAX_ZIP_ENTRIES` / `_UNCOMPRESSED` / `_RATIO` | 10000 / 1 GB / 200 |
| `DOCPROC_CONCURRENCY` | CPUs - 1 |
| `DOCPROC_DISABLE_DOCLING` | unset (`1` forces the core path) |
