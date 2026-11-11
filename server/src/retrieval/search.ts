import { platformProviders } from '../ai/providers';
import { config } from '../config/env';
import { dataService } from '../services/DataService';
import { AppError, ErrorCodes } from '../utils/AppError';
import { EMBEDDING_DIMENSIONS } from './embeddings';

/**
 * Hybrid retrieval over a project's client passages (F7.3, Architecture §8):
 *  1. full text: any of the query words on chunks.tsv (section path + text), ranked by cover density
 *  2. vector: pgvector cosine distance to the query's bge-m3 embedding
 *  3. reciprocal rank fusion of both lists
 *  4. optional rerank (bge-reranker-v2-m3 behind a TEI-compatible /rerank endpoint)
 * Every result carries its source location and the [C:...] citation the gate accepts.
 * Superseded versions are left out unless asked for.
 */

export const CANDIDATES = 50;
/** Reciprocal rank fusion constant (Cormack et al. 2009). */
const RRF_K = 60;

export interface SearchLocation {
  ordinal: number;
  kind: string;
  page: number | null;
  sheet: string | null;
  cellRange: string | null;
  slide: number | null;
  sectionPath: string | null;
}

export interface SearchHit {
  chunkId: string;
  fileId: string;
  fileName: string;
  fileVersionId: string;
  versionNo: number;
  current: boolean;
  text: string;
  sectionPath: string | null;
  start: SearchLocation;
  end: SearchLocation;
  /** Where to point a reader: "page 3", "sheet Tensile, A2:D2..A9:D9", "slide 4", or the heading path. */
  where: string;
  citation: string;
  score: number;
  matchedBy: ('text' | 'vector')[];
}

export interface SearchResult {
  query: string;
  mode: 'hybrid' | 'text';
  reranked: boolean;
  /** Why the vector half did not run, when it did not. */
  notice: string | null;
  items: SearchHit[];
}

interface HitRow {
  chunk_id: string;
  file_id: string;
  file_name: string;
  file_version_id: string;
  version_no: number;
  current: boolean;
  text: string;
  section_path: string | null;
  start: SearchLocation;
  end: SearchLocation;
}

const HIT_COLUMNS = `c.id AS chunk_id, f.id AS file_id, f.name AS file_name, v.id AS file_version_id, v.version_no,
  (f.current_version_id = v.id) AS current, c.text, c.section_path,
  json_build_object('ordinal', s.ordinal, 'kind', s.kind, 'page', s.page, 'sheet', s.sheet, 'cellRange', s.cell_range, 'slide', s.slide, 'sectionPath', s.section_path) AS start,
  json_build_object('ordinal', e.ordinal, 'kind', e.kind, 'page', e.page, 'sheet', e.sheet, 'cellRange', e.cell_range, 'slide', e.slide, 'sectionPath', e.section_path) AS "end"`;

const HIT_JOINS = `JOIN file_versions v ON v.id = c.file_version_id AND v.org_id = c.org_id
  JOIN files f ON f.id = v.file_id AND f.org_id = c.org_id AND f.status = 'active'
  JOIN source_locations s ON s.id = c.start_location_id AND s.org_id = c.org_id
  JOIN source_locations e ON e.id = c.end_location_id AND e.org_id = c.org_id`;

function where(a: SearchLocation, b: SearchLocation): string {
  if (a.sheet && a.cellRange) return `sheet ${a.sheet}, ${a.cellRange}${b.cellRange && b.cellRange !== a.cellRange ? `..${b.cellRange}` : ''}`;
  if (a.slide) return `slide ${a.slide}`;
  if (a.page) return b.page && b.page !== a.page ? `pages ${a.page}-${b.page}` : `page ${a.page}`;
  return a.sectionPath ?? 'document';
}

