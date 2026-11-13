# ADR-019: eSTAR XML data file, mapped per template version

- Status: Conditional (structure confirmed 2026-11-13; Acrobat Pro import check pending)
- Date: 2026-11-13
- Numbering: the architecture document (docs/Prd/v2.0/03-architecture-v2.0.html) lists this
  decision as ADR-017. ADR-017 in this repository is the fda-data service, so this decision is
  recorded as ADR-019.
- Backlog: E5 / F5.4 (TK-4699 spike, TK-4700 exporter, TK-4701 readiness screen, TK-4702 tests)
- Evidence: [docs/spikes/estar-xml/README.md](../spikes/estar-xml/README.md)

## Context

Consultants file 510(k)s through FDA's eSTAR, a dynamic XFA PDF that must be completed in Adobe
Acrobat Pro (or another supported viewer) and uploaded by the firm through the CDRH Portal.
There is no public submission API, and the PRD rule is that MedexRegAI does not file.
MedexRegAI already holds much of what eSTAR asks for: applicant details, device name and
model, product code and classification, indications for use, device description, and the
predicate. Re-typing it into the PDF is slow and a source of errors.

FDA documents an Export Data / Import Data route in the eSTAR itself: data moves between eSTARs
as an XML file in Acrobat Pro, without attachments.

The Phase V spike examined the blank Non-IVD eSTAR 7.1 template:

- The template is pure dynamic XFA with no AcroForm fields, so we cannot fill the PDF with
  ordinary PDF libraries.
- Its data is a single XML tree under `<root>` (28 sections, 528 data fields), bound to the form
  by name, with coded field names and coded saved values.
- The template's Import Data script runs only in Acrobat Pro. It accepts a file only if the
  application sub-type is set, and then re-runs every field's exit and change logic.
- Eight drop-downs (regulation and product code lists) are filled at runtime by script, so values
  imported into them may not survive.

## Decision

1. **Generate an XML data file, never a filled PDF.** The consultant imports it into a blank eSTAR
   of the matching version with Import Data in Acrobat Pro, then attaches files and completes
   the form there. We do not modify, redistribute or fill FDA's PDF.
2. **One mapping per template version.** For each eSTAR template version, the field catalog is
   generated from FDA's blank PDF by `scripts/estar/xfa_catalog.py` and committed as
   `server/src/estar/templates/<key>.fields.json`, keyed like `projects.estar_template`
   (`nIVD-7.1`). The mapping (our data to catalog paths and saved values) is versioned with it.
   A new eSTAR version gets a new catalog and mapping. Projects grandfathered to an older version
   keep the older one.
3. **Start from the template's own data skeleton** so every node the form expects is present.
   Write saved values (codes) from the catalog, never captions. Always set
   `ApplicationType/ApplicationSubType/ATRadioButton130`.
4. **Only fields that pass the round trip are mapped.** The manual Acrobat Pro check in the spike
   README decides which fields are mapped. A field that fails (for example a runtime-filled list)
   is left out and listed for the consultant to fill by hand.
5. **Off by default** (a server setting, off unless turned on; TK-4701 shows the export on the
   readiness screen only when it is on) until the Acrobat Pro check passes and is recorded here.

## Alternatives considered

- **Fill the eSTAR PDF directly.** Rejected. XFA-only forms cannot be filled by common PDF
  libraries. Writing the XFA datasets packet ourselves would produce an altered FDA form that
  the consultant then files, which is riskier and harder to support.
- **Never generate XML; the consultant re-types.** This is the fallback if the manual check fails.
- **One mapping for all versions.** Rejected. Field codes and sections change between template
  versions, and submissions are grandfathered to a version.

## Consequences

- A small per-version maintenance cost: regenerate the catalog when FDA publishes a new eSTAR, and
  re-run the manual import check.
- Acrobat Pro is required to import. This matches FDA's own recommendation for eSTAR.
- Attachments are never in the XML (FDA states this). MedexRegAI's attachment readiness checks
  (F3.4) remain the way to prepare them.

## Open item

- Run the manual Acrobat Pro check in the spike README with `sample-import-nIVD-7.1.xml` and
  record the result here. Passing it moves this ADR to Accepted for the fields that round-trip.
