/**
 * Mapping v1 for the Non-IVD eSTAR 7.1 (ADR-019): which eSTAR data fields MedexRegAI fills from
 * its own records, with the saved value (a code, never the caption) checked against the field
 * catalog generated from FDA's blank template (templates/nIVD-7.1.fields.json).
 *
 * Only facts MedexRegAI holds are mapped. Everything else (classification lists that the form
 * fills at runtime, indications and description text, addresses, attachments) is listed in
 * FILL_BY_HAND for the consultant. Every mapped field is `roundTrip: 'unverified'` until the
 * Acrobat Pro import check in docs/spikes/estar-xml/README.md passes and is recorded in ADR-019.
 */

export const MAPPING_VERSION = 'nIVD-7.1/1';

export interface ExportContext {
  submissionType: 'traditional' | 'special' | 'abbreviated';
  clientName: string;
  deviceName: string;
  modelNames: string[];
  consultant: { fullName: string; email: string };
  firmName: string;
  predicates: { kNumber: string; deviceName: string | null }[];
}

export type RoundTrip = 'unverified' | 'verified' | 'failed';

/** One field filled once. `value` returns null to leave the template's own value. */
export interface FieldMap {
  path: string;
  source: string;
  value: (c: ExportContext) => string | null;
  roundTrip: RoundTrip;
}

/** A repeating subform: one copy of `group` per item, with these fields (relative to the group). */
export interface RepeatMap<T> {
  group: string;
  source: string;
  items: (c: ExportContext) => T[];
  fields: { field: string; value: (item: T, c: ExportContext) => string | null }[];
  roundTrip: RoundTrip;
}

const SUBMISSION_TYPE: Record<ExportContext['submissionType'], string> = { traditional: '1', abbreviated: '2', special: '3' };

/** Given names and family name from one profile name: the last word is taken as the family name. */
export function splitName(full: string): { first: string | null; last: string | null } {
  const words = full.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return { first: null, last: words[0] ?? null };
  return { first: words.slice(0, -1).join(' '), last: words[words.length - 1] };
}

export const FIELDS: FieldMap[] = [
  { path: 'ApplicationType/ATRadioButton100', source: 'US FDA (MedexRegAI prepares FDA 510(k)s)', value: () => '1', roundTrip: 'unverified' },
  { path: 'ApplicationType/USA/ATRadioButton110', source: 'Premarket Notification 510(k)', value: () => '1', roundTrip: 'unverified' },
  { path: 'ApplicationType/USA/ATRadioButton115', source: 'Project submission type', value: (c) => SUBMISSION_TYPE[c.submissionType], roundTrip: 'unverified' },
  // The form's Import Data accepts a file only when the application sub-type is set.
  { path: 'ApplicationType/ApplicationSubType/ATRadioButton130', source: 'New Application/Submission', value: () => '1', roundTrip: 'unverified' },
  { path: 'AdministrativeInformation/ApplicantInformation/ADTextField210', source: 'Client name', value: (c) => c.clientName, roundTrip: 'unverified' },
  // The consultant files for the client, so the correspondent differs from the applicant.
  { path: 'AdministrativeInformation/ApplicantInformation/ADDropDownList295', source: 'Consultant firm prepares the submission', value: () => '1', roundTrip: 'unverified' },
  { path: 'IndicationsForUse/SubandDevice/IUTextField130', source: 'Device name', value: (c) => c.deviceName, roundTrip: 'unverified' },
];

export const REPEATS: RepeatMap<unknown>[] = [
  {
    group: 'AdministrativeInformation/CorrespondentInformation',
    source: 'Your profile and firm',
    items: (c) => [c.consultant],
    fields: [
      { field: 'ADTextField340', value: (_i, c) => splitName(c.consultant.fullName).first },
      { field: 'ADTextField330', value: (_i, c) => splitName(c.consultant.fullName).last },
      { field: 'ADTextField360', value: (_i, c) => c.consultant.email },
      { field: 'ADTextField410', value: (_i, c) => c.firmName },
    ],
    roundTrip: 'unverified',
  },
  {
    group: 'DeviceDescription/Devices/Device',
    source: 'Device name and model names',
    items: (c) => (c.modelNames.length ? c.modelNames : [null]),
    fields: [
      { field: 'TradeName', value: (_m, c) => c.deviceName },
      { field: 'Model', value: (m) => (m as string | null) },
    ],
    roundTrip: 'unverified',
  } as RepeatMap<unknown>,
  {
    group: 'PredicatesSE/PredicateReference',
    source: 'SE comparisons in this project',
    items: (c) => c.predicates,
    fields: [
      // "Is this a Preamendments or Exempt device without a submission number?" No: it has a K-number.
      { field: 'ADDropDownList820', value: () => '2' },
      { field: 'ADTextField830', value: (p) => (p as ExportContext['predicates'][number]).kNumber },
      { field: 'ADTextField840', value: (p) => (p as ExportContext['predicates'][number]).deviceName },
    ],
    roundTrip: 'unverified',
  } as RepeatMap<unknown>,
];

/** What the consultant completes in the eSTAR after importing, and why MedexRegAI leaves it. */
export const FILL_BY_HAND: { section: string; what: string; why: string }[] = [
  {
    section: 'Classification',
    what: 'Medical specialty, regulation and product code',
    why: 'The form fills the regulation and product-code lists by script, so imported values may be cleared; choose them in the form.',
  },
  { section: 'Predicates', what: "Each predicate's medical specialty, regulation and product code", why: 'Same runtime-filled lists as Classification.' },
  { section: 'Applicant information', what: 'Contact person, title, phone, address and country', why: 'MedexRegAI does not hold the client contact details.' },
  { section: 'Correspondent information', what: 'Title, phone, occupation and address', why: 'Not in your MedexRegAI profile.' },
  { section: 'Indications for Use and Device Description', what: 'The indications and device description text', why: 'Paste the wording you approved; MedexRegAI does not move drafted text into the eSTAR.' },
  { section: 'All sections', what: 'Attachments', why: 'FDA: attachments are never included in an eSTAR XML file.' },
];
