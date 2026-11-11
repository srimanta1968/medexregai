import type { Block } from './pdf';

/**
 * Trust pack content (F2.5, PRD v2.0 FR-14.16 validation pack, FR-14.17 data-handling
 * pack, NFR-8, NFR-14). Everything here must describe what the product does in this
 * build. A control that is not built yet is marked "Planned" with the feature that
 * brings it; nothing is claimed for a later release. Facts that differ per firm or
 * per deployment (models, providers, storage, settings, scores) come from the
 * PackContext, not from this text.
 */

export const PACK_CONTENT_VERSION = '2026-11-11.1';

export interface DataUseState {
  /** Never: client content is not used to train any model. Not a setting (NFR-8). */
  aiTraining: 'never';
  productImprovement: boolean;
  updatedAt: string | null;
  updatedByName: string | null;
}

export interface FirmProviderInfo {
  name: string;
  kind: 'openai_compatible' | 'anthropic';
  model: string;
  host: string;
  testStatus: string;
  evalStatus: string;
  routes: string[];
}

export interface PlatformEvalInfo {
  status: string;
  provider: string | null;
  model: string | null;
  finishedAt: string | null;
  scores: Record<string, Record<string, unknown> | undefined>;
  thresholds: Record<string, number | undefined>;
}

export interface PackContext {
  firmName: string;
  generatedAt: Date;
  release: string;
  production: boolean;
  hostingRegion: string;
  storageDriver: string;
  mailTransport: string;
  deletionDays: number;
  backupRetentionDays: number;
  dataUse: DataUseState;
  platformAi: { provider: string; generationModel: string; embeddingModel: string };
  firmProviders: FirmProviderInfo[];
  versions: { registry: string; outputChecks: string; evalSets: string; packContent: string; prompts: Record<string, string> };
  platformEval: PlatformEvalInfo | null;
}

export const PACKS = {
  validation: {
    key: 'validation',
    title: 'Validation pack',
    fileName: 'medexregai-validation-pack.pdf',
    summary: 'Intended use, a pre-filled risk assessment template, test evidence for this release, release notes and the AI model change log.',
  },
  'data-handling': {
    key: 'data-handling',
    title: 'Data-handling pack',
    fileName: 'medexregai-data-handling-pack.pdf',
    summary: 'Where data goes, subprocessors, AI and your data, retention, deletion and the clause you can give your clients.',
  },
} as const;
export type PackKey = keyof typeof PACKS;

const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
const pct = (v: unknown) => (typeof v === 'number' ? `${Math.round(v * 1000) / 10}%` : 'not scored');

/** What this build contains, in the words a quality owner reads (newest first). */
export const RELEASE_NOTES: { feature: string; note: string }[] = [
  { feature: 'F2.5', note: 'Trust pack: these packs, the client clause, firm data-use settings and per-project deletion with a certificate.' },
  {
    feature: 'F2.4',
    note: 'Client requests: the consultant drafts, edits and approves a request; the client uploads through an expiring, revocable link without an account. Uploads are type-checked and malware-scanned.',
  },
  {
    feature: 'F7.5',
    note: 'Prompt-injection defence: document text reaches models only inside fenced data blocks, hidden characters are stripped, outputs are schema-checked, and instruction-like text in a file is flagged to the consultant.',
  },
  { feature: 'F7.4', note: 'Model evaluation harness and gold sets; a firm model must pass it before it can draft.' },
  { feature: 'F7.3', note: 'Search with citations, and the citation gate that removes any drafted sentence no client passage supports.' },
  {
    feature: 'F7.2',
    note: 'File intake: versions with SHA-256 fingerprints, text and page locations from Word, Excel, PowerPoint, PDF and CSV, likely-PHI warning.',
  },
  { feature: 'F7.1', note: 'AI routing to our self-hosted models by default, per-firm own model with an encrypted, write-only key, metering and cost alerts.' },
  { feature: 'F1.1-F1.5', note: 'FDA public data: 510(k), classification, recall and UDI lookups from FDA sources.' },
  { feature: 'F0.1-F0.5', note: 'Firms, users and roles; clients, devices and projects; hash-chained audit log; configuration; public website.' },
];

