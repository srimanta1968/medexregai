import { qRead } from '../db/pool';
import { defaultEmbedder } from '../docs/SummaryIndexer';
import { Embedder } from '../docs/embedder';
import { Codes, ServiceError } from '../errors';

/**
 * Read side of the public 510(k) summary index (F1.2): passages of one summary, and
 * hybrid search across summaries. Every passage carries its K-number, page and the
 * FDA's own PDF URL so a consultant can check it at the source; `ref` is the stable
 * passage reference F7.3 cites as [R:<ref>].
 */

const RRF_K = 60;
const CANDIDATES = 50;

export interface SummaryPassage {
  ref: string;
  kNumber: string;
  ordinal: number;
  page: number | null;
  sectionPath: string | null;
  text: string;
}

interface PassageRow {
  k_number: string;
  ordinal: number;
  page: number | null;
  section_path: string | null;
  text: string;
}

const toPassage = (r: PassageRow): SummaryPassage => ({
  ref: `${r.k_number}#${r.ordinal}`,
  kNumber: r.k_number,
  ordinal: r.ordinal,
  page: r.page,
  sectionPath: r.section_path,
  text: r.text,
});

/** All passages of one K-number's summary, in document order (paged). */
export async function summaryPassages(kNumber: string, limit: number, offset: number) {
  const [doc] = await qRead<{
    k_number: string;
    in_corpus: boolean;
    status: string | null;
    reason: string | null;
    source_url: string | null;
    index_status: string | null;
    index_error: string | null;
    page_count: number | null;
    passage_count: number | null;
    indexed_at: Date | null;
    embedding_model: string | null;
  }>(
    `SELECT k.k_number, true AS in_corpus, d.status, d.reason, d.source_url, d.index_status, d.index_error,
            d.page_count, d.passage_count, d.indexed_at, d.embedding_model
       FROM fda_510k k LEFT JOIN fda_510k_documents d ON d.k_number = k.k_number
      WHERE k.k_number = $1`,
    [kNumber],
  );
  if (!doc) throw new ServiceError(404, Codes.NOT_FOUND, `${kNumber} is not in our copy of the FDA 510(k) database`);
  const rows =
    doc.index_status === 'indexed'
      ? await qRead<PassageRow>(
          `SELECT k_number, ordinal, page, section_path, text FROM fda_510k_passages
            WHERE k_number = $1 ORDER BY ordinal LIMIT $2 OFFSET $3`,
          [kNumber, limit, offset],
        )
      : [];
  return {
    kNumber,
    /** fetched | no_summary | queued | fetching | failed; null = not looked at yet. */
    summaryStatus: doc.status,
    /** indexed | pending | indexing | needs_ocr | failed; null when there is no PDF. */
    indexStatus: doc.status === 'fetched' ? doc.index_status : null,
    reason: doc.status === 'fetched' ? doc.index_error : doc.reason,
    sourceUrl: doc.source_url,
    pageCount: doc.page_count,
    passageCount: doc.passage_count ?? 0,
    indexedAt: doc.indexed_at ? doc.indexed_at.toISOString() : null,
    embeddingModel: doc.embedding_model,
    passages: rows.map(toPassage),
    nextOffset: doc.passage_count !== null && offset + rows.length < doc.passage_count ? offset + rows.length : null,
  };
}

interface HitRow extends PassageRow {
  id: string;
  applicant: string | null;
  device_name: string | null;
  product_code: string | null;
  decision_date: Date | null;
  source_url: string | null;
}

let embedder: Embedder | undefined;

/**
 * Hybrid search over indexed summaries: keyword (Postgres full text) and semantic
 * (bge-m3 cosine) rankings fused with reciprocal rank fusion. When the embedding
 * model is unavailable the answer is keyword-only and says so (`mode`).
 */
export async function searchSummaries(p: { q: string; productCode?: string; kNumber?: string; limit: number }) {
  const filters: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown): void => {
    params.push(value);
    filters.push(sql.replace('$?', `$${params.length}`));
  };
  if (p.productCode) add('k.product_code = $?', p.productCode);
  if (p.kNumber) add('ps.k_number = $?', p.kNumber);
  const where = filters.length ? `AND ${filters.join(' AND ')}` : '';
  const base = `FROM fda_510k_passages ps JOIN fda_510k k ON k.k_number = ps.k_number
                JOIN fda_510k_documents d ON d.k_number = ps.k_number AND d.index_status = 'indexed'`;
  const cols = `ps.id::text AS id, ps.k_number, ps.ordinal, ps.page, ps.section_path, ps.text,
                k.applicant, k.device_name, k.product_code, k.decision_date, d.source_url`;

  const keywordParams = [...params, p.q];
  const keyword = await qRead<HitRow>(
    `SELECT ${cols} ${base}
      WHERE ps.tsv @@ websearch_to_tsquery('english', $${keywordParams.length}) ${where}
      ORDER BY ts_rank_cd(ps.tsv, websearch_to_tsquery('english', $${keywordParams.length})) DESC, ps.id
      LIMIT ${CANDIDATES}`,
    keywordParams,
  );

  let semantic: HitRow[] = [];
  let mode: 'hybrid' | 'keyword' = 'keyword';
  let note: string | null = null;
  try {
    embedder ??= defaultEmbedder();
    const [vec] = await embedder.embed([p.q]);
    const semParams = [...params, `[${vec.join(',')}]`];
    semantic = await qRead<HitRow>(
      `SELECT ${cols} ${base}
        WHERE ps.embedding IS NOT NULL ${where}
        ORDER BY ps.embedding <=> $${semParams.length}::vector, ps.id
        LIMIT ${CANDIDATES}`,
      semParams,
    );
    mode = 'hybrid';
  } catch (err) {
    note = `Semantic search unavailable (${(err as Error).message}); results are keyword matches only`;
  }

  const fused = new Map<string, { row: HitRow; score: number; keywordRank: number | null; semanticRank: number | null }>();
  const fuse = (rows: HitRow[], which: 'keywordRank' | 'semanticRank'): void => {
    rows.forEach((row, i) => {
      const e = fused.get(row.id) ?? { row, score: 0, keywordRank: null, semanticRank: null };
      e.score += 1 / (RRF_K + i + 1);
      e[which] = i + 1;
      fused.set(row.id, e);
    });
  };
  fuse(keyword, 'keywordRank');
  fuse(semantic, 'semanticRank');

  const hits = [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, p.limit)
    .map(({ row, score, keywordRank, semanticRank }) => ({
      ...toPassage(row),
      score: Number(score.toFixed(6)),
      keywordRank,
      semanticRank,
      applicant: row.applicant,
      deviceName: row.device_name,
      productCode: row.product_code,
      decisionDate: row.decision_date ? row.decision_date.toISOString().slice(0, 10) : null,
      sourceUrl: row.source_url,
    }));
  return { query: p.q, mode, note, hits };
}
