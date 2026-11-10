import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { firmProviderStore } from '../ai/FirmProviderStore';
import { buildProviders, platformProviders } from '../ai/providers';
import { AI_ROUTES, AiRoute, REGISTRY, REGISTRY_VERSION, resolveRoute } from '../ai/registry';
import { config } from '../config/env';
import { audit, fromData, fromParam } from '../middleware/audit';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { requirePermission } from '../middleware/authorize';
import { dataService } from '../services/DataService';
import { AppError, ErrorCodes } from '../utils/AppError';
import { decodeCursor, encodeCursor, pageSize } from '../utils/pagination';
import { UnsafeUrlError, assertPublicHttpsUrl } from '../utils/ssrf';

/**
 * Firm AI settings (F7.1), for owners and admins (firm:manage):
 *   GET    /api/settings/ai                       platform default, per-route resolution, firm providers
 *   POST   /api/settings/ai-providers             add a provider; the key is stored encrypted, never returned
 *   POST   /api/settings/ai-providers/:id/test    connection test (reachable, key accepted, model present)
 *   PATCH  /api/settings/ai-providers/:id         rename or choose the routes it serves
 *   DELETE /api/settings/ai-providers/:id
 *   GET    /api/settings/ai-usage                 AI cost and tokens per project, estimates, open alerts
 *   PATCH  /api/settings/ai-usage/:projectId      set a project's AI cost and token estimates
 */
export const aiSettingsRouter = Router();

type Ctx = { orgId: string; userId: string };
const ctx = (req: Request): Ctx => {
  const { orgId, userId } = requireAuth(req);
  return { orgId, userId };
};
const guard = [authenticate, requirePermission('firm:manage')];
const handle =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

const id = (what: string) => z.string().uuid(`${what} must be a valid id`);
const route = z.enum(AI_ROUTES as unknown as [AiRoute, ...AiRoute[]], {
  errorMap: () => ({ message: `routes must be some of ${AI_ROUTES.join(', ')}` }),
});

const providerCreate = z
  .object({
    name: z.string({ required_error: 'name is required' }).trim().min(1, 'name is required').max(80, 'name must be at most 80 characters'),
    kind: z.enum(['openai_compatible', 'anthropic'], { errorMap: () => ({ message: 'kind must be openai_compatible or anthropic' }) }),
    baseUrl: z.string({ required_error: 'baseUrl is required' }).trim().max(500, 'baseUrl must be at most 500 characters'),
    generationModel: z.string({ required_error: 'generationModel is required' }).trim().min(1, 'generationModel is required').max(128),
    apiKey: z.string({ required_error: 'apiKey is required' }).min(8, 'apiKey looks too short').max(500, 'apiKey is too long'),
  })
  .strict();