type Status = 'In this release' | string;
const RISKS: { risk: string; control: string; status: Status }[] = [
  {
    risk: 'A drafted statement is wrong or not supported by the client evidence.',
    control:
      'Every factual sentence must cite a client passage; the citation gate removes sentences with no supporting passage and checks quoted values against the source. The consultant reviews and approves every section; nothing is filed by the tool.',
    status: 'Citation gate: in this release. Drafting screens: planned (E3).',
  },
  {
    risk: 'Text inside a client file changes what the tool does (prompt injection).',
    control:
      'Document text is passed only inside fenced data blocks; AI steps on documents have no tools; outputs are checked against a strict schema and rejected if they cite unknown passages, contain links or leak the prompt. Instruction-like text is flagged on the file.',
    status: 'In this release',
  },
  {
    risk: 'A file is sorted into the wrong eSTAR section.',
    control: 'Each file shows its section with a confidence and a reason; the consultant can reassign it.',
    status: 'Planned (F2.2)',
  },
  {
    risk: 'A contradiction or missing item in the client evidence is not found.',
    control: 'Structured values are compared deterministically; the model is used only for free-text pairs. The consultant remains responsible for review.',
    status: 'Planned (F2.3)',
  },
  {
    risk: 'An out-of-date version of a client file is used.',
    control: 'Every file version is fingerprinted (SHA-256) and kept; when the current version is unclear the consultant is asked.',
    status: 'Fingerprints: in this release. Version question: planned (F2.2).',
  },
  {
    risk: 'The AI model changes between releases and behaves differently.',
    control:
      'Models, prompt templates and output checks are versioned and recorded with every AI call; the evaluation harness is the release gate; the change log in this pack lists the versions.',
    status: 'In this release',
  },
  {
    risk: "A firm's own model performs worse than ours.",
    control: 'It must pass a connection test before use and the full evaluation before it may draft.',
    status: 'In this release',
  },
  {
    risk: "One client's data is seen by another client or firm.",
    control:
      'Every query is scoped to the firm and checked against a table catalogue; client upload links reach one request only. Database row-level security policies add a second layer.',
    status: 'Query scoping: in this release. Row-level security: planned (F8.1).',
  },
  {
    risk: 'A client uploads a malicious or unexpected file.',
    control:
      'File type is checked against the file contents, size and count are limited, and every upload is malware-scanned; in production an upload is refused if the scanner is unavailable.',
    status: 'In this release',
  },
  {
    risk: 'Protected health information is uploaded.',
    control: 'Uploads are scanned for likely PHI and the consultant is warned and asked to redact. The product is not designed to hold PHI.',
    status: 'In this release',
  },
  {
    risk: 'Project data is kept after the engagement ends.',
    control: 'A firm owner or admin can delete a project with one action and receive a deletion certificate.',
    status: 'In this release',
  },
  {
    risk: 'It cannot be shown who did what and when.',
    control: 'Actions are written to an append-only, hash-chained audit log; altering or removing a row breaks the chain.',
    status: 'In this release',
  },
];

function aiProviderLabel(provider: string): string {
  if (provider === 'anthropic') return 'Claude API (Anthropic), configured by us';
  return 'our own model server (self-hosted, open-weight models)';
}

