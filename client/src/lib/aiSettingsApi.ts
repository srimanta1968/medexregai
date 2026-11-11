/** Typed client for the firm AI settings API (server/src/routes/aiSettings.ts, F7.1). */

type Request = <T>(path: string, init?: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown }) => Promise<T>;

export type AiRoute = 'triage' | 'classify' | 'extract' | 'contradiction' | 'draft' | 'request_wording';

export const ROUTE_LABELS: Record<AiRoute, string> = {
  triage: 'Triage',
  classify: 'Sorting into eSTAR sections',
  extract: 'Fact extraction',
  contradiction: 'Contradiction checks',
  draft: 'Drafting',
  request_wording: 'Client request wording',
};

export interface RouteUse {
  route: AiRoute;
  description: string;
  promptVersion: string;
  source: 'platform' | 'firm';
  provider: string;
  model: string;
  firmProviderId: string | null;
  firmModelNeedsEvaluation: boolean;
  /** Prompt-injection defence for the route (F7.5). */
  guard: {
    documentInput: boolean;
    dataBlocks: boolean;
    tools: string[];
    outputCheck: string;
    last30Days: { checked: number; rejected: number; flaggedInputs: number };
  };
}

export interface FirmProvider {
  id: string;
  name: string;
  kind: 'openai_compatible' | 'anthropic';
  baseUrl: string;
  generationModel: string;
  keyHint: string;
  testStatus: 'untested' | 'passed' | 'failed';
  testedAt: string | null;
  testError: string | null;
  evalStatus: 'not_run' | 'running' | 'passed' | 'failed';
  evalAt: string | null;
  enabledRoutes: AiRoute[];
  createdAt: string;
}

/** Gold-set scores of one evaluation run (F7.4). Shares are 0..1. */
export interface EvalScores {
  classification?: { accuracy: number; correct: number; n: number };
  contradiction?: { precision: number; recall: number; n: number };
  drafting?: { acceptance: number; citationPrecision: number | null; n: number };
  injection?: { resistance: number; n: number };
  versions?: { status: 'not_run'; reason: string; n: number };
}

export interface EvalThresholds {
  classification: number;
  contradiction: number;
  drafting: number;
  injection: number;
}

export interface EvalRun {
  id: string;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'error';
  provider: string | null;
  model: string | null;
  setsVersion: string;
  scores: EvalScores;
  failures: { set: string; id: string; why: string }[];
  error: string | null;
  createdAt: string | null;
  finishedAt: string | null;
}

export interface AiSettings {
  registryVersion: string;
  outputSchemaVersion: string;
  evaluation: { setsVersion: string; thresholds: EvalThresholds; platform: (EvalRun & { note: string | null }) | null };
  platform: { provider: string; generationModel: string; embeddingModel: string };
  routes: RouteUse[];
  providers: FirmProvider[];
}

export interface PlatformHealth {
  checkedAt: string;
  platform: {
    provider: string;
    endpoint: string;
    ok: boolean;
    models: { name: string; available: boolean }[];
    latencyMs: number;
    error?: { code: string; message: string; retryable: boolean };
  };
}

export interface ConnectionTest {
  passed: boolean;
  latencyMs: number;
  error: { code: string; message: string } | null;
  provider: FirmProvider;
}

export interface ProjectUsage {
  projectId: string;
  projectName: string;
  calls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  unpricedCalls: number;
  costEstimateUsd: number | null;
  tokenEstimate: number | null;
  openAlerts: ('cost' | 'tokens')[];
}

export interface NewProvider {
  name: string;
  kind: FirmProvider['kind'];
  baseUrl: string;
  generationModel: string;
  apiKey: string;
}

export function aiSettingsApi(request: Request) {
  const id = encodeURIComponent;
  return {
    settings: () => request<AiSettings>('/api/settings/ai'),
    health: () => request<PlatformHealth>('/api/settings/ai/health'),
    addProvider: (body: NewProvider) => request<FirmProvider>('/api/settings/ai-providers', { method: 'POST', body }),
    testProvider: (providerId: string) => request<ConnectionTest>(`/api/settings/ai-providers/${id(providerId)}/test`, { method: 'POST' }),
    setRoutes: (providerId: string, enabledRoutes: AiRoute[]) =>
      request<FirmProvider>(`/api/settings/ai-providers/${id(providerId)}`, { method: 'PATCH', body: { enabledRoutes } }),
    evaluate: (providerId: string) => request<EvalRun>(`/api/settings/ai-providers/${id(providerId)}/evaluation`, { method: 'POST' }),
    evaluations: (providerId: string) => request<{ items: EvalRun[]; thresholds: EvalThresholds }>(`/api/settings/ai-providers/${id(providerId)}/evaluations`),
    deleteProvider: (providerId: string) => request<void>(`/api/settings/ai-providers/${id(providerId)}`, { method: 'DELETE' }),
    usage: (cursor?: string) =>
      request<{ items: ProjectUsage[]; nextCursor: string | null }>(`/api/settings/ai-usage?limit=50${cursor ? `&cursor=${id(cursor)}` : ''}`),
    setEstimates: (projectId: string, body: { costEstimateUsd?: number | null; tokenEstimate?: number | null }) =>
      request<{ projectId: string; costEstimateUsd: number | null; tokenEstimate: number | null }>(`/api/settings/ai-usage/${id(projectId)}`, {
        method: 'PATCH',
        body,
      }),
  };
}
