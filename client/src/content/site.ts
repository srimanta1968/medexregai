/**
 * Website copy. Every statement here comes from PRD v2.0 (MRA-PRD-201), the delivery
 * plan (MRA-PRD-202), the architecture (MRA-PRD-203) or UI 2.0 (MRA-PRD-204).
 * Do not add time-saved, ROI or customer claims until the pilot has measured them,
 * and do not publish prices before Gate V.
 */

export interface NavItem {
  label: string;
  to: string;
}

export interface Card {
  title: string;
  body: string;
}

export interface Capability extends Card {
  points: string[];
}

export interface Faq {
  question: string;
  answer: string;
}

export const NAV_ITEMS: NavItem[] = [
  { label: 'Product', to: '/product' },
  { label: 'How it works', to: '/how-it-works' },
  { label: 'Security', to: '/security' },
  { label: 'Pilot programme', to: '/pilot' },
  { label: 'FDA product codes', to: '/codes' },
  { label: 'FDA product codes', to: '/codes' },
  { label: 'FAQ', to: '/faq' },
  { label: 'About', to: '/about' },
];

/** Shown wherever the site invites action: the product is pre-launch and enrolling pilots. */
export const PILOT_STATUS = 'Now enrolling consultancies for the pilot programme';

export const HOME_FEATURES: Card[] = [
  {
    title: 'Connect the client folder, read-only',
    body: 'Link Dropbox, Box, SharePoint/OneDrive or Google Drive, or send clients an upload link that needs no account. Files stay where they are.',
  },
  {
    title: 'Every file sorted by eSTAR section',
    body: 'Test reports, protocols, specifications, drawings and raw data are classified with the reason shown. Unclear versions are asked about, never chosen silently.',
  },
  {
    title: 'Gaps and contradictions, side by side',
    body: 'See where the IFU, specification, drawing and test reports disagree, with both source pages open, and draft the client request in one step.',
  },
  {
    title: 'Word drafts with sources in the margin',
    body: 'Evidence-heavy sections arrive in Word with a comment naming the file, version and page behind each statement. Statements without a source are removed.',
  },
];

export const STEPS: Card[] = [
  { title: 'Connect', body: 'Link the client project folder, share an upload link, or forward email attachments to the project address.' },
  { title: 'Read and sort', body: 'Every file is read with its page, sheet or slide locations, versioned, and mapped to an eSTAR section with the reason shown.' },
  { title: 'Find problems', body: 'Missing items and conflicting values are listed with both sources, and a client request is drafted for your approval.' },
  { title: 'Draft', body: 'Sections and summary tables are drafted in Word, each statement linked to the file, version and page it came from.' },
  { title: 'You decide and file', body: 'You review in Word, your edits come back as human-approved, and you fill and file the eSTAR yourself.' },
];

export const PRINCIPLES: Card[] = [
  { title: 'Every fact shows its source', body: 'File, version and page for client documents; record and date for FDA data. A statement without a source is removed.' },
  { title: 'The consultant decides', body: 'Nothing goes to a client without your approval. Versions are never chosen silently. Your edits are recorded as yours.' },
  { title: 'We never file or sign', body: 'You fill and file the eSTAR. Signature fields on administrative documents stay blank.' },
  { title: 'No new system of record', body: 'Files stay in your Dropbox, Box, SharePoint or Drive. Word out. Dated PDF records into your eQMS.' },
  { title: 'Client data stays with the client', body: 'Strict separation between clients, no AI training on your data, and deletion per project.' },
];

export const CAPABILITIES: Capability[] = [
  {
    title: 'Intake from where files already live',
    body: 'Start from the client folder rather than a new place to store documents.',
    points: [
      'Read-only connections to Dropbox, Box, SharePoint/OneDrive and Google Drive',
      'Client upload links with no account, plus a per-project forwarding address',
      'Read-only scope explained in plain words before you connect',
    ],
  },
  {
    title: 'Read, sort and version every file',
    body: 'Word, Excel, PowerPoint, PDF, scans, CSV and drawings are read with their locations kept.',
    points: [
      'Document type and eSTAR section for each file, with the reason',
      'Duplicates and version chains detected; unclear cases are asked about',
      'Drawing title blocks read for part number and revision',
      'Unreadable or password-protected files listed with the reason, never skipped',
    ],
  },
  {
    title: 'Gaps and contradictions',
    body: 'The checks consultants run by hand, run across every current file.',
    points: [
      'Device name, model, dimensions, materials, sterilisation method, shelf life',
      'Standard and edition, sample size, result against acceptance criterion',
      'Both sources shown with file, version and page',
      'Resolve, accept with a reason, or add to a client request',
    ],
  },
  {
    title: 'Client requests',
    body: 'Turn missing items into a request the client can answer without training.',
    points: [
      'Request drafted from the open gaps; you edit and approve every message',
      'Expiring upload link, no login for the client',
      'Status tracked until each item is received; uploads land in the right section',
    ],
  },
  {
    title: 'Drafting in Word, with sources',
    body: 'Evidence-heavy eSTAR sections drafted from the client’s own reports.',
    points: [
      'Sterilisation and shelf life, biocompatibility and performance testing sections',
      'Summary tables with values matched exactly to the source',
      'A Word comment on each statement naming its file, version and page',
      'Re-import your edited document; your changes are kept as human-approved',
    ],
  },
  {
    title: 'Revision impact, readiness and records',
    body: 'Keep the submission consistent as clients send new versions.',
    points: [
      'A new file version lists every statement, finding and table cell that cited the old one',
      'Attachment checks for file-name length, size limits and formats',
      'Dated PDF/DOCX project records you file in any eQMS by hand',
    ],
  },
];