export function validationPackBlocks(c: PackContext): Block[] {
  const dev = c.release === 'development build';
  const b: Block[] = [
    { kind: 'title', text: 'MedexRegAI validation pack' },
    { kind: 'subtitle', text: `Prepared for ${c.firmName} | Release: ${c.release} | Generated ${day(c.generatedAt)}` },
    {
      kind: 'p',
      text: "This pack gives your quality owner what they need to make their own risk-based assessment of MedexRegAI under your quality system. Whether and how the tool is assessed is your firm's decision. The pack is free and is regenerated with every release.",
    },
  ];
  if (dev)
    b.push({
      kind: 'note',
      text: 'This copy was generated from a development build, not a published release. Use it to review the structure; assess the tool on the pack generated from the release you will use.',
    });

  b.push(
    { kind: 'h2', text: '1. Intended use' },
    {
      kind: 'p',
      text: 'MedexRegAI helps a 510(k) consultant turn the files a client sends (test reports, protocols, raw data, specifications and drawings in Word, Excel, PowerPoint and PDF) into eSTAR-ready submission sections. It sorts files into sections, flags gaps and contradictions, and drafts section text in which every statement cites a source page. The consultant reviews and approves everything.',
    },
    { kind: 'h3', text: 'Intended users' },
    { kind: 'p', text: 'Regulatory consultants and their colleagues at the firm. Clients of the firm only upload files through a link the consultant sends.' },
    { kind: 'h3', text: 'Not intended for' },
    {
      kind: 'bullets',
      items: [
        'Regulatory decisions: substantial equivalence, which testing is needed, or whether a submission is ready.',
        'Filing or signing. The consultant files and signs; MedexRegAI never does.',
        "Replacing the firm's or the manufacturer's eQMS, document control or other systems.",
        'Holding protected health information.',
        'Analysing raw data beyond describing its structure.',
      ],
    },

    { kind: 'h2', text: '2. Risk assessment template (pre-filled)' },
    {
      kind: 'p',
      text: 'Each row names a risk in using the tool and how the product controls it. "In this release" means the control is built and in use; "Planned" names the feature that brings it. Record your own severity, likelihood and decision in the last column. Add risks specific to your use.',
    },
    {
      kind: 'table',
      columns: [
        { label: 'Risk', width: 2.2 },
        { label: 'How the product controls it', width: 3.6 },
        { label: 'Status', width: 1.6 },
        { label: 'Your assessment', width: 1.6 },
      ],
      rows: RISKS.map((r) => [r.risk, r.control, r.status, '']),
    },

    { kind: 'h2', text: '3. Test evidence for this release' },
    { kind: 'h3', text: 'Model evaluation' },
    {
      kind: 'p',
      text: "AI outputs are scored against fixed gold sets built from a fictional submission package (no client data), through the product's own prompts, output checks and citation gate. A model that misses a target does not pass.",
    },
  );

  const e = c.platformEval;
  if (!e) {
    b.push({
      kind: 'note',
      text: 'No evaluation of our platform model has been recorded for this build, so no model scores are claimed here.',
    });
  } else {
    const s = e.scores;
    b.push(
      {
        kind: 'note',
        text: `Platform model ${e.model ?? 'unknown'} (${e.provider ?? 'unknown'}), run finished ${e.finishedAt ? day(e.finishedAt) : 'not finished'}, result: ${e.status}.`,
      },
      {
        kind: 'table',
        columns: [
          { label: 'Set', width: 2 },
          { label: 'Measure', width: 2 },
          { label: 'Target', width: 1 },
          { label: 'Score', width: 1 },
        ],
        rows: [
          ['File sorting (20 files)', 'accuracy', pct(e.thresholds.classification), pct(s.classification?.accuracy)],
          ['Contradictions (10 pairs)', 'precision', pct(e.thresholds.contradiction), pct(s.contradiction?.precision)],
          ['Drafting (5 sections)', 'acceptance', pct(e.thresholds.drafting), pct(s.drafting?.acceptance)],
          ['Prompt injection (14 cases)', 'resistance', pct(e.thresholds.injection), pct(s.injection?.resistance)],
        ],
      },
    );
  }
  const evaluated = c.firmProviders.filter((p) => p.evalStatus !== 'not_run');
  if (evaluated.length)
    b.push({
      kind: 'table',
      columns: [
        { label: "Your firm's model", width: 2 },
        { label: 'Model', width: 2 },
        { label: 'Evaluation', width: 1.2 },
      ],
      rows: evaluated.map((p) => [p.name, p.model, p.evalStatus]),
    });

  b.push(
    { kind: 'h3', text: 'Automated release checks' },
    { kind: 'p', text: 'These checks are defined in the product repository and must pass before a release is published:' },
    {
      kind: 'bullets',
      items: [
        'Lint and type checks of the server and web app.',
        'Configuration tests (for example, production refuses unsafe settings such as switching off the malware scan).',
        'The prompt-injection suite: planted instructions in Word, Excel, PowerPoint, PDF and text files, parsed by the real converter; a model that obeys any of them fails the build.',
        'API tests generated from the published API definitions, including their error cases.',
        'Browser scenarios for each screen on desktop and phone widths.',
        'Model evaluation (section 3 above) when a model, prompt or output check changes.',
      ],
    },

    { kind: 'h2', text: '4. Release notes' },
    {
      kind: 'table',
      columns: [
        { label: 'Feature', width: 1 },
        { label: 'What it does', width: 6 },
      ],
      rows: RELEASE_NOTES.map((r) => [r.feature, r.note]),
    },

    { kind: 'h2', text: '5. AI model change log' },
    {
      kind: 'p',
      text: 'Each AI call records the model, the route registry version and the prompt template version, so any output can be traced to the configuration that produced it. Versions in this build:',
    },
    {
      kind: 'table',
      columns: [
        { label: 'Component', width: 3 },
        { label: 'Version', width: 3 },
      ],
      rows: [
        ['Generation model (platform)', `${c.platformAi.generationModel} on ${aiProviderLabel(c.platformAi.provider)}`],
        ['Embedding model (search, always platform)', c.platformAi.embeddingModel],
        ['AI route registry', c.versions.registry],
        ['Output checks', c.versions.outputChecks],
        ['Evaluation gold sets', c.versions.evalSets],
        ['Trust pack content', c.versions.packContent],
        ...Object.entries(c.versions.prompts).map(([route, v]) => [`Prompt template: ${route}`, v] as [string, string]),
      ],
    },
  );
  const active = c.firmProviders.filter((p) => p.routes.length > 0);
  b.push(
    active.length
      ? {
          kind: 'table',
          columns: [
            { label: "Your firm's model in use", width: 2 },
            { label: 'Model', width: 2 },
            { label: 'Used for', width: 2 },
          ],
          rows: active.map((p) => [p.name, p.model, p.routes.join(', ')]),
        }
      : { kind: 'note', text: 'Your firm uses our platform model for every AI step.' },
    { kind: 'h2', text: '6. Known limits' },
    {
      kind: 'bullets',
      items: [
        'The gold sets are small and fictional. They are a regression gate, not a measure of quality on real packages; sets from real packages follow from consultant corrections.',
        'The output checks catch answers that break format, cite passages the model was not given, quote text that is not in the source, contain links or leak the prompt. They cannot catch a manipulated answer that is still valid, such as a wrong section that is on the allowed list; consultant review and the citation gate cover that.',
        'Scanned pages and images need text recognition, which this build does not include; such files are listed as needing it rather than skipped.',
      ],
    },
  );
  return b;
}

