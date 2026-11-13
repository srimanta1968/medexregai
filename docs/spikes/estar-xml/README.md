# Spike: eSTAR XML import into the nIVD eSTAR v7.1 (F5.4, TK-4699)

- Date: 2026-11-13
- Template: Non-IVD eSTAR Version 7.1, downloaded from FDA's eSTAR Program page
  (`https://www.fda.gov/media/192777/download?attachment`), 5,418,738 bytes,
  SHA-256 `d7926c7699dab2e86b45062e228511650419d182f7255b3dee00519a3dfcfc93`.
  The blank template is not committed (FDA's file; download it again from that page).
- Decision record: [ADR-019](../../adr/ADR-019-estar-xml-export.md)
- Result: **structure confirmed; import in Acrobat Pro not yet run.** The decisive check needs
  Adobe Acrobat Pro and a person (see "Manual check" below). Until it passes, the exporter stays
  behind a feature flag.

## What FDA says (eSTAR Program page, read 2026-11-13)

- "Yes, if you use Adobe Acrobat Pro, you can transfer eSTAR data by first clicking the Export
  Data button"; the data is saved as an XML file and loaded with Import Data in the new eSTAR.
- "Please note that attachments will not be included in the XML file generated."
- "eSTAR cannot be opened in a web browser, due to the dynamic PDF nature of the file." Adobe
  Acrobat Pro is recommended; Acrobat Reader opens eSTAR but cannot save changes.
- Templates current on the page: Non-IVD eSTAR 7.1, IVD eSTAR 7.1, PreSTAR 3.1. A submission is
  "grandfathered" to the eSTAR version once FDA acknowledges it.

## What the blank nIVD 7.1 template contains (measured with `scripts/estar/xfa_catalog.py`)

| Finding | Value | What it means for us |
|---|---|---|
| Form technology | Dynamic XFA (`NeedsRendering` true, XFA template namespace 3.3), **0 AcroForm fields** | Only XFA-aware software can fill it. Ordinary PDF form libraries (pdf-lib, pypdf form filling) cannot. XML import through Acrobat is the realistic route; we do not fill the PDF ourselves. |
| Data root | `<root>` with 28 top-level sections (ApplicationType, AdministrativeInformation, DeviceDescription, IndicationsForUse, Classification, PredicatesSE, ... AttachmentManifest, Version) | The XML file is this data tree. |
| Data binding | Fields bind to data by name through named subforms; 914 of 919 `bind` elements are `match="none"` (buttons and display-only fields) | A field's XML path is its chain of subform names, e.g. `IndicationsForUse/Indications/IUTextField141`. |
| Data fields | 528 (276 text, 188 drop-down lists, 55 check boxes, 8 radio groups, 1 numeric); 249 sit in repeating subforms | Field names are codes (`ADTextField140`); the catalog records each one's caption, so the mapping is code-to-meaning per template version. |
| Saved values | Radios, check boxes and lists save codes, not captions (e.g. 510(k) = `1` in `ApplicationType/USA/ATRadioButton110`; Traditional = `1` in `ATRadioButton115`) | The exporter must write the saved value from the catalog, never the caption. |
| Runtime-filled lists | 8 drop-downs have no items in the template and are filled by script (e.g. Classification Regulation `DDDropDownList513`, Product Code `DDDropDownList517`, and the same in each predicate) | Highest risk: an imported value may be cleared if the list is rebuilt after import. Must be checked by hand. |
| Version node | `Version` = `7.01` in the blank data; the form recomputes it from its own header when it opens | An imported Version is overwritten, not checked. We still record which template a file was made for. |
| Import button script | Blocks import in Foxit and PDF-XChange ("Only Adobe Acrobat Pro has the capabilities required for the Import"); asks for confirmation; calls `xfa.host.importData()`; treats the import as successful **only if `ApplicationType/ApplicationSubType/ATRadioButton130` has a value** (New Application/Submission = `1`); then walks every visible subform and field and re-runs their exit and change routines | Our XML must always set `ATRadioButton130`. The re-run is how "the form logic still runs" after import. |
| Release notes in the template | v7.1 fixed "a bug that occurred when modifying the Study Title in the Bench or Clinical attachment questions only after importing data from another eSTAR" | FDA maintains the import path as a supported workflow. |

The full catalog is committed as `server/src/estar/templates/nIVD-7.1.fields.json` (with the
template's SHA-256, data root, data version and the list of runtime-filled drop-downs). One
catalog per template version is the "versioned mapping" input for TK-4700.

## Files in this folder

- `skeleton-nIVD-7.1.xml`: the blank template's own data tree (what an exporter fills in).
- `sample-values-nIVD-7.1.json`: 17 FICTIONAL values (new 510(k), Traditional, US FDA, applicant,
  trade name, device description, indications, prescription use, one predicate).
- `exporter-output-nIVD-7.1.xml`: real exporter output for a fictional project (see Manual check).
- `sample-import-nIVD-7.1.xml`: the skeleton with those values, made by
  `scripts/estar/sample_import_xml.py`. Rich-text nodes carry an `html:` prefix for the xhtml
  namespace (the form writes the same namespace as a default namespace); a namespace-aware import
  treats them the same, and the manual check confirms it.

## Manual check (needs Adobe Acrobat Pro; about 15 minutes)

Use **`exporter-output-nIVD-7.1.xml`**: a file made by the real exporter (TK-4700, mapping
`nIVD-7.1/1`) for a FICTIONAL project (Special 510(k), two device models, two predicates from SE
comparisons; client, firm and email are test data). It is what consultants will download, so it is
the file to prove. `sample-import-nIVD-7.1.xml` (the spike's hand-made sample) can be tried too.
The steps below name values from the sample; for the exporter file expect Special, models IS-200A
and IS-200B, and the two predicates it lists.

1. Download a fresh blank nIVD eSTAR 7.1 from FDA's eSTAR Program page (right-click, save link as).
   Confirm its SHA-256 matches the one above, or note the new one.
2. Open it in Acrobat Pro. On page 1 click **Import Data**, confirm, and choose
   `sample-import-nIVD-7.1.xml`.
3. Record, for each item, pass or fail:
   - No error dialog; the progress bar finishes.
   - Page 2 shows US FDA, 510(k), Traditional, New Application/Submission.
   - Applicant name, email and company; trade name and model; device description; indications
     for use; Prescription Use ticked; predicate K230022 with its trade name all show as imported.
   - Form logic ran: sections that depend on the 510(k)/Traditional choice are shown, and the
     completion indicators update.
   - Save, close, reopen: values are still there.
4. Click **Export Data**, save the XML, and compare it with the sample: the same paths should
   hold the same values (Version and SavedTime will differ).
5. Repeat with the Classification Medical Specialty, Regulation and Product Code set (once the
   catalog's saved values for the chosen specialty are known) to see whether runtime-filled lists
   keep imported values.

Then compare automatically (TK-4702):

    python scripts/estar/compare_roundtrip.py docs/spikes/estar-xml/exporter-output-nIVD-7.1.xml <the XML Acrobat exported> --json roundtrip.json

It lists every mapped field and repeat count as OK or LOST and exits 1 if anything was lost.
Mark each field `verified` or `failed` in `server/src/estar/mappings/nIVD-7.1.ts` from that list.

Record the result in ADR-019. If steps 2 to 4 pass, the exporter is approved for the fields that
round-trip; fields that fail (for example runtime-filled lists) are left out of the mapping and
listed for the consultant to fill by hand.
