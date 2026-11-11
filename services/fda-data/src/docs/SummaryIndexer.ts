import { config } from '../config';
import { primaryPool, q } from '../db/pool';
import { chunkLocations } from './chunker';
import { DocprocClient, DocprocError } from './docproc';
import { DocumentStore } from './documentStore';
import { Embedder, EmbeddingError } from './embedder';
import { defaultDocumentStore } from './SummaryFetcher';

/**
 * Indexes fetched 510(k) summary PDFs (F1.2, ADR-017): parse in the docproc sandbox,
 * cut into page-bounded passages, embed with bge-m3, store in fda_510k_passages.
 * Runs in fda-worker after SummaryFetcher. Several workers are safe (SKIP LOCKED).
 * Passages are replaced as a whole inside one transaction, so a re-index never
 * leaves a half-written document.
 */

const STALE_CLAIM_MINUTES = 30;
const MAX_INDEX_ATTEMPTS = 6;
const EMBED_BATCH = 16;

export type IndexOutcome = 'indexed' | 'needs_ocr' | 'failed' | 'retry' | 'skipped';

export interface IndexerDeps {
  store?: DocumentStore;
  docproc?: DocprocClient;
  embedder?: Embedder;
}

interface Claimed {
  k_number: string;
  storage_key: string;
  index_attempts: number;
}

export function defaultDocproc(): DocprocClient {
  return new DocprocClient(config.docproc.url, config.docproc.apiKey, config.docproc.timeoutMs);
}

export function defaultEmbedder(): Embedder {
  const e = config.embedding;
  return new Embedder({ provider: e.provider, baseUrl: e.baseUrl, model: e.model, apiKey: e.apiKey, timeoutMs: e.timeoutMs });
}

/** Minutes before index attempt n+1: 5, 10, 20 ... capped at six hours. */
export function indexBackoffMinutes(attempts: number): number {
  return Math.min(5 * 2 ** Math.max(attempts - 1, 0), 360);
}

export class SummaryIndexer {
  private readonly store: DocumentStore;
  private readonly docproc: DocprocClient;
  private readonly embedder: Embedder;

  constructor(deps: IndexerDeps = {}) {
    this.store = deps.store ?? defaultDocumentStore();
    this.docproc = deps.docproc ?? defaultDocproc();
    this.embedder = deps.embedder ?? defaultEmbedder();
  }

  /** False until docproc has a key: the indexer then does nothing rather than failing every PDF. */
  get ready(): boolean {
    return this.docproc.configured && this.embedder.configured;
  }

  private async requeueStale(): Promise<void> {
    await q(
      `UPDATE fda_510k_documents SET index_status = 'pending', index_claimed_at = NULL, updated_at = now()
        WHERE index_status = 'indexing' AND index_claimed_at < now() - make_interval(mins => $1)`,
      [STALE_CLAIM_MINUTES],
    );
  }

  private async claim(limit: number): Promise<Claimed[]> {
    const { rows } = await primaryPool().query<Claimed>(
      `UPDATE fda_510k_documents d
          SET index_status = 'indexing', index_claimed_at = now(), index_attempts = d.index_attempts + 1, updated_at = now()
        WHERE d.k_number IN (
          SELECT doc.k_number FROM fda_510k_documents doc
            LEFT JOIN fda_510k k ON k.k_number = doc.k_number
           WHERE doc.status = 'fetched' AND doc.index_status IN ('pending', 'failed') AND doc.index_next_attempt_at <= now()
           ORDER BY k.decision_date DESC NULLS LAST, doc.k_number LIMIT $1 FOR UPDATE OF doc SKIP LOCKED)
        RETURNING d.k_number, d.storage_key, d.index_attempts`,
      [limit],
    );
    return rows;
  }

  /** One pass: requeue stale claims, claim a batch, index each. */
  async runPass(limit = config.docs.indexBatch): Promise<Record<IndexOutcome, number>> {
    const counts: Record<IndexOutcome, number> = { indexed: 0, needs_ocr: 0, failed: 0, retry: 0, skipped: 0 };
    if (!this.ready) return counts;
    await this.requeueStale();
    for (const row of await this.claim(limit)) counts[await this.indexOne(row)] += 1;
    return counts;
  }

