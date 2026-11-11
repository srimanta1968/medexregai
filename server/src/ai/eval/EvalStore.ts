import { dataService } from '../../services/DataService';
import { AppError, ErrorCodes } from '../../utils/AppError';
import { OUTPUT_SCHEMA_VERSION } from '../guard/outputSchemas';
import { REGISTRY_VERSION } from '../registry';
import { EvalReport, runEvaluation, THRESHOLDS } from './runner';
import { EVAL_SETS_VERSION } from './sets';
import { firmTarget } from './targets';

/**
 * Evaluation runs (F7.4). A firm admin queues an evaluation of the firm's own model;
 * the worker runs it (long work never runs in a request) and records the scores.
 * Passing sets the provider's eval_status to passed, which is what allows it to
 * serve drafting (F7.1 AC7); failing takes drafting away again.
 * Platform (baseline) runs are recorded by `npm run eval`.
 */

export type EvalStatus = 'queued' | 'running' | 'passed' | 'failed' | 'error';

export interface EvalRun {
  id: string;
  status: EvalStatus;
  provider: string | null;
  model: string | null;
  setsVersion: string;
  registryVersion: string;
  checksVersion: string;
  scores: Partial<EvalReport['scores']>;
  thresholds: Partial<typeof THRESHOLDS>;
  failures: EvalReport['failures'];
  error: string | null;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

interface RunRow {
  id: string;
  status: EvalStatus;
  provider: string | null;
  model: string | null;
  sets_version: string;
  registry_version: string;
  checks_version: string;
  scores: EvalRun['scores'];
  thresholds: EvalRun['thresholds'];
  failures: EvalRun['failures'];
  error: string | null;
  created_at?: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const toRun = (r: RunRow): EvalRun => ({
  id: r.id,
  status: r.status,
  provider: r.provider,
  model: r.model,
  setsVersion: r.sets_version,
  registryVersion: r.registry_version,
  checksVersion: r.checks_version,
  scores: r.scores,
  thresholds: r.thresholds,
  failures: r.failures,
  error: r.error,
  createdAt: iso(r.created_at),
  startedAt: iso(r.started_at),
  finishedAt: iso(r.finished_at),
});

const COLUMNS = `id, status, provider, model, sets_version, registry_version, checks_version, scores, thresholds, failures, error`;
/** A run still "running" after this long lost its worker; it is closed as an error. */
const STALE_AFTER = '2 hours';

export class EvalStore {
  /** Queue an evaluation of the firm's own model. */
  async request(orgId: string, userId: string, providerId: string): Promise<EvalRun> {
    return dataService.transaction({ orgId, userId }, async (tx) => {
      const [p] = await tx.query<{ test_status: string }>(
        'firm_model_providers',
        `SELECT test_status FROM firm_model_providers WHERE org_id = current_setting('app.org_id')::uuid AND id = $1 FOR UPDATE`,
        [providerId],
      );
      if (!p) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Provider not found');
      if (p.test_status !== 'passed') {
        throw new AppError(409, ErrorCodes.PROVIDER_NOT_TESTED, 'Run the connection test first; only a provider that passed it can be evaluated.');
      }
      const [active] = await tx.query<{ id: string }>(
        'eval_runs',
        `SELECT id FROM eval_runs WHERE org_id = current_setting('app.org_id')::uuid AND provider_id = $1 AND status IN ('queued', 'running')`,
        [providerId],
      );
      if (active) throw new AppError(409, ErrorCodes.EVALUATION_RUNNING, 'An evaluation of this provider is already queued or running.');
      const [row] = await tx.query<RunRow>(
        'eval_runs',
        `INSERT INTO eval_runs (org_id, provider_id, status, sets_version, registry_version, checks_version, thresholds, requested_by)
         VALUES (current_setting('app.org_id')::uuid, $1, 'queued', $2, $3, $4, $5::jsonb, $6)
         RETURNING ${COLUMNS}, created_at, started_at, finished_at`,
        [providerId, EVAL_SETS_VERSION, REGISTRY_VERSION, OUTPUT_SCHEMA_VERSION, JSON.stringify(THRESHOLDS), userId],
      );
      await tx.query(
        'firm_model_providers',
        `UPDATE firm_model_providers SET eval_status = 'running', updated_at = now()
          WHERE org_id = current_setting('app.org_id')::uuid AND id = $1 AND eval_status <> 'passed'`,
        [providerId],
      );
      return toRun(row);
    });
  }

