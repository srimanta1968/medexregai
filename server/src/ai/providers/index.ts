import { config } from '../../config/env';
import { EmbeddingProvider, LlmProvider, ProviderKind } from '../types';
import { AnthropicProvider } from './anthropic';
import { OllamaProvider } from './ollama';
import { OpenAiCompatibleProvider } from './openaiCompatible';

export interface ProviderSettings {
  kind: ProviderKind;
  baseUrl: string;
  generationModel: string;
  embeddingModel: string;
  timeoutMs: number;
  apiKey?: string;
}

export interface Providers {
  llm: LlmProvider;
  /** Always a self-hosted model: Anthropic has no embeddings, and vectors must be consistent per index. */
  embeddings: EmbeddingProvider;
}

/** Build the provider pair for one set of settings (platform default or a firm override). */
export function buildProviders(s: ProviderSettings, platformEmbeddings?: EmbeddingProvider): Providers {
  if (s.kind === 'ollama') {
    const p = new OllamaProvider({ baseUrl: s.baseUrl, generationModel: s.generationModel, embeddingModel: s.embeddingModel, timeoutMs: s.timeoutMs });
    return { llm: p, embeddings: platformEmbeddings ?? p };
  }
  if (s.kind === 'openai_compatible') {
    const p = new OpenAiCompatibleProvider({
      baseUrl: s.baseUrl,
      generationModel: s.generationModel,
      embeddingModel: s.embeddingModel,
      timeoutMs: s.timeoutMs,
      apiKey: s.apiKey,
    });
    return { llm: p, embeddings: platformEmbeddings ?? p };
  }
  if (!s.apiKey) throw new Error('The anthropic provider needs an API key.');
  if (!platformEmbeddings) throw new Error('The anthropic provider has no embeddings; supply the platform embedding provider.');
  return {
    llm: new AnthropicProvider({ apiKey: s.apiKey, generationModel: s.generationModel, timeoutMs: s.timeoutMs, baseUrl: s.baseUrl || undefined }),
    embeddings: platformEmbeddings,
  };
}

let platform: Providers | null = null;

/**
 * The platform default from AI_* settings: our self-hosted model unless the operator
 * configured otherwise. With AI_PROVIDER=anthropic, embeddings still run on Ollama
 * at AI_EMBEDDING_BASE_URL (default http://localhost:11434).
 */
export function platformProviders(): Providers {
  if (platform) return platform;
  const { llm } = config;
  const settings: ProviderSettings = {
    kind: llm.provider,
    baseUrl: llm.baseUrl,
    generationModel: llm.generationModel,
    embeddingModel: llm.embeddingModel,
    timeoutMs: llm.requestTimeoutMs,
    apiKey: llm.apiKey,
  };
  if (llm.provider === 'anthropic') {
    const local = new OllamaProvider({
      baseUrl: llm.embeddingBaseUrl,
      generationModel: llm.generationModel,
      embeddingModel: llm.embeddingModel,
      timeoutMs: llm.requestTimeoutMs,
    });
    platform = buildProviders(settings, local);
  } else {
    platform = buildProviders(settings);
  }
  return platform;
}
