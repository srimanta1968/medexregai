import { AppError, ErrorCodes } from '../utils/AppError';
import { ProviderKind } from './types';

/**
 * Typed AI failure. `retryable` tells workers whether to try again later (model
 * down, timeout, rate limit, provider 5xx) or to stop and surface the problem
 * (bad key, unknown model, refusal, malformed response).
 */
export class AiError extends AppError {
  constructor(
    status: number,
    code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly provider: ProviderKind,
    public readonly retryAfterSeconds?: number
  ) {
    super(status, code, message, { retryable, provider, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) });
    this.name = 'AiError';
  }
}

export const aiErrors = {
  unavailable: (provider: ProviderKind, detail: string) =>
    new AiError(503, ErrorCodes.AI_UNAVAILABLE, `The AI model is not reachable right now (${detail}). Try again shortly.`, true, provider, 30),
  timeout: (provider: ProviderKind, ms: number) =>
    new AiError(503, ErrorCodes.AI_TIMEOUT, `The AI model did not answer within ${Math.round(ms / 1000)} seconds. Try again shortly.`, true, provider, 30),
  rateLimited: (provider: ProviderKind, retryAfterSeconds?: number) =>
    new AiError(503, ErrorCodes.AI_RATE_LIMITED, 'The AI provider is rate limiting requests. Try again shortly.', true, provider, retryAfterSeconds ?? 60),
  providerError: (provider: ProviderKind, status: number) =>
    new AiError(503, ErrorCodes.AI_UNAVAILABLE, `The AI provider returned an error (HTTP ${status}). Try again shortly.`, true, provider, 30),
  modelNotFound: (provider: ProviderKind, model: string) =>
    new AiError(
      502,
      ErrorCodes.AI_MODEL_NOT_FOUND,
      `Model "${model}" is not available on the ${provider} provider${provider === 'ollama' ? ' (run scripts/pull-models.sh)' : ''}.`,
      false,
      provider
    ),
  authFailed: (provider: ProviderKind) =>
    new AiError(502, ErrorCodes.AI_AUTH_FAILED, `The ${provider} provider rejected the API key.`, false, provider),
  badResponse: (provider: ProviderKind, detail: string) =>
    new AiError(502, ErrorCodes.AI_BAD_RESPONSE, `The AI provider returned an unusable response (${detail}).`, false, provider),
  refused: (provider: ProviderKind) =>
    new AiError(422, ErrorCodes.AI_REFUSED, 'The AI model declined this request.', false, provider),
};

/** Map a fetch() failure (network, timeout) to a typed AiError. */
export function fromFetchError(provider: ProviderKind, err: unknown, timeoutMs: number): AiError {
  if (err instanceof AiError) return err;
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return aiErrors.timeout(provider, timeoutMs);
  return aiErrors.unavailable(provider, e?.cause?.code ?? e?.message ?? 'connection failed');
}

/** Map a non-2xx HTTP response from an Ollama or OpenAI-compatible server. */
export function fromHttpStatus(provider: ProviderKind, status: number, body: string, model: string, retryAfter: string | null): AiError {
  if (status === 401 || status === 403) return aiErrors.authFailed(provider);
  if (status === 404 || /model .*not found/i.test(body)) return aiErrors.modelNotFound(provider, model);
  if (status === 429) return aiErrors.rateLimited(provider, retryAfter ? Number(retryAfter) || undefined : undefined);
  if (status >= 500) return aiErrors.providerError(provider, status);
  return aiErrors.badResponse(provider, `HTTP ${status}`);
}
