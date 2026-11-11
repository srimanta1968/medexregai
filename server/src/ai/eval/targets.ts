import { config } from '../../config/env';
import { recordAiCall } from '../AiMeter';
import { aiErrors } from '../errors';
import { firmProviderStore } from '../FirmProviderStore';
import { Generator } from '../guard/documentCall';
import { buildProviders, platformProviders } from '../providers';
import { AiRoute, assertPlainRequest, REGISTRY } from '../registry';
import { LlmProvider } from '../types';

/**
 * What an evaluation runs against (F7.4). The generator calls the provider directly
 * with the route's own output mode and token limit, exactly as aiGenerate does for
 * that route, but pinned to the model under test instead of resolving the registry
 * (a firm model must be scored before it is allowed to serve a route).
 */

export interface EvalTarget {
  provider: LlmProvider['kind'];
  /** Model used for every route, or per route when the platform maps routes to models. */
  modelFor(route: AiRoute): string;
  generate: Generator;
}

function generatorFor(llm: LlmProvider, modelFor: (r: AiRoute) => string, meter?: { orgId: string }): Generator {
  return async (_ctx, route, req) => {
    assertPlainRequest(req);
    const entry = REGISTRY[route];
    const model = modelFor(route);
    const started = Date.now();
    try {
      const result = await llm.generate({ system: req.system, prompt: req.prompt, model, json: entry.json, maxTokens: entry.maxTokens });
      if (meter) {
        await recordAiCall({ orgId: meter.orgId, route: `eval:${route}`, provider: result.provider, model, source: 'firm', outcome: { ok: true, result } });
      }
      return { text: result.text };
    } catch (err) {
      if (meter) {
        await recordAiCall({
          orgId: meter.orgId,
          route: `eval:${route}`,
          provider: llm.kind,
          model,
          source: 'firm',
          outcome: { ok: false, error: err, latencyMs: Date.now() - started },
        }).catch(() => undefined);
      }
      throw err;
    }
  };
}

/** Our self-hosted model as configured for this environment, or one model for every route. */
export function platformTarget(modelOverride?: string): EvalTarget {
  const { llm } = platformProviders();
  const modelFor = (r: AiRoute): string => modelOverride ?? config.llm.routeModels[r] ?? llm.defaultModel;
  return { provider: llm.kind, modelFor, generate: generatorFor(llm, modelFor) };
}

/** A firm's own model (BYO). Calls are metered to the firm, on routes named eval:<route>. */
export async function firmTarget(orgId: string, providerId: string): Promise<EvalTarget> {
  const settings = await firmProviderStore.settingsForCalls(orgId, providerId, config.llm.requestTimeoutMs);
  if (!settings) throw aiErrors.badResponse('openai_compatible', 'the provider was removed');
  const { llm } = buildProviders(settings, platformProviders().embeddings);
  const modelFor = (): string => settings.generationModel;
  return { provider: llm.kind, modelFor, generate: generatorFor(llm, modelFor, { orgId }) };
}
