/**
 * Provider-neutral AI interfaces (F7.1, architecture A2). Every AI call in the
 * product goes through these, so the same code runs on our self-hosted models
 * (Ollama in dev and test, vLLM in production) or, when a route or firm opts in,
 * a hosted provider.
 */

export type ProviderKind = 'ollama' | 'openai_compatible' | 'anthropic';

export interface GenerateRequest {
  /** Instructions for the model. Client documents never go here (NFR-16). */
  system?: string;
  /** The user turn. Untrusted document text is passed inside delimited data blocks by the caller. */
  prompt: string;
  /** Overrides the provider's default generation model. */
  model?: string;
  maxTokens?: number;
  /** Ask for a JSON object back (Ollama format=json, OpenAI response_format). Ignored by Anthropic, which uses schemas. */
  json?: boolean;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface GenerateResult {
  text: string;
  provider: ProviderKind;
  model: string;
  usage: TokenUsage;
  /** Normalised: 'stop' (finished), 'length' (hit maxTokens), or the provider's own value. */
  stopReason: string;
  latencyMs: number;
}

export interface EmbedResult {
  vectors: number[][];
  provider: ProviderKind;
  model: string;
  dimensions: number;
  usage: { inputTokens: number };
  latencyMs: number;
}

export interface ModelStatus {
  name: string;
  available: boolean;
}

export interface ProviderHealth {
  provider: ProviderKind;
  /** Scheme, host and port only, never credentials or paths. */
  endpoint: string;
  ok: boolean;
  models: ModelStatus[];
  latencyMs: number;
  /** Set when ok=false: the AiError code and message. */
  error?: { code: string; message: string; retryable: boolean };
}

export interface LlmProvider {
  readonly kind: ProviderKind;
  readonly defaultModel: string;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  /** Cheap reachability and model-presence check; never consumes generation tokens. */
  health(models?: string[]): Promise<ProviderHealth>;
}

export interface EmbeddingProvider {
  readonly kind: ProviderKind;
  readonly embeddingModel: string;
  embed(texts: string[], model?: string): Promise<EmbedResult>;
}

/** Scheme, host and port of a URL, for logs and health output. */
export function endpointOf(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'invalid-url';
  }
}