/** The clause a firm can put in its own client agreements (FR-14.17). */
export function clientClause(firmName: string, deletionDays: number): string {
  return [
    `Use of MedexRegAI. ${firmName} uses MedexRegAI, a software service, to organise and review the documents you provide for your submission.`,
    'Your documents are processed only to provide our services to you.',
    "They are kept separate from every other client's data and are never used to train any AI model.",
    `They are not used to improve the software unless you agree in writing.`,
    'MedexRegAI is our subprocessor; its data-handling pack, which lists its own subprocessors, is available from us on request.',
    `When our engagement ends, or earlier at your request, we will delete your project data from MedexRegAI within ${deletionDays} days and can give you a deletion certificate.`,
    `${firmName} remains responsible for the content of your submission. MedexRegAI does not file or sign anything.`,
  ].join(' ');
}

export const CLAUSE_STATUS = 'Draft for your counsel to review. It has not yet been reviewed by our counsel.';

function storageText(c: PackContext): string {
  if (c.storageDriver === 'fs') return c.production ? 'Encrypted disk of our application servers' : 'Disk of the machine running this deployment';
  return 'Object storage';
}

export function dataHandlingPackBlocks(c: PackContext): Block[] {
  const where = c.production ? `Amazon Web Services, ${c.hostingRegion}` : 'this deployment';
  const b: Block[] = [
    { kind: 'title', text: 'MedexRegAI data-handling pack' },
    { kind: 'subtitle', text: `Prepared for ${c.firmName} | Release: ${c.release} | Generated ${day(c.generatedAt)}` },
    {
      kind: 'p',
      text: 'This pack says what client data MedexRegAI holds, where it goes, who processes it, how long it is kept and how it is deleted. It reflects the settings of your firm and of this deployment on the date above. Your agreement with us is the document that governs processing.',
    },
  ];
  if (!c.production)
    b.push({
      kind: 'note',
      text: `This copy was generated from a development deployment, which runs on its operator's machine. The production service runs in Amazon Web Services, ${c.hostingRegion}.`,
    });

  b.push(
    { kind: 'h2', text: '1. Summary' },
    {
      kind: 'bullets',
      items: [
        'Client content is never used to train any AI model. This is not a setting and cannot be turned on.',
        `Use of your data for product improvement: ${c.dataUse.productImprovement ? 'ON, by your firm' : 'off'} (off by default).`,
        "Each firm's data is kept separate, and each client workspace within a firm.",
        `A project's data can be deleted in one action, within ${c.deletionDays} days, with a deletion certificate.`,
        'The product is not designed to hold protected health information; uploads are checked for likely PHI with a warning.',
      ],
    },

    { kind: 'h2', text: '2. What we hold and for how long' },
    {
      kind: 'table',
      columns: [
        { label: 'Data', width: 2.6 },
        { label: 'Where', width: 2 },
        { label: 'Kept until', width: 2.4 },
      ],
      rows: [
        ['Files you or your client upload (every version)', storageText(c), 'The project is deleted'],
        ['Text, page locations and fingerprints extracted from files; search index (embeddings)', `Database (${where})`, 'The project is deleted'],
        ['Client requests, items and upload links (only a hash of each link is stored)', `Database (${where})`, 'The project is deleted'],
        ['Records of AI calls: step, model, token counts, cost (no document text)', `Database (${where})`, 'The project is deleted'],
        ['Audit log: who did what and when, as ids and small metadata, never file content', `Database (${where})`, 'The firm account is closed'],
        ['Deletion records: project, client and device names, counts, dates', `Database (${where})`, 'The firm account is closed'],
        ["Your firm's users: names, email addresses, roles", `Database (${where})`, 'The account is closed'],
        ['Database backups (all of the above)', c.production ? 'Encrypted with AWS KMS' : 'This deployment', `${c.backupRetentionDays} days, then they expire`],
      ],
    },

    { kind: 'h2', text: '3. Where data goes' },
    {
      kind: 'bullets',
      items: [
        'Files are converted to text by our own document service, which never fetches anything a file links to.',
        `AI steps run on ${aiProviderLabel(c.platformAi.provider)} unless your firm has chosen its own model for a step (section 4). A model receives only the passages needed for the step at hand, inside fenced data blocks, and has no tools.`,
        'Search embeddings are always made by our platform model, so the index never leaves our service.',
        c.mailTransport === 'log'
          ? 'Email (for example, a client request): this deployment sends no email through an outside provider. The provider will be listed here before it is used.'
          : 'Email (for example, a client request) is sent through the email provider listed in section 4.',
        'Client upload links are single-request, expiring and revocable; a client never gets an account or sees other data.',
      ],
    },

    { kind: 'h2', text: '4. Subprocessors' },
  );

  const rows: string[][] = [];
  if (c.production) rows.push(['Amazon Web Services', 'Hosting, database, storage, backups', c.hostingRegion, 'Used by us']);
  if (c.platformAi.provider === 'anthropic') rows.push(['Anthropic (Claude API)', 'AI steps; inputs are not used for training', 'United States', 'Used by us']);
  for (const p of c.firmProviders.filter((x) => x.routes.length > 0))
    rows.push([
      p.kind === 'anthropic' ? `Anthropic (Claude API), as "${p.name}"` : `${p.name} (${p.host})`,
      `AI steps: ${p.routes.join(', ')}`,
      'Under your agreement with them',
      'Chosen by your firm',
    ]);
  if (rows.length)
    b.push({
      kind: 'table',
      columns: [
        { label: 'Who', width: 2.2 },
        { label: 'What for', width: 2.4 },
        { label: 'Where', width: 1.6 },
        { label: 'Basis', width: 1.2 },
      ],
      rows,
    });
  else b.push({ kind: 'p', text: "This deployment uses no subprocessors: it runs entirely on its operator's machine and our own self-hosted models." });

  b.push(
    { kind: 'h2', text: '5. AI and your data' },
    {
      kind: 'table',
      columns: [
        { label: 'Setting', width: 3 },
        { label: 'Value', width: 3 },
      ],
      rows: [
        ['AI training on your data', 'Never (not a setting)'],
        [
          'Data use for product improvement',
          c.dataUse.productImprovement
            ? `On, turned on${c.dataUse.updatedByName ? ` by ${c.dataUse.updatedByName}` : ''}${c.dataUse.updatedAt ? ` on ${day(c.dataUse.updatedAt)}` : ''}`
            : 'Off (default)',
        ],
      ],
    },
    {
      kind: 'p',
      text: "Product-improvement use, when a firm turns it on, records the firm's consent only. Nothing in this release uses client content for product improvement; anything that would is described here before it starts.",
    },

    { kind: 'h2', text: '6. Deleting a project' },
    {
      kind: 'bullets',
      items: [
        "A firm owner or admin deletes a project from the trust pack screen by typing the project's name.",
        'The project and everything under it are removed from the database at once: files and versions, extracted text and locations, search embeddings, citation checks of drafts, client requests and links, and AI call records. Extracted facts and drafted sections, as those features arrive, are stored under the project in the same way and go with it.',
        'Stored file copies are removed by our background worker, normally within minutes.',
        `We commit to completing deletion within ${c.deletionDays} days of the request. Copies in encrypted database backups expire ${c.backupRetentionDays} days after the backup was taken.`,
        'When deletion completes, a deletion certificate is available to download. It lists what was removed and what is kept.',
        'The audit log keeps ids and dates of past actions on the project, never content. The deletion record keeps the project, client and device names so the certificate can say what was deleted.',
      ],
    },

    { kind: 'h2', text: '7. Security controls in this release' },
    {
      kind: 'bullets',
      items: [
        "Every request's permission is checked against the user's current role in the firm.",
        'Every database query is scoped to the firm and limited to catalogued tables; database row-level security is planned (F8.1).',
        "API keys for a firm's own model are encrypted (AES-256-GCM) and never returned by any API.",
        'Client upload links: random tokens of which only a hash is stored; they expire and can be withdrawn; the token is masked in access logs.',
        'Uploads are checked for file type against their contents and malware-scanned; production refuses an upload when the scanner is unavailable.',
        'Instructions inside client documents are treated as content and never change system behaviour; such text is flagged on the file.',
        'An append-only, hash-chained audit log records actions.',
      ],
    },

    { kind: 'h2', text: '8. A clause you can give your clients' },
    { kind: 'p', text: clientClause(c.firmName, c.deletionDays) },
    { kind: 'note', text: CLAUSE_STATUS },
  );
  return b;
}