export const SECURITY_SECTIONS: Capability[] = [
  {
    title: 'Read-only access, registers not repositories',
    body: 'We connect read-only to the folder you choose and do not become another place your files live.',
    points: [
      'Least-privilege, read-only connector scopes, revocable by you or your firm admin',
      'Linked files are fetched for processing and the fetched copy is deleted afterwards',
      'We keep extracted text, page locations and file fingerprints so every statement can cite its source',
    ],
  },
  {
    title: 'Strict separation between clients',
    body: 'Each firm and each client workspace is isolated.',
    points: [
      'Row-level security on every tenant table, including search indexes',
      'Per-tenant storage locations and encryption keys',
      'Client content never crosses firms and is never used for another client',
    ],
  },
  {
    title: 'AI that stays under control',
    body: 'Our default is our own self-hosted open-source models, so client content does not go to a third-party AI provider.',
    points: [
      'No training on your data; data use for product improvement is off by default',
      'Client documents are treated as untrusted input: instructions inside a file never change system behaviour',
      'Documents are converted in an isolated sandbox with no network access',
      'If your firm chooses to use its own model provider, that is an explicit, per-firm setting',
    ],
  },
  {
    title: 'Deletion, privacy and assurance',
    body: 'Built so your quality and IT owner can assess it without an integration project.',
    points: [
      'Delete a project’s data in one action, with a deletion certificate on request',
      'No protected health information by design; uploads are checked for likely PHI with a warning',
      'Free validation pack and data-handling pack, updated with each release',
      'Security review and SOC 2 readiness work are part of the pilot plan',
    ],
  },
];

export const PILOT_STEPS: Card[] = [
  { title: 'Agree the baseline', body: 'Record the hours your team spent on two or three past 510(k)s by activity, so results are measured against your own work.' },
  { title: 'Run two live 510(k)s', body: 'Use MedexRegAI on two live projects, from client folder to Word drafts, with one-click time capture.' },
  { title: 'Review the result together', body: 'Hours by activity compared with your baseline, plus draft acceptance, in a pilot report your RA lead signs off.' },
];

export const PILOT_FIRM_PROVIDES: string[] = [
  'An RA lead who reviews drafts and findings',
  'Your quality or IT owner to review the validation and data-handling packs',
  'Two live 510(k) projects, and baseline hours from past projects',
];

export const PILOT_FIRM_RECEIVES: string[] = [
  'The validation pack and data-handling pack, free',
  'A contract clause you can give your own clients',
  'A measured pilot report based on your own baseline',
  'Direct input into what is built next',
];

export const FAQS: Faq[] = [
  {
    question: 'Does MedexRegAI file submissions with FDA?',
    answer: 'No. MedexRegAI never files with FDA and never signs anything. You fill and file the eSTAR, as you do today. Signature fields on generated administrative documents are left blank.',
  },
  {
    question: 'Do my clients need an account?',
    answer: 'No. Clients receive a request list and upload through an expiring, single-project link. They need no account, login or training.',
  },
  {
    question: 'Which file stores can it read from?',
    answer: 'Dropbox, Box, SharePoint/OneDrive and Google Drive, read-only. Clients can also use an upload link, and attachments can be forwarded to a per-project email address.',
  },
  {
    question: 'Is my clients’ data used to train AI models?',
    answer: 'No. Client data is never used to train models and never crosses between firms or clients. By default, processing runs on our own self-hosted models.',
  },
  {
    question: 'Do I have to change how I review drafts?',
    answer: 'No. Drafts arrive in Word with sources in comments. You edit as usual and re-import the document; your edits are recorded as human-approved text.',
  },
  {
    question: 'Does it replace our eQMS or document control?',
    answer: 'No. MedexRegAI is not a system of record. It produces dated PDF and DOCX records that you file in TrackWise or any other eQMS by hand. No eQMS integration is required.',
  },
  {
    question: 'Does the tool need validation under our quality system?',
    answer: 'Your firm decides. To make that assessment practical, a validation pack (intended use, risk assessment template, test evidence, release notes and model change log) is included free.',
  },
  {
    question: 'What happens when a client sends a new version of a file?',
    answer: 'The new version is detected, and you see every sorted item, finding, drafted statement and table cell that cited the old one. Nothing is re-drafted until you choose.',
  },
  {
    question: 'Can I delete a project’s data?',
    answer: 'Yes. A project’s extracted text, images, facts, drafts and search indexes can be deleted in one action, with a deletion certificate on request.',
  },
  {
    question: 'How much does it cost?',
    answer: 'Terms for the pilot programme are agreed with each pilot firm. Published plans will follow once the pilot has measured the results.',
  },
];
