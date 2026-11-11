import { dataService } from '../services/DataService';
import { AppError, ErrorCodes } from '../utils/AppError';
import { applyCitationGate, CitationRef, GateResult, refKey, Resolution, SourceResolver } from './gate';

/**
 * Resolves citations against the project's own sources and records every gate run.
 *  [C:<file_version_id>#<location ordinal>]  a passage of a client file in THIS project
 *  [R:<record>#<passage>]                    an FDA record passage (510(k) summary text arrives with F1.2)
 */

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
    const valid = client.filter((r) => UUID.test(r.source) && /^\d{1,7}$/.test(r.locator));
    for (const r of client.filter((x) => !valid.includes(x))) out.set(refKey(r), { error: 'malformed citation' });
    if (valid.length) {
      // Only passages of files in THIS project count: a citation to another project or firm resolves to nothing.
      const rows = await dataService.query<LocationRow>(
        { orgId: this.orgId },
        'source_locations',
        `SELECT v.id AS version_id, l.ordinal, l.page, l.sheet, l.cell_range, l.slide, l.section_path, l.text, f.name, v.version_no,
                (f.current_version_id IS NOT NULL AND f.current_version_id <> v.id) AS superseded
           FROM unnest($3::uuid[], $4::int[]) AS want(version_id, ordinal)
           JOIN source_locations l ON l.file_version_id = want.version_id AND l.ordinal = want.ordinal AND l.org_id = $1
           JOIN file_versions v ON v.id = l.file_version_id AND v.org_id = $1
           JOIN files f ON f.id = v.file_id AND f.org_id = $1
          WHERE f.project_id = $2 AND f.status = 'active'`,
        [this.orgId, this.projectId, valid.map((r) => r.source), valid.map((r) => Number(r.locator))],
      );
      const byKey = new Map(rows.map((row) => [`C:${row.version_id}#${row.ordinal}`, row]));
      for (const r of valid) {
        const row = byKey.get(`C:${r.source.toLowerCase()}#${Number(r.locator)}`);
        out.set(
          refKey(r),
          row
            ? { text: row.text, label: `${row.name} v${row.version_no}, ${where(row)}`, superseded: row.superseded }
            : { error: 'no such passage in this project' },
        );
      }
    }
    return out;
  }
}

export interface GateRun extends GateResult {
  runId: string;
}

/** Run the gate over generated text for a project and log the run. The gate has no off switch. */
export async function runCitationGate(input: { orgId: string; userId?: string; projectId: string; route: string; text: string }): Promise<GateRun> {
  const [project] = await dataService.query<{ id: string }>({ orgId: input.orgId }, 'projects', 'SELECT id FROM projects WHERE id = $1 AND org_id = $2', [
    input.projectId,
    input.orgId,
  ]);
  if (!project) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
  const result = await applyCitationGate(input.text, new ProjectSourceResolver(input.orgId, input.projectId));
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