export interface CertificateInput {
  firmName: string;
  deletionId: string;
  projectId: string;
  projectName: string;
  clientName: string;
  deviceName: string;
  requestedByName: string;
  requestedAt: string;
  rowsDeletedAt: string;
  completedAt: string;
  dueBy: string;
  counts: Record<string, number>;
  objectsRemoved: number;
  backupRetentionDays: number;
  release: string;
}

export const DELETION_CATEGORIES: { key: string; label: string }[] = [
  { key: 'files', label: 'Files' },
  { key: 'file_versions', label: 'File versions' },
  { key: 'source_locations', label: 'Extracted text and page locations' },
  { key: 'chunks', label: 'Search passages and their embeddings' },
  { key: 'citation_gate_runs', label: 'Citation checks of drafted text' },
  { key: 'client_requests', label: 'Client requests' },
  { key: 'client_request_items', label: 'Client request items' },
  { key: 'upload_links', label: 'Client upload links' },
  { key: 'ai_calls', label: 'AI call records' },
];

const stamp = (iso: string) => `${new Date(iso).toISOString().replace('T', ' ').slice(0, 19)} UTC`;

/** Canonical text of a certificate: its SHA-256 is the certificate's fingerprint. */
export function certificateCanonical(i: CertificateInput): string {
  return JSON.stringify({
    v: 1,
    deletionId: i.deletionId,
    firm: i.firmName,
    projectId: i.projectId,
    project: i.projectName,
    client: i.clientName,
    device: i.deviceName,
    requestedBy: i.requestedByName,
    requestedAt: i.requestedAt,
    rowsDeletedAt: i.rowsDeletedAt,
    completedAt: i.completedAt,
    counts: DELETION_CATEGORIES.map((c) => [c.key, i.counts[c.key] ?? 0]),
    objectsRemoved: i.objectsRemoved,
    backupRetentionDays: i.backupRetentionDays,
  });
}

