/**
 * Embeddings for the public 510(k) summary index (F1.2). Same model and dimensions
 * as the app's index (bge-m3, 1024), so one query vector works against both.
 *
 * Providers: "ollama" (POST /api/embed; local development) or "openai_compatible"
 * (POST /v1/embeddings; vLLM / TEI in production).
 */

export const EMBEDDING_DIMENSIONS = 1024;

export class EmbeddingError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

export interface EmbedderOptions {
  provider: 'ollama' | 'openai_compatible';
  baseUrl: string;
  model: string;
  apiKey?: string | null;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export class Embedder {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: EmbedderOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get model(): string {
    return this.opts.model;
  }

  get configured(): boolean {
    return Boolean(this.opts.baseUrl);
  }

  /** One vector per input text, in order. */
  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const base = this.opts.baseUrl.replace(/\/+$/, '');
    const ollama = this.opts.provider === 'ollama';
    const url = ollama ? `${base}/api/embed` : `${base}/v1/embeddings`;
    const body = { model: this.opts.model, input: texts }; // same shape for both APIs
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      throw new EmbeddingError(`The embedding model at ${base} did not answer (${(err as Error).name})`, true);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new EmbeddingError(`The embedding model answered ${res.status}: ${detail}`, res.status >= 500 || res.status === 429);
    }
    const json = (await res.json()) as { embeddings?: number[][]; data?: { embedding: number[]; index: number }[] };
    const vectors = ollama
      ? (json.embeddings ?? [])
      : [...(json.data ?? [])].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    if (vectors.length !== texts.length) {
      throw new EmbeddingError(`The embedding model returned ${vectors.length} vectors for ${texts.length} texts`, false);
    }
    const bad = vectors.find((v) => v.length !== EMBEDDING_DIMENSIONS);
    if (bad) {
      throw new EmbeddingError(`${this.opts.model} returns ${bad.length}-dimension vectors; the index needs ${EMBEDDING_DIMENSIONS} (bge-m3)`, false);
    }
    return vectors;
  }
}
