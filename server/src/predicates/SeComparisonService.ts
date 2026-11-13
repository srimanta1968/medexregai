import { fda } from '../fda/fdaService';
import { hybridSearch } from '../retrieval/search';
import { dataService } from '../services/DataService';
import { AppError, ErrorCodes } from '../utils/AppError';
import { decodeCursor, Page, toPage } from '../utils/pagination';

/**
 * F5.2 substantial-equivalence (SE) comparison table builder (UI 2.0 §7.2).
 *
 * Rows come from three kinds of source, every cell cited:
 *  - structured FDA records (product code, device class, regulation number) for the predicate,
 *    and the subject device's record in MedexRegAI: compared deterministically (same/different);
 *  - text attributes (indications for use, technology, materials, sterilization, shelf life,
 *    biocompatibility, performance testing): the subject cell is the best passage in the client's
 *    own files ([C:<version>#<location>]), the predicate cell the best passage of its public
 *    510(k) summary ([R:<K-number>#<passage>]). Text rows are always 'review': MedexRegAI never
 *    decides substantial equivalence; the consultant sets each comparison.
 * A cell with no source says so and stays empty. Consultant edits are kept and marked.
 */

export type Comparison = 'same' | 'different' | 'review';

export interface Citation {
  marker: string | null;
  label: string;
}

export interface Cell {
  text: string;
  citations: Citation[];
}

export interface SeRow {
  key: string;
  attribute: string;
  subject: Cell;
  predicate: Cell;
  comparison: Comparison;
  note: string | null;
  edited: boolean;
}

export interface SeComparison {
  id: string;
  projectId: string;
  predicateKNumber: string;
  predicateDeviceName: string | null;
  predicateApplicant: string | null;
  rows: SeRow[];
  counts: { rows: number; same: number; different: number; review: number; edited: number };
  builtAt: string;
  updatedAt: string;
}

const TEXT_ROWS: { key: string; attribute: string; query: string }[] = [
  { key: 'indications', attribute: 'Indications for use', query: 'indications for use intended use' },
  { key: 'technology', attribute: 'Technology and principle of operation', query: 'device description principle of operation technological characteristics' },
  { key: 'materials', attribute: 'Materials', query: 'materials patient-contacting components' },
  { key: 'sterilization', attribute: 'Sterilization', query: 'sterilization method ethylene oxide gamma sterility assurance level' },
  { key: 'shelf_life', attribute: 'Shelf life', query: 'shelf life expiration ageing' },
  { key: 'biocompatibility', attribute: 'Biocompatibility', query: 'biocompatibility ISO 10993 cytotoxicity sensitization irritation' },
  { key: 'performance', attribute: 'Performance testing', query: 'performance testing bench testing results' },
];

const EXCERPT = 600;
const excerpt = (t: string): string => {
  const flat = t.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT ? `${flat.slice(0, EXCERPT - 3).trimEnd()}...` : flat;
};
const empty = (): Cell => ({ text: '', citations: [] });
/** FDA writes device class as 1, 2, 3 (and f/U/N for special cases); the app stores I, II, III. */
const ROMAN: Record<string, string> = { '1': 'I', '2': 'II', '3': 'III' };
export const deviceClass = (v: string | null | undefined): string | null => (v ? (ROMAN[v.trim()] ?? v.trim().toUpperCase()) : null);

function counts(rows: SeRow[]): SeComparison['counts'] {
  return {
    rows: rows.length,
    same: rows.filter((r) => r.comparison === 'same').length,
    different: rows.filter((r) => r.comparison === 'different').length,
    review: rows.filter((r) => r.comparison === 'review').length,
    edited: rows.filter((r) => r.edited).length,
  };
}

interface Row {
  id: string;
  project_id: string;
  predicate_k_number: string;
  predicate_device_name: string | null;
  predicate_applicant: string | null;
  rows: SeRow[];
  built_at: Date;
  updated_at: Date;
}

