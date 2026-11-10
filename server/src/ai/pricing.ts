import { ProviderKind, TokenUsage } from './types';

/**
 * US dollars per million tokens. Claude API list prices as recorded on
 * 2026-10-06 (architecture §8 / MRA-PRD-008); reconfirm against Anthropic's
 * pricing page before relying on them for billing. Our self-hosted models
 * (Ollama, vLLM) cost $0 per token: their cost is GPU time, metered as tokens.
 */
interface Price {
  input: number;
  output: number;
  /** Claude Haiku 5.5 charges more for prompts over 100K tokens. */
  longPrompt?: { overTokens: number; input: number; output: number };
}

export const PRICES_AS_OF = '2026-10-06';

const CLAUDE: Record<string, Price> = {
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, longPrompt: { overTokens: 100_000, input: 0.5, output: 2.5 } },
};

/**
 * Cost of one call, or null when unknown (a firm's own endpoint, or a Claude model
 * missing from the list). Self-hosted platform models return 0.
 */
export function callCostUsd(provider: ProviderKind, model: string, usage: TokenUsage, source: 'platform' | 'firm'): number | null {
  if (provider === 'anthropic') {
    const p = CLAUDE[model];
    if (!p) return null;
    const tier = p.longPrompt && usage.inputTokens > p.longPrompt.overTokens ? p.longPrompt : p;
    return (usage.inputTokens * tier.input + usage.outputTokens * tier.output) / 1_000_000;
  }
  return source === 'platform' ? 0 : null;
}
