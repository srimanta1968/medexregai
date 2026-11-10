import { config } from '../config/env';
import { dataService } from '../services/DataService';
import { mailService } from '../services/MailService';
import { AiError } from './errors';
import { callCostUsd } from './pricing';
import { GenerateResult, ProviderKind } from './types';

/**
 * AI metering (F7.1): every AI request is recorded with route, provider, model,
 * tokens and cost; project totals are updated in the same transaction; and the
 * first time a project's cost or tokens pass 2x its estimate, an alert row is
 * raised and the operator is told.
 */

export const ALERT_MULTIPLIER = 2;

export interface MeterInput {
  orgId: string;
  projectId?: string | null;
  route: string;
  provider: ProviderKind;
  model: string;
  source: 'platform' | 'firm';
  outcome: { ok: true; result: Pick<GenerateResult, 'usage' | 'latencyMs' | 'model'> } | { ok: false; error: unknown; latencyMs: number };
}

export interface RaisedAlert {
  projectId: string;
  kind: 'cost' | 'tokens';
  estimate: number;
  actual: number;
}

export interface MeterRecord {
  callId: string;
  costUsd: number | null;
  alerts: RaisedAlert[];
}

export async function recordAiCall(input: MeterInput): Promise<MeterRecord> {
  const ok = input.outcome.ok;
  const usage = ok ? input.outcome.result.usage : { inputTokens: 0, outputTokens: 0 };
  // The model that actually answered (a server-side fallback can differ from the one asked for).
  const model = ok ? input.outcome.result.model : input.model;
  const cost = ok ? callCostUsd(input.provider, model, usage, input.source) : 0;
  const latency = ok ? input.outcome.result.latencyMs : input.outcome.latencyMs;
  const errorCode = ok ? null : input.outcome.error instanceof AiError ? input.outcome.error.code : 'UNKNOWN';

  const record = await dataService.transaction({ orgId: input.orgId }, async (tx) => {
    const [call] = await tx.query<{ id: string }>(
      'ai_calls',
      `INSERT INTO ai_calls (org_id, project_id, route, provider, model, source, input_tokens, output_tokens, cost_usd, latency_ms, status, error_code)
       VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [input.projectId ?? null, input.route, input.provider, model, input.source, usage.inputTokens, usage.outputTokens, cost, latency, ok ? 'ok' : 'error', errorCode]
    );
    const alerts: RaisedAlert[] = [];
    if (input.projectId) {
      const [totals] = await tx.query<{ cost_usd: string; tokens: string; cost_estimate: string | null; token_estimate: string | null }>(
        'ai_project_usage',
        `WITH up AS (
           INSERT INTO ai_project_usage AS u (project_id, org_id, calls, failed_calls, input_tokens, output_tokens, cost_usd, unpriced_calls)
           VALUES ($1, current_setting('app.org_id')::uuid, 1, $2, $3, $4, COALESCE($5::numeric, 0), $6)
           ON CONFLICT (project_id) DO UPDATE SET
             calls = u.calls + 1,
             failed_calls = u.failed_calls + EXCLUDED.failed_calls,
             input_tokens = u.input_tokens + EXCLUDED.input_tokens,
             output_tokens = u.output_tokens + EXCLUDED.output_tokens,
             cost_usd = u.cost_usd + EXCLUDED.cost_usd,
             unpriced_calls = u.unpriced_calls + EXCLUDED.unpriced_calls,
             updated_at = now()
           RETURNING u.cost_usd, u.input_tokens + u.output_tokens AS tokens)
         SELECT up.cost_usd, up.tokens, p.ai_cost_estimate_usd AS cost_estimate, p.ai_token_estimate AS token_estimate
           FROM up, projects p WHERE p.id = $1`,
        [input.projectId, ok ? 0 : 1, usage.inputTokens, usage.outputTokens, cost, ok && cost === null ? 1 : 0]
      );
      const checks: { kind: 'cost' | 'tokens'; estimate: number | null; actual: number }[] = [
        { kind: 'cost', estimate: totals.cost_estimate === null ? null : Number(totals.cost_estimate), actual: Number(totals.cost_usd) },
        { kind: 'tokens', estimate: totals.token_estimate === null ? null : Number(totals.token_estimate), actual: Number(totals.tokens) },
      ];
      for (const c of checks) {
        if (c.estimate === null || c.actual < c.estimate * ALERT_MULTIPLIER) continue;
        // UNIQUE (project_id, kind): raised once, then left for the operator to acknowledge.
        const raised = await tx.query<{ id: string }>(
          'ai_cost_alerts',
          `INSERT INTO ai_cost_alerts (org_id, project_id, kind, estimate, actual)
           VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4)
           ON CONFLICT (project_id, kind) DO NOTHING RETURNING id`,
          [input.projectId, c.kind, c.estimate, c.actual]
        );
        if (raised.length) alerts.push({ projectId: input.projectId, kind: c.kind, estimate: c.estimate, actual: c.actual });
      }
    }
    return { callId: call.id, costUsd: cost, alerts };
  });

  for (const a of record.alerts) notifyOperator(input.orgId, a);
  return record;
}

function notifyOperator(orgId: string, a: RaisedAlert): void {
  const what = a.kind === 'cost' ? `AI cost $${a.actual.toFixed(2)} against an estimate of $${a.estimate.toFixed(2)}` : `${a.actual.toLocaleString()} AI tokens against an estimate of ${a.estimate.toLocaleString()}`;
  const line = `[ai-meter] ALERT project ${a.projectId} (org ${orgId}): ${what} (>= ${ALERT_MULTIPLIER}x)`;
  console.warn(line);
  if (!config.ops.alertEmail) return;
  // Best effort: the alert row is stored even if the email cannot be sent.
  mailService
    .send({ to: config.ops.alertEmail, subject: `AI usage alert: project passed ${ALERT_MULTIPLIER}x its estimate`, text: `${line}\n\nAcknowledge it in ai_cost_alerts.` })
    .catch((err: unknown) => console.warn(`[ai-meter] alert email failed: ${(err as Error).message}`));
}