const view = (r: Row): SeComparison => ({
  id: r.id,
  projectId: r.project_id,
  predicateKNumber: r.predicate_k_number,
  predicateDeviceName: r.predicate_device_name,
  predicateApplicant: r.predicate_applicant,
  rows: r.rows,
  counts: counts(r.rows),
  builtAt: r.built_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

const COLS = 'id, project_id, predicate_k_number, predicate_device_name, predicate_applicant, rows, built_at, updated_at';

async function subjectCell(orgId: string, projectId: string, query: string): Promise<Cell> {
  try {
    const r = await hybridSearch({ orgId, projectId, query, limit: 1 });
    const h = r.items[0];
    if (!h) return empty();
    return { text: excerpt(h.text), citations: [{ marker: h.citation, label: `${h.fileName} v${h.versionNo}, ${h.where}` }] };
  } catch (err) {
    console.warn(`[se] subject search failed: ${(err as Error).message}`);
    return empty();
  }
}

async function predicateCell(kNumber: string, query: string): Promise<Cell> {
  try {
    const r = await fda((c) => c.searchSummaries({ q: query, kNumber, limit: 1 }));
    const h = r.hits[0];
    if (!h) return empty();
    return { text: excerpt(h.text), citations: [{ marker: `[R:${h.ref}]`, label: `${kNumber} 510(k) summary${h.page ? `, page ${h.page}` : ''}` }] };
  } catch (err) {
    console.warn(`[se] predicate summary search failed: ${(err as Error).message}`);
    return empty();
  }
}

/** Build the rows for a subject project and a predicate K-number (no storage). */
export async function buildRows(orgId: string, projectId: string, kNumber: string): Promise<{ rows: SeRow[]; deviceName: string | null; applicant: string | null }> {
  const [device] = await dataService.query<{ name: string; product_code: string | null; device_class: string | null }>(
    { orgId },
    'projects',
    'SELECT d.name, d.product_code, d.device_class FROM projects p JOIN devices d ON d.id = p.device_id AND d.org_id = p.org_id WHERE p.id = $1 AND p.org_id = $2',
    [projectId, orgId],
  );
  if (!device) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
  const clearance = await fda((c) => c.getClearance(kNumber));
  const classification = clearance.productCode ? await fda((c) => c.getProductCode(clearance.productCode!)).catch(() => null) : null;
  const subjectClassification = device.product_code
    ? device.product_code === clearance.productCode
      ? classification
      : await fda((c) => c.getProductCode(device.product_code!)).catch(() => null)
    : null;

  const record = (v: string | null): Cell => (v ? { text: v, citations: [{ marker: null, label: `FDA 510(k) database, ${kNumber}` }] } : empty());
  const classRecord = (v: string | null, code: string | null): Cell =>
    v ? { text: v, citations: [{ marker: null, label: `FDA product classification database, product code ${code}` }] } : empty();
  const deviceRecord = (v: string | null): Cell => (v ? { text: v, citations: [{ marker: null, label: `Subject device record in MedexRegAI (${device.name})` }] } : empty());
  const cmp = (a: string | null, b: string | null): Comparison => (a && b ? (a.trim().toUpperCase() === b.trim().toUpperCase() ? 'same' : 'different') : 'review');

  const subjectRegulation = subjectClassification?.regulationNumber ?? null;
  const predicateRegulation = clearance.regulationNumber ?? classification?.regulationNumber ?? null;
  const rows: SeRow[] = [
    {
      key: 'product_code',
      attribute: 'Product code',
      subject: deviceRecord(device.product_code),
      predicate: record(clearance.productCode),
      comparison: cmp(device.product_code, clearance.productCode),
      note: device.product_code ? null : 'Set the product code on the subject device.',
      edited: false,
    },
    {
      key: 'device_class',
      attribute: 'Device class',
      subject: deviceRecord(device.device_class),
      predicate: record(deviceClass(clearance.deviceClass ?? classification?.deviceClass)),
      comparison: cmp(deviceClass(device.device_class), deviceClass(clearance.deviceClass ?? classification?.deviceClass)),
      note: null,
      edited: false,
    },
    {
      key: 'regulation',
      attribute: 'Regulation number',
      subject: classRecord(subjectRegulation, device.product_code),
      predicate: clearance.regulationNumber ? record(clearance.regulationNumber) : classRecord(predicateRegulation, clearance.productCode),
      comparison: cmp(subjectRegulation, predicateRegulation),
      note: null,
      edited: false,
    },
  ];
  const cells = await Promise.all(TEXT_ROWS.map(async (t) => ({ t, subject: await subjectCell(orgId, projectId, t.query), predicate: await predicateCell(kNumber, t.query) })));
  for (const { t, subject, predicate } of cells) {
    const missing = [!subject.text && 'not found in the client files', !predicate.text && "not found in the predicate's indexed 510(k) summary"].filter(Boolean);
    rows.push({ key: t.key, attribute: t.attribute, subject, predicate, comparison: 'review', note: missing.length ? `${missing.join('; ')}.` : null, edited: false });
  }
  return { rows, deviceName: clearance.deviceName, applicant: clearance.applicant };
}

export const seComparisonService = {
  /** Comparisons of a project, newest first, cursor-paged on (created_at, id). */
  async list(orgId: string, projectId: string, opts: { limit: number; cursor?: string }): Promise<Page<SeComparison>> {
    const [p] = await dataService.query<{ id: string }>({ orgId }, 'projects', 'SELECT id FROM projects WHERE id = $1 AND org_id = $2', [projectId, orgId]);
    if (!p) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
    const c = decodeCursor(opts.cursor);
    const rows = await dataService.query<Row & { id: string; created_at: Date }>(
      { orgId },
      'se_comparisons',
      `SELECT ${COLS}, created_at FROM se_comparisons WHERE org_id = $1 AND project_id = $2
          AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
        ORDER BY created_at DESC, id DESC LIMIT $5`,
      [orgId, projectId, c.createdAt, c.id, opts.limit + 1],
    );
    return toPage<Row & { id: string; created_at: Date }, SeComparison>(rows, opts.limit, (r) => view(r));
  },

  async get(orgId: string, id: string): Promise<SeComparison> {
    const [r] = await dataService.query<Row>({ orgId }, 'se_comparisons', `SELECT ${COLS} FROM se_comparisons WHERE id = $1 AND org_id = $2`, [id, orgId]);
    if (!r) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Comparison not found');
    return view(r);
  },

  /** Build and save a comparison against a predicate (409 when one exists; rebuild it instead). */
  async create(orgId: string, userId: string, projectId: string, kNumber: string): Promise<SeComparison> {
    const [p] = await dataService.query<{ workspace_id: string }>({ orgId }, 'projects', 'SELECT workspace_id FROM projects WHERE id = $1 AND org_id = $2', [projectId, orgId]);
    if (!p) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
    const [existing] = await dataService.query<{ id: string }>(
      { orgId },
      'se_comparisons',
      'SELECT id FROM se_comparisons WHERE org_id = $1 AND project_id = $2 AND predicate_k_number = $3',
      [orgId, projectId, kNumber],
    );
    if (existing) {
      throw new AppError(409, ErrorCodes.COMPARISON_EXISTS, `This project already has a comparison with ${kNumber}`, [{ field: 'kNumber', message: existing.id }]);
    }
    const built = await buildRows(orgId, projectId, kNumber);
    try {
      const [r] = await dataService.query<Row>(
        { orgId },
        'se_comparisons',
        `INSERT INTO se_comparisons (org_id, workspace_id, project_id, predicate_k_number, predicate_device_name, predicate_applicant, rows, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING ${COLS}`,
        [orgId, p.workspace_id, projectId, kNumber, built.deviceName?.slice(0, 300) ?? null, built.applicant?.slice(0, 300) ?? null, JSON.stringify(built.rows), userId],
      );
      return view(r);
    } catch (err) {
      if ((err as { constraint?: string }).constraint === 'se_comparisons_predicate_uq') {
        throw new AppError(409, ErrorCodes.COMPARISON_EXISTS, `This project already has a comparison with ${kNumber}`);
      }
      throw err;
    }
  },

  /** Rebuild from the sources; rows the consultant edited are kept as they are. */
  async rebuild(orgId: string, id: string): Promise<SeComparison> {
    const cur = await this.get(orgId, id);
    const built = await buildRows(orgId, cur.projectId, cur.predicateKNumber);
    const kept = new Map(cur.rows.filter((r: SeRow) => r.edited).map((r: SeRow) => [r.key, r]));
    const rows = built.rows.map((r) => kept.get(r.key) ?? r);
    await dataService.query({ orgId }, 'se_comparisons', 'UPDATE se_comparisons SET rows = $3::jsonb, built_at = now(), updated_at = now() WHERE id = $1 AND org_id = $2', [
      id,
      orgId,
      JSON.stringify(rows),
    ]);
    return this.get(orgId, id);
  },

  /** The consultant's edit of one row: the texts, the comparison or a note. */
  async updateRow(
    orgId: string,
    id: string,
    key: string,
    patch: { subjectText?: string; predicateText?: string; comparison?: Comparison; note?: string | null },
  ): Promise<SeComparison> {
    const cur: SeComparison = await this.get(orgId, id);
    const i = cur.rows.findIndex((r) => r.key === key);
    if (i < 0) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Row not found');
    const r = { ...cur.rows[i] };
    // Edited text keeps its citations: the consultant is responsible for keeping them true.
    if (patch.subjectText !== undefined) r.subject = { ...r.subject, text: patch.subjectText };
    if (patch.predicateText !== undefined) r.predicate = { ...r.predicate, text: patch.predicateText };
    if (patch.comparison !== undefined) r.comparison = patch.comparison;
    if (patch.note !== undefined) r.note = patch.note;
    r.edited = true;
    const rows = cur.rows.map((x, k) => (k === i ? r : x));
    await dataService.query({ orgId }, 'se_comparisons', 'UPDATE se_comparisons SET rows = $3::jsonb, updated_at = now() WHERE id = $1 AND org_id = $2', [id, orgId, JSON.stringify(rows)]);
    return this.get(orgId, id);
  },

  async remove(orgId: string, id: string): Promise<void> {
    await this.get(orgId, id);
    await dataService.query({ orgId }, 'se_comparisons', 'DELETE FROM se_comparisons WHERE id = $1 AND org_id = $2', [id, orgId]);
  },
};
