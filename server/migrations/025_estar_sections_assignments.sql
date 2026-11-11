-- F2.2 Sorted folder: the eSTAR sections a client file can be evidence for, and
-- which section each file is assigned to, with confidence and where it came from.
--
-- Section titles are copied verbatim from FDA, "Electronic Submission Template for
-- Medical Device 510(k) Submissions: Guidance for Industry and Food and Drug
-- Administration Staff", issued October 2, 2023, Table 1 ("Structure of the current
-- eSTAR 510(k) Electronic Submission Template"), https://www.fda.gov/media/152429/download.
-- That table describes the template at the time of the guidance; FDA revises the
-- eSTAR template itself (nIVD v7.1 at the time of writing), so the source and edition
-- are stored with the rows and a later edition is added as new rows, never by editing.

CREATE TABLE IF NOT EXISTS estar_sections (
  id              varchar(40) PRIMARY KEY,
  edition         varchar(40) NOT NULL,
  ordinal         smallint NOT NULL,
  title           varchar(120) NOT NULL,
  -- FDA's own description, shortened only by omitting the footnoted guidance titles.
  fda_description text NOT NULL,
  -- all | special_510k (FDA: "Applicable to Special 510(k) submissions only.")
  applies_to      varchar(16) NOT NULL DEFAULT 'all',
  -- False for sections answered in the template's own form fields rather than with
  -- client evidence files (e.g. Submission Type, Applicant Information); the sorter
  -- never files client documents there and the coverage panel does not expect them.
  takes_evidence  boolean NOT NULL,
  source          text NOT NULL,
  CONSTRAINT estar_sections_applies_chk CHECK (applies_to IN ('all', 'special_510k')),
  CONSTRAINT estar_sections_edition_ordinal_uq UNIQUE (edition, ordinal)
);