const providerUpdate = z
  .object({
    name: z.string().trim().min(1, 'name is required').max(80, 'name must be at most 80 characters').optional(),
    enabledRoutes: z.array(route).max(AI_ROUTES.length).optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.enabledRoutes !== undefined, 'Nothing to update');

async function safeUrl(raw: string): Promise<string> {
  try {
    return (await assertPublicHttpsUrl(raw)).toString().replace(/\/+$/, '');
  } catch (err) {
    if (err instanceof UnsafeUrlError) throw new AppError(400, ErrorCodes.PROVIDER_URL_NOT_ALLOWED, err.message);
    throw err;
  }
}

async function mustGet(c: Ctx, providerId: string) {
  const p = await firmProviderStore.get(c.orgId, providerId);
  if (!p) throw new AppError(404, ErrorCodes.NOT_FOUND, 'AI provider not found');
  return p;
}

/** What the firm's AI calls use today, route by route. */
aiSettingsRouter.get(
  '/api/settings/ai',
  guard,
  handle(async (req, res) => {
    const c = ctx(req);
    const platform = platformProviders();
    const routes = [];
    for (const r of AI_ROUTES) {
      const resolved = await resolveRoute(c.orgId, r);
      routes.push({
        route: r,
        description: REGISTRY[r].description,
        promptVersion: REGISTRY[r].promptVersion,
        source: resolved.source,
        provider: resolved.llm.kind,
        model: resolved.model,
        firmProviderId: resolved.firmProviderId,
        firmModelNeedsEvaluation: REGISTRY[r].firmNeedsEval,
      });
    }
    res.status(200).json({
      success: true,
      data: {
        registryVersion: REGISTRY_VERSION,
        platform: { provider: platform.llm.kind, generationModel: platform.llm.defaultModel, embeddingModel: platform.embeddings.embeddingModel },
        routes,
        providers: await firmProviderStore.list(c.orgId),
      },
    });
  }),
);

/** Add a firm provider. The key is encrypted at rest and never returned; it must pass a test before use. */
aiSettingsRouter.post(
  '/api/settings/ai-providers',
  guard,
  audit('ai_provider.created', { targetType: 'ai_provider', targetId: fromData('id') }),
  handle(async (req, res) => {
    const c = ctx(req);
    const input = providerCreate.parse(req.body);
    const baseUrl = await safeUrl(input.baseUrl);
    try {
      const p = await firmProviderStore.create(c.orgId, c.userId, { ...input, baseUrl });
      res.status(201).json({ success: true, data: p });
    } catch (err) {
      if ((err as { constraint?: string }).constraint === 'firm_model_providers_org_name_uq') {
        throw new AppError(409, ErrorCodes.DUPLICATE_NAME, 'An AI provider with this name already exists');
      }
      throw err;
    }
  }),
);

/** Connection test: reachable, key accepted, model served. Failing clears the routes it served. */
aiSettingsRouter.post(
  '/api/settings/ai-providers/:providerId/test',
  guard,
  audit('ai_provider.tested', { targetType: 'ai_provider', targetId: fromParam('providerId') }),
  handle(async (req, res) => {
    const c = ctx(req);
    const providerId = id('providerId').parse(req.params.providerId);
    const p = await mustGet(c, providerId);
    let ok = false;
    let error: { code: string; message: string } | null = null;
    let latencyMs = 0;
    try {
      await safeUrl(p.baseUrl); // re-resolve: DNS may have changed since it was saved
      const settings = await firmProviderStore.settingsForCalls(c.orgId, providerId, Math.min(config.llm.requestTimeoutMs, 15_000));
      if (!settings) throw new AppError(404, ErrorCodes.NOT_FOUND, 'AI provider not found');
      const { llm } = buildProviders(settings, platformProviders().embeddings);
      const health = await llm.health([settings.generationModel]);
      latencyMs = health.latencyMs;
      ok = health.ok;
      if (!ok) error = health.error ?? { code: ErrorCodes.AI_MODEL_NOT_FOUND, message: `Model "${settings.generationModel}" is not served by this provider.` };
    } catch (err) {
      if (err instanceof AppError && err.status === 404) throw err;
      error =
        err instanceof AppError ? { code: err.code, message: err.message } : { code: ErrorCodes.AI_UNAVAILABLE, message: 'The provider could not be reached.' };
    }
    await dataService.query(
      c,
      'firm_model_providers',
      `UPDATE firm_model_providers
          SET test_status = CASE WHEN $2 THEN 'passed' ELSE 'failed' END, tested_at = now(), test_error = $3,
              enabled_routes = CASE WHEN $2 THEN enabled_routes ELSE '{}' END, updated_at = now()
        WHERE id = $1 AND org_id = current_setting('app.org_id')::uuid`,
      [providerId, ok, error ? `${error.code}: ${error.message}`.slice(0, 300) : null],
    );
    res.status(200).json({ success: true, data: { passed: ok, latencyMs, error, provider: await mustGet(c, providerId) } });
  }),
);

/** Rename, or choose the routes this provider serves (one firm provider per route). */
aiSettingsRouter.patch(
  '/api/settings/ai-providers/:providerId',
  guard,
  audit('ai_provider.updated', { targetType: 'ai_provider', targetId: fromParam('providerId') }),
  handle(async (req, res) => {
    const c = ctx(req);
    const providerId = id('providerId').parse(req.params.providerId);
    const input = providerUpdate.parse(req.body);
    const p = await mustGet(c, providerId);
    const routes = input.enabledRoutes ? [...new Set(input.enabledRoutes)] : undefined;
    if (routes?.length && p.testStatus !== 'passed') {
      throw new AppError(409, ErrorCodes.PROVIDER_NOT_TESTED, 'Run a successful connection test before enabling this provider for any AI route.');
    }
    const needsEval = routes?.filter((r) => REGISTRY[r].firmNeedsEval) ?? [];
    if (needsEval.length && p.evalStatus !== 'passed') {
      throw new AppError(
        409,
        ErrorCodes.EVALUATION_REQUIRED,
        `This model must pass the evaluation gate before it can be used for ${needsEval.join(', ')}. Other routes can be enabled now.`,
      );
    }
    await dataService.transaction(c, async (tx) => {
      if (routes) {
        // A route is served by at most one firm provider: take it from any other.
        await tx.query(
          'firm_model_providers',
          `UPDATE firm_model_providers
              SET enabled_routes = ARRAY(SELECT x FROM unnest(enabled_routes) x WHERE NOT x = ANY($2::text[])), updated_at = now()
            WHERE org_id = current_setting('app.org_id')::uuid AND id <> $1 AND enabled_routes && $2::text[]`,
          [providerId, routes],
        );
      }
      try {
        await tx.query(
          'firm_model_providers',
          `UPDATE firm_model_providers SET name = COALESCE($2, name), enabled_routes = COALESCE($3::text[], enabled_routes), updated_at = now()
            WHERE id = $1 AND org_id = current_setting('app.org_id')::uuid`,
          [providerId, input.name ?? null, routes ?? null],
        );
      } catch (err) {
        if ((err as { constraint?: string }).constraint === 'firm_model_providers_org_name_uq') {
          throw new AppError(409, ErrorCodes.DUPLICATE_NAME, 'An AI provider with this name already exists');
        }
        throw err;
      }
    });
    res.status(200).json({ success: true, data: await mustGet(c, providerId) });
  }),
);

/** Remove a firm provider (its routes fall back to our platform models at once). */
aiSettingsRouter.delete(
  '/api/settings/ai-providers/:providerId',
  guard,
  audit('ai_provider.deleted', { targetType: 'ai_provider', targetId: fromParam('providerId') }),
  handle(async (req, res) => {
    const c = ctx(req);
    const providerId = id('providerId').parse(req.params.providerId);
    const rows = await dataService.query(
      c,
      'firm_model_providers',
      `DELETE FROM firm_model_providers WHERE id = $1 AND org_id = current_setting('app.org_id')::uuid RETURNING id`,
      [providerId],
    );
    if (!rows.length) throw new AppError(404, ErrorCodes.NOT_FOUND, 'AI provider not found');
    res.status(204).end();
  }),
);

/** AI cost and tokens per project with estimates and open 2x alerts (newest projects first). */
aiSettingsRouter.get(
  '/api/settings/ai-usage',
  guard,
  handle(async (req, res) => {
    const c = ctx(req);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(50).optional(), cursor: z.string().max(200).optional() }).parse(req.query);
    const size = pageSize(q.limit);
    const cur = decodeCursor(q.cursor);
    const rows = await dataService.query<{
      id: string;
      name: string;
      created_at: Date;
      ai_cost_estimate_usd: string | null;
      ai_token_estimate: string | null;
      calls: number | null;
      failed_calls: number | null;
      input_tokens: string | null;
      output_tokens: string | null;
      cost_usd: string | null;
      unpriced_calls: number | null;
      open_alerts: string[] | null;
    }>(
      c,
      'projects',
      `SELECT p.id, p.name, p.created_at, p.ai_cost_estimate_usd, p.ai_token_estimate,
              u.calls, u.failed_calls, u.input_tokens, u.output_tokens, u.cost_usd, u.unpriced_calls,
              (SELECT array_agg(a.kind ORDER BY a.kind) FROM ai_cost_alerts a WHERE a.project_id = p.id AND a.acknowledged_at IS NULL) AS open_alerts
         FROM projects p LEFT JOIN ai_project_usage u ON u.project_id = p.id
        WHERE p.org_id = current_setting('app.org_id')::uuid
          AND ($1::timestamptz IS NULL OR (p.created_at, p.id) < ($1::timestamptz, $2::uuid))
        ORDER BY p.created_at DESC, p.id DESC LIMIT $3`,
      [cur.createdAt, cur.id, size + 1],
    );
    const page = rows.slice(0, size);
    const last = page[page.length - 1];
    res.status(200).json({
      success: true,
      data: {
        items: page.map((r) => ({
          projectId: r.id,
          projectName: r.name,
          calls: r.calls ?? 0,
          failedCalls: r.failed_calls ?? 0,
          inputTokens: Number(r.input_tokens ?? 0),
          outputTokens: Number(r.output_tokens ?? 0),
          costUsd: Number(r.cost_usd ?? 0),
          unpricedCalls: r.unpriced_calls ?? 0,
          costEstimateUsd: r.ai_cost_estimate_usd === null ? null : Number(r.ai_cost_estimate_usd),
          tokenEstimate: r.ai_token_estimate === null ? null : Number(r.ai_token_estimate),
          openAlerts: r.open_alerts ?? [],
        })),
        nextCursor: rows.length > size && last ? encodeCursor(last.created_at, last.id) : null,
      },
    });
  }),
);

