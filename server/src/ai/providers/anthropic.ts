import Anthropic from '@anthropic-ai/sdk';
import { AiError, aiErrors } from '../errors';
import { GenerateRequest, GenerateResult, LlmProvider, ProviderHealth, endpointOf } from '../types';

/**
 * Claude API (opt-in per route or per firm; never the default). Generation only:
 * Anthropic offers no embeddings, so embeddings stay on our self-hosted model.
 * Client content is sent only for the request at hand (architecture §9).
 */
export interface AnthropicOptions {
  apiKey: string;
  generationModel: string;
  timeoutMs: number;
  /** Defaults to the public Claude API. */
  baseUrl?: string;
}

/**
 * Models that accept the server-side refusal fallback (`fallbacks: "default"`).
 * Claude Haiku 5.5 has no server-side fallback, and older models predate it.
 */
const SERVER_FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export class AnthropicProvider implements LlmProvider {
  readonly kind = 'anthropic' as const;
  readonly defaultModel: string;
  private readonly client: Anthropic;

  constructor(private readonly opts: AnthropicOptions) {
    this.defaultModel = opts.generationModel;
    // The SDK retries 408/409/429/5xx and connection errors itself (2 retries by default).
    this.client = new Anthropic({ apiKey: opts.apiKey, timeout: opts.timeoutMs, ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}) });
  }

  /** SDK error classes to typed AiErrors; APIConnectionError is checked before APIError (it is a subclass). */
  private mapError(err: unknown, model: string): AiError {
    if (err instanceof AiError) return err;
    if (err instanceof Anthropic.APIConnectionTimeoutError) return aiErrors.timeout(this.kind, this.opts.timeoutMs);
    if (err instanceof Anthropic.APIConnectionError) return aiErrors.unavailable(this.kind, 'connection failed');
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return aiErrors.authFailed(this.kind);
    if (err instanceof Anthropic.NotFoundError) return aiErrors.modelNotFound(this.kind, model);
    if (err instanceof Anthropic.RateLimitError) {
      const after = Number(err.headers?.get?.('retry-after'));
      return aiErrors.rateLimited(this.kind, Number.isFinite(after) && after > 0 ? after : undefined);
    }
    // 5xx including 529 overloaded.
    if (err instanceof Anthropic.InternalServerError) return aiErrors.providerError(this.kind, err.status ?? 500);
    if (err instanceof Anthropic.APIError) return aiErrors.badResponse(this.kind, `HTTP ${err.status ?? 'unknown'}`);
    return aiErrors.unavailable(this.kind, 'unexpected error');
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const model = req.model ?? this.defaultModel;
    const started = Date.now();
    const params = {
      model,
      max_tokens: req.maxTokens ?? 16000,
      ...(req.system ? { system: req.system } : {}),
      messages: [{ role: 'user' as const, content: req.prompt }],
    };
    let message: Anthropic.Beta.BetaMessage;
    try {
      message = SERVER_FALLBACK_MODELS.has(model)
        ? await this.client.beta.messages.create({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' })
        : await this.client.beta.messages.create(params);
    } catch (err) {
      throw this.mapError(err, model);
    }
    // A refusal is an HTTP 200 with stop_reason "refusal" (after any server-side fallback also declined).
    if (message.stop_reason === 'refusal') throw aiErrors.refused(this.kind);
    const text = message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return {
      text,
      provider: this.kind,
      // The model that actually answered (differs from `model` when a fallback served it).
      model: message.model,
      usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
      stopReason: message.stop_reason === 'max_tokens' ? 'length' : (message.stop_reason ?? 'stop'),
      latencyMs: Date.now() - started,
    };
  }

  /** Looks the model up on the Models API: confirms key and model without generating tokens. */
  async health(models: string[] = [this.defaultModel]): Promise<ProviderHealth> {
    const started = Date.now();
    const endpoint = endpointOf(this.opts.baseUrl ?? 'https://api.anthropic.com');
    const statuses: { name: string; available: boolean }[] = [];
    try {
      for (const name of models) {
        try {
          await this.client.models.retrieve(name);
          statuses.push({ name, available: true });
        } catch (err) {
          if (err instanceof Anthropic.NotFoundError) statuses.push({ name, available: false });
          else throw err;
        }
      }
      return { provider: this.kind, endpoint, ok: statuses.every((s) => s.available), models: statuses, latencyMs: Date.now() - started };
    } catch (err) {
      const e = this.mapError(err, models[0] ?? this.defaultModel);
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