INSERT INTO estar_sections (id, edition, ordinal, title, fda_description, applies_to, takes_evidence, source) VALUES
  ('submission_type', 'fda-guidance-2023-10-02', 1, 'Submission Type',
   'Identification of key information that may be useful to FDA in the initial processing and review of the 510(k) submission, including content from current Form FDA 3514, Section A.', 'all', false, 'FDA eSTAR 510(k) guidance (2023-10-02), Table 1'),
  ('cover_letter', 'fda-guidance-2023-10-02', 2, 'Cover Letter / Letters of Reference',
   'Attach a cover letter and any documents that refer to other submissions.', 'all', true, 'FDA eSTAR 510(k) guidance (2023-10-02), Table 1'),
  ('applicant_information', 'fda-guidance-2023-10-02', 3, 'Applicant Information',
   'Information on the applicant and correspondent, if applicable, consistent with content from current Form FDA 3514, Sections B and C.', 'all', false, 'FDA eSTAR 510(k) guidance (2023-10-02), Table 1'),
  ('presubmission_correspondence', 'fda-guidance-2023-10-02', 4, 'Pre-Submission Correspondence & Previous Regulator Interaction',
   'Information on prior submissions for the same device included in the current submission, such as submission numbers for a prior not substantially equivalent (NSE) determination, prior deleted or withdrawn 510(k), Q-Submission, Investigational Device Exemption (IDE) application, premarket approval (PMA) application, humanitarian device exemption (HDE) application, or De Novo classification request.', 'all', true, 'FDA eSTAR 510(k) guidance (2023-10-02), Table 1'),
  ('consensus_standards', 'fda-guidance-2023-10-02', 5, 'Consensus Standards',
   'Identification of voluntary consensus standard(s) used, if applicable. This includes both FDA-recognized and non-recognized consensus standards.', 'all', true, 'FDA eSTAR 510(k) guidance (2023-10-02), Table 1'),
  ('device_description', 'fda-guidance-2023-10-02', 6, 'Device Description',
   'Identification of listing number if listed with FDA. Descriptive information for the device, including a description of the technological characteristics of the device including materials, design, energy source, and other device features, as defined in section 513(i)(1)(B) of the FD&C Act and 21 CFR 807.100(b)(2)(ii)(A). Descriptive information also includes a description of the principle of operation for achieving the intended effect and the proposed conditions of use, such as surgical technique for implants; anatomical location of use; user interface; how the device interacts with other devices; and/or how the device interacts with the patient. Information on whether the device is intended to be marketed with accessories. Identification of any applicable device-specific guidance document(s) or special controls for the device type.', 'all', true, 'FDA eSTAR 510(k) guidance (2023-10-02), Table 1'),
  ('indications_for_use', 'fda-guidance-2023-10-02', 7, 'Proposed Indications for Use (Form FDA 3881)',
   'Identification of the proposed indications for use of the device. The term indications for use, as defined in 21 CFR 814.20(b)(3)(i), describes the disease or condition the device will diagnose, treat, prevent, cure, or mitigate, including a description of the patient population for which the device is intended.', 'all', true, 'FDA eSTAR 510(k) guidance (2023-10-02), Table 1'),
  ('classification', 'fda-guidance-2023-10-02', 8, 'Classification',
   'Identification of the classification regulation number that seems most appropriate for the subject device, as applicable.', 'all', false, 'FDA eSTAR 510(k) guidance (2023-10-02), Table 1'),
  ('predicates_se', 'fda-guidance-2023-10-02', 9, 'Predicates and Substantial Equivalence',
   'Identification of a predicate device (e.g., 510(k) number, De Novo number, reclassified PMA number, classification regulation reference, if exempt and limitations to exemption are exceeded, or statement that the predicate is a preamendments device). The submission should include a comparison of the predicate and subject device and a discussion why any differences between the subject and predicate do not impact safety and effectiveness [see section 513(i)(1)(A) of the FD&C Act and 21 CFR 807.87(f)]. A reference device should also be included in the discussion, if applicable.', 'all', true, 'FDA eSTAR 510(k) guidance (2023-10-02), Table 1'),
  ('design_risk_special', 'fda-guidance-2023-10-02', 10, 'Design/Special Controls, Risks to Health, and Mitigation Measures',
   'Applicable to Special 510(k) submissions only. Identification of the device changes and the risk analysis method(s) used to assess the impact of the change(s) on the device and the results of the analysis. Risk control measures to mitigate identified risks (e.g., labeling, verification).', 'special_510k', true, 'FDA eSTAR 510(k) guidance (2023-10-02), Table 1'),
  ('labeling', 'fda-guidance-2023-10-02', 11, 'Labeling',
   'Submission of proposed labeling in sufficient detail to satisfy the requirements of 21 CFR 807.87(e). Generally, if the device is an in vitro diagnostic device, the labeling must also satisfy the requirements of 21 CFR 809.10. Additionally, the term "labeling" generally includes the device label, instructions for use, and any patient labeling.', 'all', true, 'FDA eSTAR 510(k) guidance (2023-10-02), Table 1'),
  ('reprocessing', 'fda-guidance-2023-10-02', 12, 'Reprocessing',
   'Information for assessing the reprocessing validation and labeling, if applicable.', 'all', true, 'FDA eSTAR 510(k) guidance (2023-10-02), Table 1'),
  ('sterility', 'fda-guidance-2023-10-02', 13, 'Sterility',
   'Information on sterility and validation methods, if applicable.', 'all', true, 'FDA eSTAR 510(k) guidance (2023-10-02), Table 1'),
  ('shelf_life', 'fda-guidance-2023-10-02', 14, 'Shelf Life',
   'Summary of methods used to establish that device performance is maintained for the entirety of the proposed shelf-life (e.g., mechanical properties, coating integrity, pH, osmolality), if applicable.', 'all', true, 'FDA eSTAR 510(k) guidance (2023-10-02), Table 1'),
  ('biocompatibility', 'fda-guidance-2023-10-02', 15, 'Biocompatibility',
   'Information on the biocompatibility assessment of patient contacting materials, if applicable.', 'all', true, 'FDA eSTAR 510(k) guidance (2023-10-02), Table 1'),
  ('software', 'fda-guidance-2023-10-02', 16, 'Software/Firmware',
   'Submission of applicable software documentation, if applicable.', 'all', true, 'FDA eSTAR 510(k) guidance (2023-10-02), Table 1'),
  ('cybersecurity', 'fda-guidance-2023-10-02', 17, 'Cybersecurity/Interoperability',
   'Submission of applicable information regarding the assessment of cybersecurity, if applicable.', 'all', true, 'FDA eSTAR 510(k) guidance (2023-10-02), Table 1'),
  ('emc_safety', 'fda-guidance-2023-10-02', 18, 'Electromagnetic Compatibility (EMC), Electrical, Mechanical, Wireless and Thermal Safety',
   'Submission of the EMC, Electrical, Mechanical, Wireless and Thermal Safety testing for your device or summarize why testing is not needed.', 'all', true, 'FDA eSTAR 510(k) guidance (2023-10-02), Table 1'),
  ('performance_testing', 'fda-guidance-2023-10-02', 19, 'Performance Testing',
   'For non-in vitro diagnostic devices: Provide information on the non-clinical and clinical test reports submitted, referenced, or relied on in the 510(k) for a determination of substantial equivalence. For in vitro diagnostic devices: Provide analytical performance, comparison studies, reference range/expected values, and clinical study information.', 'all', true, 'FDA eSTAR 510(k) guidance (2023-10-02), Table 1'),
  ('references', 'fda-guidance-2023-10-02', 20, 'References',
   'Inclusion of any literature references, if applicable.', 'all', true, 'FDA eSTAR 510(k) guidance (2023-10-02), Table 1'),
  ('administrative', 'fda-guidance-2023-10-02', 21, 'Administrative Documentation',
   'Inclusion of additional administrative forms applicable to the submission, including but not limited to a general summary of submission/executive summary (recommended), a Truthful and Accuracy Statement, and a 510(k) Summary or statement.', 'all', true, 'FDA eSTAR 510(k) guidance (2023-10-02), Table 1'),
  ('ai_response', 'fda-guidance-2023-10-02', 22, 'Amendment/Additional Information (AI) response',
   'Inclusion of responses to Additional Information requests.', 'all', true, 'FDA eSTAR 510(k) guidance (2023-10-02), Table 1')
