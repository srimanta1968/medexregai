import { config } from '../config/env';
import { recordAiCall } from './AiMeter';
import { firmProviderStore } from './FirmProviderStore';
import { buildProviders, platformProviders } from './providers';
import { GenerateRequest, GenerateResult, LlmProvider } from './types';

/**
 * Versioned AI route registry (F7.1). Every AI call in the product names a route;
 * the registry decides which provider and model answer it and which prompt version
 * the caller must use. Defaults are our self-hosted models (architecture A2).
 *
 * Resolution order for a route:
 *   1. the firm's own provider enabled for that route (passed its connection test;
 *      drafting also needs the evaluation gate, enforced by the database);
 *   2. this environment's model for the route (AI_ROUTE_MODELS);
 *   3. the platform default generation model (AI_GENERATION_MODEL).
 *
 * Bump REGISTRY_VERSION whenever an entry changes; it is recorded with every draft
 * so outputs can be traced to the configuration that produced them.
 */

export const AI_ROUTES = ['triage', 'classify', 'extract', 'contradiction', 'draft', 'request_wording'] as const;
export type AiRoute = (typeof AI_ROUTES)[number];

export const REGISTRY_VERSION = '2026-11-11.1';

export interface RouteEntry {
  route: AiRoute;
  description: string;
  /** Prompt template version the caller must use for this route. */
  promptVersion: string;
  /** Structured output (JSON) or prose. */
  json: boolean;
  maxTokens: number;
  /** Whether a firm-supplied model needs the evaluation gate before it may serve this route. */
  firmNeedsEval: boolean;
  /**
   * Document routes read client files, which are untrusted input (NFR-16): their text
   * reaches the model only as delimited data (ai/guard) and their outputs are checked.
   */
  documentInput: true;
  /** Tools a model may call on this route. Always none: no route can act on what a document says. */
  tools: readonly [];
}

export const REGISTRY: Record<AiRoute, RouteEntry> = {
  triage: {
    route: 'triage',
    description: 'Is a file in scope for the submission; which client folder it belongs to',
    promptVersion: 'triage.v1',
    json: true,
    maxTokens: 512,
    firmNeedsEval: false,
    documentInput: true,
    tools: [],
  },
  classify: {
    route: 'classify',
    description: 'Sort a file into an eSTAR section',
    promptVersion: 'classify.v1',
    json: true,
    maxTokens: 512,
    firmNeedsEval: false,
    documentInput: true,
    tools: [],
  },
  extract: {
    route: 'extract',
    description: 'Pull facts (values, units, standards, dates) with their source location',
    promptVersion: 'extract.v1',
    json: true,
    maxTokens: 2048,
    firmNeedsEval: false,
    documentInput: true,
    tools: [],
  },
  contradiction: {
    route: 'contradiction',
    description: 'Compare two cited passages that may disagree',
    promptVersion: 'contradiction.v1',
    json: true,
    maxTokens: 1024,
    firmNeedsEval: false,
    documentInput: true,
    tools: [],
  },
  draft: {
    route: 'draft',
    description: 'Draft submission prose; every sentence must cite a source',
    promptVersion: 'draft.v1',
    json: false,
    maxTokens: 4096,
    firmNeedsEval: true,
    documentInput: true,
    tools: [],
  },
  request_wording: {
    route: 'request_wording',
    description: 'Word a request to the client for missing evidence',
    promptVersion: 'request_wording.v1',
    json: false,
    maxTokens: 1024,
    firmNeedsEval: false,
    documentInput: true,
    tools: [],
  },
};

export const isAiRoute = (r: string): r is AiRoute => (AI_ROUTES as readonly string[]).includes(r);

export interface ResolvedRoute {
  entry: RouteEntry;
  llm: LlmProvider;
  model: string;
  source: 'platform' | 'firm';
  firmProviderId: string | null;
  registryVersion: string;
}

/** Resolve which provider and model serve a route for a firm. */
export async function resolveRoute(orgId: string, route: AiRoute): Promise<ResolvedRoute> {
  const entry = REGISTRY[route];
  const firm = await firmProviderStore.forRoute(orgId, route);
  if (firm && (!entry.firmNeedsEval || firm.evalStatus === 'passed')) {
    const settings = await firmProviderStore.settingsForCalls(orgId, firm.id, config.llm.requestTimeoutMs);
    if (settings) {
      const { llm } = buildProviders(settings, platformProviders().embeddings);
      return { entry, llm, model: settings.generationModel, source: 'firm', firmProviderId: firm.id, registryVersion: REGISTRY_VERSION };
    }
  }
  const { llm } = platformProviders();
  return {
    entry,
    llm,
    model: config.llm.routeModels[route] ?? llm.defaultModel,
    source: 'platform',
    firmProviderId: null,
    registryVersion: REGISTRY_VERSION,
  };
}

const PLAIN_FIELDS = new Set(['system', 'prompt', 'maxTokens']);

/** Refuses a request that carries anything but instructions and a prompt (no tools on any route). */
export function assertPlainRequest(req: object): void {
  const extra = Object.keys(req).filter((k) => !PLAIN_FIELDS.has(k));
  if (extra.length) throw new Error(`AI requests take only system, prompt and maxTokens; refused: ${extra.join(', ')}`);
}

export interface AiContext {
  orgId: string;
  projectId?: string | null;
}

export interface AiGenerateResult extends GenerateResult {
  /** The ai_calls row for this call. */
  callId: string;
  route: AiRoute;
  source: 'platform' | 'firm';
  promptVersion: string;
  registryVersion: string;
  costUsd: number | null;
}

/**
 * The one way product code calls a generation model: resolve the route, call it,
 * meter the call (success or failure), and report what answered. Errors are typed
 * AiErrors (retryable or not) and are metered before they are rethrown.
 */
export async function aiGenerate(
  ctx: AiContext,
  route: AiRoute,
  req: Omit<GenerateRequest, 'model' | 'json' | 'maxTokens'> & { maxTokens?: number },
): Promise<AiGenerateResult> {
  assertPlainRequest(req);
  const r = await resolveRoute(ctx.orgId, route);
  const started = Date.now();
  try {
    // Built field by field: nothing a caller adds (tools, functions, extra messages) reaches a provider.
    const result = await r.llm.generate({
      system: req.system,
      prompt: req.prompt,
      model: r.model,
      json: r.entry.json,
      maxTokens: req.maxTokens ?? r.entry.maxTokens,
    });
    const meter = await recordAiCall({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      route,
      provider: result.provider,
      model: r.model,
      source: r.source,
      outcome: { ok: true, result },
    });
    return {
      ...result,
      callId: meter.callId,
      route,
      source: r.source,
      promptVersion: r.entry.promptVersion,
      registryVersion: r.registryVersion,
      costUsd: meter.costUsd,
    };
  } catch (error) {
    await recordAiCall({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      route,
      provider: r.llm.kind,
      model: r.model,
      source: r.source,
      outcome: { ok: false, error, latencyMs: Date.now() - started },
    }).catch((e: unknown) => console.warn(`[ai] metering a failed call failed: ${(e as Error).message}`));
    throw error;
  }
}
