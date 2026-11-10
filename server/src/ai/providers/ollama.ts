import { aiErrors, fromFetchError, fromHttpStatus } from '../errors';
import { EmbedResult, EmbeddingProvider, GenerateRequest, GenerateResult, LlmProvider, ProviderHealth, endpointOf } from '../types';

/**
 * Ollama (our self-hosted default in dev and test). Native API:
 *   POST /api/chat   non-streaming chat, token counts in prompt_eval_count / eval_count
 *   POST /api/embed  batch embeddings
 *   GET  /api/tags   installed models (health)
 */
export interface OllamaOptions {
  baseUrl: string;
  generationModel: string;
  embeddingModel: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/** Ollama reports "qwen2.5:7b-instruct" and also accepts "name:latest" for a bare name. */
const sameModel = (installed: string, wanted: string): boolean =>
  installed === wanted || installed === `${wanted}:latest` || installed.replace(/:latest$/, '') === wanted;

export class OllamaProvider implements LlmProvider, EmbeddingProvider {
  readonly kind = 'ollama' as const;
  readonly defaultModel: string;
  readonly embeddingModel: string;
  private readonly base: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly opts: OllamaOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.defaultModel = opts.generationModel;
    this.embeddingModel = opts.embeddingModel;
    this.fetch = opts.fetchImpl ?? fetch;
  }

  private async post<T>(path: string, body: unknown, model: string): Promise<T> {
    let res: Response;
    try {
      res = await this.fetch(`${this.base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      throw fromFetchError(this.kind, err, this.opts.timeoutMs);
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) throw fromHttpStatus(this.kind, res.status, text, model, res.headers.get('retry-after'));
    try {
      return JSON.parse(text) as T;
    } catch {
      throw aiErrors.badResponse(this.kind, 'not JSON');
    }
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const model = req.model ?? this.defaultModel;
    const started = Date.now();
    const messages = [...(req.system ? [{ role: 'system', content: req.system }] : []), { role: 'user', content: req.prompt }];
    const r = await this.post<{ message?: { content?: string }; prompt_eval_count?: number; eval_count?: number; done_reason?: string }>(
      '/api/chat',
      {
        model,
        messages,
        stream: false,
        ...(req.json ? { format: 'json' } : {}),
        ...(req.maxTokens ? { options: { num_predict: req.maxTokens } } : {}),
      },
      model
    );
    if (typeof r.message?.content !== 'string') throw aiErrors.badResponse(this.kind, 'no message content');
    return {
      text: r.message.content,
      provider: this.kind,
      model,
      usage: { inputTokens: r.prompt_eval_count ?? 0, outputTokens: r.eval_count ?? 0 },
      stopReason: r.done_reason === 'length' ? 'length' : 'stop',
      latencyMs: Date.now() - started,
    };
  }

  async embed(texts: string[], model = this.embeddingModel): Promise<EmbedResult> {
    const started = Date.now();
    const r = await this.post<{ embeddings?: number[][]; prompt_eval_count?: number }>('/api/embed', { model, input: texts }, model);
    if (!Array.isArray(r.embeddings) || r.embeddings.length !== texts.length) throw aiErrors.badResponse(this.kind, 'embedding count mismatch');
    return {
      vectors: r.embeddings,
      provider: this.kind,
      model,
      dimensions: r.embeddings[0]?.length ?? 0,
      usage: { inputTokens: r.prompt_eval_count ?? 0 },
      latencyMs: Date.now() - started,
    };
  }

  async health(models: string[] = [this.opts.generationModel, this.opts.embeddingModel]): Promise<ProviderHealth> {
    const started = Date.now();
    const endpoint = endpointOf(this.base);
    try {
      let res: Response;
      try {
        res = await this.fetch(`${this.base}/api/tags`, { signal: AbortSignal.timeout(Math.min(this.opts.timeoutMs, 5000)) });
      } catch (err) {
        throw fromFetchError(this.kind, err, Math.min(this.opts.timeoutMs, 5000));
      }
      if (!res.ok) throw fromHttpStatus(this.kind, res.status, '', '', null);
      const body = (await res.json()) as { models?: { name: string }[] };
      const installed = (body.models ?? []).map((m) => m.name);
      const statuses = models.map((name) => ({ name, available: installed.some((i) => sameModel(i, name)) }));
      return { provider: this.kind, endpoint, ok: statuses.every((s) => s.available), models: statuses, latencyMs: Date.now() - started };
    } catch (err) {
      const e = fromFetchError(this.kind, err, this.opts.timeoutMs);
      return {
        provider: this.kind,
        endpoint,
        ok: false,
        models: models.map((name) => ({ name, available: false })),
        latencyMs: Date.now() - started,
        error: { code: e.code, message: e.message, retryable: e.retryable },
      };
    }
  }
}