export function certificateBlocks(i: CertificateInput, sha256: string): Block[] {
  return [
    { kind: 'title', text: 'Certificate of project data deletion' },
    { kind: 'subtitle', text: `Issued by MedexRegAI to ${i.firmName} | ${stamp(i.completedAt)}` },
    {
      kind: 'p',
      text: `This certifies that the project below, and the client data held for it in MedexRegAI, was deleted at the request of ${i.firmName}.`,
    },
    {
      kind: 'fields',
      rows: [
        ['Project', i.projectName],
        ['Client', i.clientName],
        ['Device', i.deviceName],
        ['Project id', i.projectId],
        ['Deletion id', i.deletionId],
        ['Requested by', i.requestedByName],
        ['Requested', stamp(i.requestedAt)],
        ['Database records removed', stamp(i.rowsDeletedAt)],
        ['Deletion completed', stamp(i.completedAt)],
        ['Committed deadline', stamp(i.dueBy)],
      ],
    },
    { kind: 'h2', text: 'What was removed' },
    {
      kind: 'table',
      columns: [
        { label: 'Data', width: 4 },
        { label: 'Records removed', width: 1.4 },
      ],
      rows: [...DELETION_CATEGORIES.map((c) => [c.label, String(i.counts[c.key] ?? 0)]), ['Stored file copies', String(i.objectsRemoved)]],
    },
    { kind: 'h2', text: 'What is kept' },
    {
      kind: 'bullets',
      items: [
        'The audit log keeps the ids and dates of past actions on this project. It never held file content.',
        'This deletion record keeps the project, client and device names, the counts above and the dates, so this certificate can be reissued.',
        `Database backups taken before the deletion expire ${i.backupRetentionDays} days after they were taken.`,
      ],
    },
    { kind: 'note', text: `Certificate fingerprint (SHA-256 of its canonical record): ${sha256}` },
    { kind: 'note', text: `Release ${i.release}.` },
  ];
}