ON CONFLICT (id) DO NOTHING;

-- Which section a file is evidence for. Every decision is a row (history): the sorter's
-- suggestions and the consultant's corrections. Exactly one row per file is current.
-- Corrections (source = 'consultant') are what the sorter learns from, for this firm only.
CREATE TABLE IF NOT EXISTS file_assignments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL,
  project_id         uuid NOT NULL,
  file_id            uuid NOT NULL,
  -- The version the decision was made on (a new version is sorted again).
  version_id         uuid,
  -- NULL: "no section" (the sorter could not place it, or the consultant said it is
  -- not evidence for any section).
  section_id         varchar(40) REFERENCES estar_sections(id),
  confidence         numeric(4, 3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  -- rules | embedding | llm | consultant
  source             varchar(12) NOT NULL,
  -- Why this section, in words the consultant sees on hover (e.g. "Title says
  -- 'EO validation report'; matches Sterility").
  reason             varchar(500) NOT NULL,
  -- For a correction: the section the sorter had suggested.
  corrected_from     varchar(40) REFERENCES estar_sections(id),
  is_current         boolean NOT NULL DEFAULT true,
  decided_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT file_assignments_id_org_uq UNIQUE (id, org_id),
  CONSTRAINT file_assignments_file_fk FOREIGN KEY (file_id, org_id) REFERENCES files (id, org_id) ON DELETE CASCADE,
  CONSTRAINT file_assignments_project_fk FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  CONSTRAINT file_assignments_version_fk FOREIGN KEY (version_id, org_id) REFERENCES file_versions (id, org_id) ON DELETE SET NULL (version_id),
  CONSTRAINT file_assignments_source_chk CHECK (source IN ('rules', 'embedding', 'llm', 'consultant')),
  -- A consultant's decision is certain; only the sorter reports less.
  CONSTRAINT file_assignments_consultant_conf_chk CHECK (source <> 'consultant' OR confidence = 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS file_assignments_current_uq ON file_assignments (file_id) WHERE is_current;
CREATE INDEX IF NOT EXISTS file_assignments_project_idx ON file_assignments (org_id, project_id, section_id) WHERE is_current;
-- The firm's corrections, read by the sorter.
CREATE INDEX IF NOT EXISTS file_assignments_corrections_idx ON file_assignments (org_id, created_at DESC) WHERE source = 'consultant';