/** Set (or clear with null) a project's AI cost and token estimates; alerts fire at 2x. */
aiSettingsRouter.patch(
  '/api/settings/ai-usage/:projectId',
  guard,
  audit('project.ai_estimate_set', { targetType: 'project', targetId: fromParam('projectId') }),
  handle(async (req, res) => {
    const c = ctx(req);
    const projectId = id('projectId').parse(req.params.projectId);
    const input = z
      .object({
        costEstimateUsd: z.number().positive('costEstimateUsd must be positive').max(1_000_000).nullable().optional(),
        tokenEstimate: z.number().int().positive('tokenEstimate must be a positive whole number').max(1_000_000_000_000).nullable().optional(),
      })
      .strict()
      .refine((v) => v.costEstimateUsd !== undefined || v.tokenEstimate !== undefined, 'Nothing to update')
      .parse(req.body);
    const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k);
    const [row] = await dataService.query<{ id: string; ai_cost_estimate_usd: string | null; ai_token_estimate: string | null }>(
      c,
      'projects',
      `UPDATE projects SET
          ai_cost_estimate_usd = CASE WHEN $2 THEN $3::numeric ELSE ai_cost_estimate_usd END,
          ai_token_estimate = CASE WHEN $4 THEN $5::bigint ELSE ai_token_estimate END,
          updated_at = now()
        WHERE id = $1 AND org_id = current_setting('app.org_id')::uuid
        RETURNING id, ai_cost_estimate_usd, ai_token_estimate`,
      [projectId, has('costEstimateUsd'), input.costEstimateUsd ?? null, has('tokenEstimate'), input.tokenEstimate ?? null],
    );
    if (!row) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
    res.status(200).json({
      success: true,
      data: {
        projectId: row.id,
        costEstimateUsd: row.ai_cost_estimate_usd === null ? null : Number(row.ai_cost_estimate_usd),
        tokenEstimate: row.ai_token_estimate === null ? null : Number(row.ai_token_estimate),
      },
    });
  }),
);