  /** The provider's evaluations, newest first. */
  async list(orgId: string, providerId: string, limit = 10): Promise<EvalRun[]> {
    const [p] = await dataService.query<{ id: string }>(
      { orgId },
      'firm_model_providers',
      `SELECT id FROM firm_model_providers WHERE org_id = current_setting('app.org_id')::uuid AND id = $1`,
      [providerId],
    );
    if (!p) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Provider not found');
    const rows = await dataService.query<RunRow>(
      { orgId },
      'eval_runs',
      `SELECT ${COLUMNS}, created_at, started_at, finished_at FROM eval_runs
        WHERE org_id = current_setting('app.org_id')::uuid AND provider_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [providerId, limit],
    );
    return rows.map(toRun);
  }

  /** The latest run of our own model: the baseline a firm model is compared with. */
  async latestPlatform(): Promise<(EvalRun & { note: string | null }) | null> {
    const [row] = await dataService.query<RunRow & { note: string | null }>(
      {},
      'platform_eval_runs',
      `SELECT ${COLUMNS}, note, started_at, finished_at FROM platform_eval_runs ORDER BY finished_at DESC LIMIT 1`,
    );
    return row ? { ...toRun(row), note: row.note } : null;
  }

  async recordPlatform(input: { provider: string; model: string; report: EvalReport | null; error?: string; note?: string; startedAt: Date }): Promise<string> {
    const r = input.report;
    const [row] = await dataService.query<{ id: string }>(
      {},
      'platform_eval_runs',
      `INSERT INTO platform_eval_runs (status, provider, model, sets_version, registry_version, checks_version, scores, thresholds, failures, error, note, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12) RETURNING id`,
      [
        r ? (r.passed ? 'passed' : 'failed') : 'error',
        input.provider,
        input.model.slice(0, 128),
        EVAL_SETS_VERSION,
        REGISTRY_VERSION,
        OUTPUT_SCHEMA_VERSION,
        JSON.stringify(r?.scores ?? {}),
        JSON.stringify(THRESHOLDS),
        JSON.stringify(r?.failures ?? []),
        input.error?.slice(0, 2000) ?? null,
        input.note?.slice(0, 500) ?? null,
        input.startedAt,
      ],
    );
    return row.id;
  }

  /** Worker pass: run each firm's oldest queued evaluation; close runs that lost their worker. */
  async processQueued(): Promise<{ ran: number; stale: number }> {
    let ran = 0;
    let stale = 0;
    const orgs = await dataService.query<{ id: string }>({}, 'orgs', "SELECT id FROM orgs WHERE status = 'active' ORDER BY id");
    for (const { id: orgId } of orgs) {
      const closed = await dataService.query<{ provider_id: string }>(
        { orgId },
        'eval_runs',
        `UPDATE eval_runs SET status = 'error', error = 'The evaluation stopped before it finished; run it again.', finished_at = now()
          WHERE org_id = $1 AND status = 'running' AND started_at < now() - interval '${STALE_AFTER}' RETURNING provider_id`,
        [orgId],
      );
      for (const c of closed) await this.settleProvider(orgId, c.provider_id, 'failed');
      stale += closed.length;

      const [claimed] = await dataService.query<{ id: string; provider_id: string }>(
        { orgId },
        'eval_runs',
        `UPDATE eval_runs SET status = 'running', started_at = now()
          WHERE id = (SELECT id FROM eval_runs WHERE org_id = $1 AND status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING id, provider_id`,
        [orgId],
      );
      if (!claimed) continue;
      await this.runClaimed(orgId, claimed.id, claimed.provider_id);
      ran += 1;
    }
    return { ran, stale };
  }

  private async runClaimed(orgId: string, runId: string, providerId: string): Promise<void> {
    try {
      const target = await firmTarget(orgId, providerId);
      const report = await runEvaluation({ orgId }, target.generate);
      await dataService.query(
        { orgId },
        'eval_runs',
        `UPDATE eval_runs SET status = $3, provider = $4, model = $5, scores = $6::jsonb, failures = $7::jsonb, finished_at = now()
          WHERE id = $1 AND org_id = $2`,
        [
          runId,
          orgId,
          report.passed ? 'passed' : 'failed',
          target.provider,
          target.modelFor('draft'),
          JSON.stringify(report.scores),
          JSON.stringify(report.failures),
        ],
      );
      await this.settleProvider(orgId, providerId, report.passed ? 'passed' : 'failed');
    } catch (err) {
      await dataService.query({ orgId }, 'eval_runs', `UPDATE eval_runs SET status = 'error', error = $3, finished_at = now() WHERE id = $1 AND org_id = $2`, [
        runId,
        orgId,
        (err as Error).message.slice(0, 2000),
      ]);
      await this.settleProvider(orgId, providerId, 'failed');
    }
  }

  /** Passing allows drafting; anything else removes drafting from the routes the model serves. */
  private async settleProvider(orgId: string, providerId: string, outcome: 'passed' | 'failed'): Promise<void> {
    await dataService.query(
      { orgId },
      'firm_model_providers',
      `UPDATE firm_model_providers
          SET eval_status = $3::varchar, eval_at = now(), updated_at = now(),
              enabled_routes = CASE WHEN $3::varchar = 'passed' THEN enabled_routes ELSE array_remove(enabled_routes, 'draft') END
        WHERE id = $1 AND org_id = $2`,
      [providerId, orgId, outcome],
    );
  }
}

export const evalStore = new EvalStore();
