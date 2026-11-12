import { dataService } from '../services/DataService';
import { AppError, ErrorCodes } from '../utils/AppError';
import { applyCitationGate, CitationRef, GateResult, refKey, Resolution, SourceResolver } from './gate';

/**
 * Resolves citations against the project's own sources and records every gate run.
 *  [C:<file_version_id>#<location ordinal>]  a passage of a client file in THIS project
 *  [R:<record>#<passage>]                    an FDA record passage (510(k) summary text arrives with F1.2)
 */

/** Longest run of passages one citation may cover (a retrieved chunk spans a few). */
const MAX_RANGE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface LocationRow {
  version_id: string;
  ordinal: number;
  page: number | null;
  sheet: string | null;
  cell_range: string | null;
  slide: number | null;
  section_path: string | null;
  text: string;
  name: string;
  version_no: number;
  superseded: boolean;
}

function where(r: LocationRow): string {
  if (r.sheet && r.cell_range) return `sheet ${r.sheet}, ${r.cell_range}`;
  if (r.slide) return `slide ${r.slide}`;
  if (r.page) return `page ${r.page}`;
  return r.section_path ?? `passage ${r.ordinal}`;
}

export class ProjectSourceResolver implements SourceResolver {
  constructor(
    private readonly orgId: string,
    private readonly projectId: string,
  ) {}

  async resolve(refs: CitationRef[]): Promise<Map<string, Resolution>> {
    const out = new Map<string, Resolution>();
    const client = refs.filter((r) => r.kind === 'C');
    for (const r of refs.filter((x) => x.kind === 'R')) {
      out.set(refKey(r), { error: 'FDA passages cannot be cited yet (510(k) summary text is not loaded)' });
    }
    // "#3" is one passage; "#3-7" a run of passages (a retrieved chunk), at most MAX_RANGE long.
    const span = (r: CitationRef): [number, number] | null => {
      const m = /^(\d{1,7})(?:-(\d{1,7}))?$/.exec(r.locator);
      if (!m) return null;
      const lo = Number(m[1]);
      const hi = m[2] === undefined ? lo : Number(m[2]);
      return hi >= lo && hi - lo < MAX_RANGE ? [lo, hi] : null;
    };
    const valid = client.filter((r) => UUID.test(r.source) && span(r));
    for (const r of client.filter((x) => !valid.includes(x))) out.set(refKey(r), { error: 'malformed citation' });
    if (valid.length) {
      // Only passages of files in THIS project count: a citation to another project or firm resolves to nothing.
      const rows = await dataService.query<LocationRow & { ref: number }>(
        { orgId: this.orgId },
        'source_locations',
        `SELECT want.ref, v.id AS version_id, l.ordinal, l.page, l.sheet, l.cell_range, l.slide, l.section_path, l.text, f.name, v.version_no,
                (f.current_version_id IS NOT NULL AND f.current_version_id <> v.id) AS superseded
           FROM unnest($3::uuid[], $4::int[], $5::int[]) WITH ORDINALITY AS want(version_id, lo, hi, ref)
           JOIN source_locations l ON l.file_version_id = want.version_id AND l.ordinal BETWEEN want.lo AND want.hi AND l.org_id = $1
           JOIN file_versions v ON v.id = l.file_version_id AND v.org_id = $1
           JOIN files f ON f.id = v.file_id AND f.org_id = $1
          WHERE f.project_id = $2 AND f.status = 'active'
          ORDER BY want.ref, l.ordinal`,
        [this.orgId, this.projectId, valid.map((r) => r.source), valid.map((r) => span(r)![0]), valid.map((r) => span(r)![1])],
      );
      valid.forEach((r, i) => {
        const [lo, hi] = span(r)!;
        const parts = rows.filter((row) => Number(row.ref) === i + 1);
        // Every passage of the range must exist, or the citation does not resolve.
        if (parts.length !== hi - lo + 1) {
          out.set(refKey(r), { error: 'no such passage in this project' });
          return;
        }
        const first = parts[0];
        const label = `${first.name} v${first.version_no}, ${where(first)}${parts.length > 1 ? ` to ${where(parts[parts.length - 1])}` : ''}`;
        out.set(refKey(r), { text: parts.map((p) => p.text).join('\n'), label, superseded: first.superseded });
      });
    }
    return out;
  }
}

export interface GateRun extends GateResult {
  runId: string;
}

/** Run the gate over generated text for a project and log the run. The gate has no off switch. */
export async function runCitationGate(input: {
  orgId: string;
  userId?: string;
  projectId: string;
  route: string;
  text: string;
  /** Drafts: every statement must cite a source (see GateOptions). */
  everyStatement?: boolean;
}): Promise<GateRun> {
  const [project] = await dataService.query<{ id: string }>({ orgId: input.orgId }, 'projects', 'SELECT id FROM projects WHERE id = $1 AND org_id = $2', [
    input.projectId,
    input.orgId,
  ]);
  if (!project) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
  const result = await applyCitationGate(input.text, new ProjectSourceResolver(input.orgId, input.projectId), { everyStatement: input.everyStatement });
  const [row] = await dataService.query<{ id: string }>(
    { orgId: input.orgId, userId: input.userId },
    'citation_gate_runs',
    `INSERT INTO citation_gate_runs (org_id, project_id, route, sentences, kept, removed, refused, removed_items, warnings, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10) RETURNING id`,
    [
      input.orgId,
      input.projectId,
      input.route,
      result.stats.sentences,
      result.stats.kept,
      result.stats.removed,
      result.refused,
      JSON.stringify(result.removed),
      JSON.stringify(result.warnings),
      input.userId ?? null,
    ],
  );
  return { ...result, runId: row.id };
}