async function rerank(query: string, texts: string[]): Promise<number[] | null> {
  if (!config.llm.rerankUrl || !texts.length) return null;
  try {
    const r = await fetch(`${config.llm.rerankUrl.replace(/\/+$/, '')}/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.llm.rerankModel, query, texts, raw_scores: false }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    // TEI answers [{ index, score }] (any order).
    const body = (await r.json()) as { index: number; score: number }[];
    const scores = new Array<number>(texts.length).fill(-Infinity);
    for (const { index, score } of body) if (index >= 0 && index < texts.length) scores[index] = score;
    return scores;
  } catch {
    // Reranking is an improvement, never a dependency: fall back to the fused order.
    return null;
  }
}

export async function hybridSearch(input: {
  orgId: string;
  projectId: string;
  query: string;
  limit: number;
  includeSuperseded?: boolean;
}): Promise<SearchResult> {
  const { orgId, projectId, query, limit } = input;
  const [project] = await dataService.query<{ id: string }>({ orgId }, 'projects', 'SELECT id FROM projects WHERE id = $1 AND org_id = $2', [projectId, orgId]);
  if (!project) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
  const scope = `c.org_id = $1 AND c.project_id = $2 ${input.includeSuperseded ? '' : 'AND f.current_version_id = v.id'}`;

  const textHits = await dataService.query<HitRow>(
    { orgId },
    'chunks',
    `SELECT ${HIT_COLUMNS} FROM chunks c ${HIT_JOINS}, to_tsquery('simple', replace(plainto_tsquery('english', $3)::text, '&', '|')) q
      WHERE ${scope} AND c.tsv @@ q
      ORDER BY ts_rank_cd(c.tsv, q) DESC, c.id LIMIT ${CANDIDATES}`,
    [orgId, projectId, query],
  );

  let vectorHits: HitRow[] = [];
  let notice: string | null = null;
  const [{ embedded }] = await dataService.query<{ embedded: boolean }>(
    { orgId },
    'chunks',
    'SELECT EXISTS (SELECT 1 FROM chunks WHERE org_id = $1 AND project_id = $2 AND embedding IS NOT NULL) AS embedded',
    [orgId, projectId],
  );
  if (!embedded) {
    notice = 'Passages are not embedded yet, so only word matches are used';
  } else {
    try {
      const e = await platformProviders().embeddings.embed([query]);
      if (e.dimensions !== EMBEDDING_DIMENSIONS) throw new Error(`embedding model returns ${e.dimensions} dimensions`);
      vectorHits = await dataService.query<HitRow>(
        { orgId },
        'chunks',
        `SELECT ${HIT_COLUMNS} FROM chunks c ${HIT_JOINS}
          WHERE ${scope} AND c.embedding IS NOT NULL
          ORDER BY c.embedding <=> $3::vector, c.id LIMIT ${CANDIDATES}`,
        [orgId, projectId, `[${e.vectors[0].join(',')}]`],
      );
    } catch {
      notice = 'The embedding model is not reachable, so only word matches are used';
    }
  }

  // Reciprocal rank fusion: a passage found by both lists rises; one list alone still counts.
  const fused = new Map<string, { row: HitRow; score: number; matchedBy: Set<'text' | 'vector'> }>();
  const add = (rows: HitRow[], source: 'text' | 'vector'): void =>
    rows.forEach((row, rank) => {
      const entry = fused.get(row.chunk_id) ?? { row, score: 0, matchedBy: new Set<'text' | 'vector'>() };
      entry.score += 1 / (RRF_K + rank + 1);
      entry.matchedBy.add(source);
      fused.set(row.chunk_id, entry);
    });
  add(textHits, 'text');
  add(vectorHits, 'vector');
  let ranked = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, CANDIDATES);

  const scores = await rerank(
    query,
    ranked.map((r) => r.row.text),
  );
  if (scores) {
    ranked = ranked.map((r, i) => ({ ...r, score: scores[i] })).sort((a, b) => b.score - a.score);
  }

  return {
    query,
    mode: vectorHits.length || (embedded && !notice) ? 'hybrid' : 'text',
    reranked: Boolean(scores),
    notice,
    items: ranked.slice(0, limit).map(({ row, score, matchedBy }) => ({
      chunkId: row.chunk_id,
      fileId: row.file_id,
      fileName: row.file_name,
      fileVersionId: row.file_version_id,
      versionNo: row.version_no,
      current: row.current,
      text: row.text,
      sectionPath: row.section_path,
      start: row.start,
      end: row.end,
      where: where(row.start, row.end),
      citation:
        row.start.ordinal === row.end.ordinal
          ? `[C:${row.file_version_id}#${row.start.ordinal}]`
          : `[C:${row.file_version_id}#${row.start.ordinal}-${row.end.ordinal}]`,
      score: Number(score.toFixed(6)),
      matchedBy: [...matchedBy],
    })),
  };
}
