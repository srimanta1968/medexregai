import { aiErrors, fromFetchError, fromHttpStatus } from '../errors';
import { EmbedResult, EmbeddingProvider, GenerateRequest, GenerateResult, LlmProvider, ProviderHealth, endpointOf } from '../types';

/**
 * OpenAI-compatible HTTP API: vLLM in production (our self-hosted models), and any
 * firm-supplied compatible endpoint (F7.1 bring-your-own model).
 *   POST /v1/chat/completions, POST /v1/embeddings, GET /v1/models
 * The base URL may be given with or without the trailing /v1.
 */
export interface OpenAiCompatibleOptions {
  baseUrl: string;
  generationModel: string;
  embeddingModel: string;
  timeoutMs: number;
  /** Optional bearer key (vLLM --api-key, or a firm's own provider key). Never logged. */
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export class OpenAiCompatibleProvider implements LlmProvider, EmbeddingProvider {
  readonly kind = 'openai_compatible' as const;
  readonly defaultModel: string;
  readonly embeddingModel: string;
  private readonly base: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly opts: OpenAiCompatibleOptions) {
    this.base = `${opts.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1`;
    this.defaultModel = opts.generationModel;
    this.embeddingModel = opts.embeddingModel;
    this.fetch = opts.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}) };
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body: unknown, model: string, timeoutMs = this.opts.timeoutMs): Promise<T> {
    let res: Response;
    try {
      res = await this.fetch(`${this.base}${path}`, {
        method,
        headers: this.headers(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw fromFetchError(this.kind, err, timeoutMs);
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
    const r = await this.call<{
      choices?: { message?: { content?: string | null }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    }>(
      'POST',
      '/chat/completions',
      {
        model,
        messages: [...(req.system ? [{ role: 'system', content: req.system }] : []), { role: 'user', content: req.prompt }],
        ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        ...(req.json ? { response_format: { type: 'json_object' } } : {}),
      },
      model
    );
    const choice = r.choices?.[0];
    if (typeof choice?.message?.content !== 'string') throw aiErrors.badResponse(this.kind, 'no message content');
    return {
      text: choice.message.content,
      provider: this.kind,
      model,
      usage: { inputTokens: r.usage?.prompt_tokens ?? 0, outputTokens: r.usage?.completion_tokens ?? 0 },
      stopReason: choice.finish_reason === 'length' ? 'length' : (choice.finish_reason ?? 'stop'),
      latencyMs: Date.now() - started,
    };
  }

  async embed(texts: string[], model = this.embeddingModel): Promise<EmbedResult> {
    const started = Date.now();
    const r = await this.call<{ data?: { embedding: number[]; index: number }[]; usage?: { prompt_tokens?: number } }>(
      'POST',
      '/embeddings',
      { model, input: texts },
      model
    );
    if (!Array.isArray(r.data) || r.data.length !== texts.length) throw aiErrors.badResponse(this.kind, 'embedding count mismatch');
    const vectors = [...r.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    return {
      vectors,
      provider: this.kind,
      model,
      dimensions: vectors[0]?.length ?? 0,
      usage: { inputTokens: r.usage?.prompt_tokens ?? 0 },
      latencyMs: Date.now() - started,
    };
  }

  async health(models: string[] = [this.opts.generationModel, this.opts.embeddingModel]): Promise<ProviderHealth> {
    const started = Date.now();
    const endpoint = endpointOf(this.base);
    try {
      const r = await this.call<{ data?: { id: string }[] }>('GET', '/models', undefined, '', Math.min(this.opts.timeoutMs, 5000));
      const served = (r.data ?? []).map((m) => m.id);
      const statuses = models.map((name) => ({ name, available: served.includes(name) }));
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