  private async indexOne({ k_number: kNumber, storage_key: key, index_attempts: attempts }: Claimed): Promise<IndexOutcome> {
    try {
      const bytes = await this.store.get(key);
      const parsed = await this.docproc.parse(bytes, `${kNumber}.pdf`);
      const passages = chunkLocations(parsed.locations);
      if (!passages.length) {
        const status = parsed.needsOcr ? 'needs_ocr' : 'failed';
        const reason = parsed.needsOcr
          ? 'The summary is a scanned PDF with no text layer; this docproc build has no OCR'
          : 'The summary PDF has no extractable text';
        await this.finish(kNumber, status, reason, parsed.unitCount, 0);
        return status === 'needs_ocr' ? 'needs_ocr' : 'failed';
      }
      const vectors: number[][] = [];
      for (let i = 0; i < passages.length; i += EMBED_BATCH) {
        vectors.push(...(await this.embedder.embed(passages.slice(i, i + EMBED_BATCH).map((p) => p.text))));
      }
      const client = await primaryPool().connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM fda_510k_passages WHERE k_number = $1', [kNumber]);
        await client.query(
          `INSERT INTO fda_510k_passages (k_number, ordinal, page, section_path, text, token_count, embedding, embedding_model)
           SELECT $1, p.ordinal, p.page, p.section_path, p.text, p.token_count, p.vec::vector, $2
             FROM unnest($3::int[], $4::int[], $5::text[], $6::text[], $7::int[], $8::text[])
                  AS p(ordinal, page, section_path, text, token_count, vec)`,
          [
            kNumber,
            this.embedder.model,
            passages.map((p) => p.ordinal),
            passages.map((p) => p.page),
            passages.map((p) => p.sectionPath),
            passages.map((p) => p.text),
            passages.map((p) => p.tokenCount),
            vectors.map((v) => `[${v.join(',')}]`),
          ],
        );
        await client.query(
          `UPDATE fda_510k_documents SET index_status = 'indexed', index_error = NULL, index_claimed_at = NULL, indexed_at = now(),
                  page_count = $2, passage_count = $3, embedding_model = $4, updated_at = now()
            WHERE k_number = $1`,
          [kNumber, parsed.unitCount, passages.length, this.embedder.model],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
      return 'indexed';
    } catch (err) {
      const retryable =
        (err instanceof DocprocError && err.retryable) || (err instanceof EmbeddingError && err.retryable) || !(err instanceof DocprocError || err instanceof EmbeddingError);
      const reason = (err as Error).message;
      if (retryable && attempts < MAX_INDEX_ATTEMPTS) {
        await q(
          `UPDATE fda_510k_documents SET index_status = 'failed', index_error = left($2, 500), index_claimed_at = NULL,
                  index_next_attempt_at = now() + make_interval(mins => $3), updated_at = now()
            WHERE k_number = $1`,
          [kNumber, reason, indexBackoffMinutes(attempts)],
        );
        return 'retry';
      }
      // A file problem (unreadable, unsupported) or out of attempts: keep it failed, never retried.
      await q(
        `UPDATE fda_510k_documents SET index_status = 'failed', index_error = left($2, 500), index_claimed_at = NULL,
                index_next_attempt_at = 'infinity', updated_at = now()
          WHERE k_number = $1`,
        [kNumber, reason],
      );
      return 'failed';
    }
  }

  private async finish(kNumber: string, status: 'needs_ocr' | 'failed', reason: string, pages: number, passages: number): Promise<void> {
    await q(
      `UPDATE fda_510k_documents SET index_status = $2, index_error = $3, index_claimed_at = NULL, page_count = $4,
              passage_count = $5, index_next_attempt_at = 'infinity', updated_at = now()
        WHERE k_number = $1`,
      [kNumber, status, reason, pages, passages],
    );
  }
}
