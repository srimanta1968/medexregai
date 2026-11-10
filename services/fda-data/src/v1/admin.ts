import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireScope } from '../auth/apiClients';
import { q } from '../db/pool';
import { Codes, ServiceError } from '../errors';
import { DATASETS } from './catalog';

/**
 * fda-data admin API (scope fda:admin). Sync runs are listed from fda_sync_runs;
 * a manual sync is only queued here (sync_requests) and run by the worker, never
 * inline in the request (ADR-017).
 */
export const v1AdminRouter = Router();
const guard = requireScope('fda:admin');

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'dates must be YYYY-MM-DD');
const dataset = z.enum(DATASETS as [string, ...string[]], {
  errorMap: () => ({
    message: `dataset must be one of ${DATASETS.join(', ')}`,
  }),
});

const handle =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** Sync runs, newest first, cursor = last id seen. */
v1AdminRouter.get(
  '/v1/admin/sync-runs',
  guard,
  handle(async (req, res) => {
    const p = z
      .object({
        dataset: dataset.optional(),
        status: z.enum(['running', 'succeeded', 'failed']).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        cursor: z
          .string()
          .regex(/^\d{1,18}$/, 'cursor is invalid')
          .optional(),
      })
      .parse(req.query);
    const rows = await q<{
      id: string;
      dataset: string;
      mode: string;
      status: string;
      started_at: Date;
      finished_at: Date | null;
      window_from: string | null;
      window_to: string | null;
      records_upserted: number;
      source_last_updated: string | null;
      error: string | null;
    }>(
      `SELECT id, dataset, mode, status, started_at, finished_at, window_from::text, window_to::text, records_upserted,
              source_last_updated::text, error
         FROM fda_sync_runs
        WHERE ($1::text IS NULL OR dataset = $1) AND ($2::text IS NULL OR status = $2) AND ($3::bigint IS NULL OR id < $3)
        ORDER BY id DESC LIMIT $4`,
      [p.dataset ?? null, p.status ?? null, p.cursor ?? null, p.limit + 1],
    );
    const page = rows.slice(0, p.limit);
    res.status(200).json({
      success: true,
      data: {
        items: page.map((r) => ({
          id: Number(r.id),
          dataset: r.dataset,
          mode: r.mode,
          status: r.status,
          startedAt: iso(r.started_at),
          finishedAt: iso(r.finished_at),
          windowFrom: r.window_from,
          windowTo: r.window_to,
          recordsUpserted: r.records_upserted,
          sourceLastUpdated: r.source_last_updated,
          error: r.error,
        })),
        nextCursor: rows.length > p.limit ? String(page[page.length - 1].id) : null,
      },
    });
  }),
);

/** Queue a sync for the worker. 202 Accepted with the request to poll. */
v1AdminRouter.post(
  '/v1/admin/syncs',
  guard,
  handle(async (req, res) => {
    const p = z
      .object({ dataset, from: isoDate.optional(), to: isoDate.optional() })
      .strict()
      .refine((v) => !v.from || !v.to || v.from <= v.to, 'from must be on or before to')
      .parse(req.body ?? {});
    const [pending] = await q<{ id: string }>(`SELECT id FROM sync_requests WHERE dataset = $1 AND status IN ('queued', 'running') LIMIT 1`, [p.dataset]);
    if (pending) throw new ServiceError(409, Codes.SYNC_ALREADY_QUEUED, `A ${p.dataset} sync is already queued or running (request ${pending.id})`);
    const [row] = await q<{ id: string; requested_at: Date }>(
      `INSERT INTO sync_requests (dataset, window_from, window_to, requested_by) VALUES ($1, $2, $3, $4) RETURNING id, requested_at`,
      [p.dataset, p.from ?? null, p.to ?? null, req.apiClient?.name ?? 'unknown'],
    );
    res.status(202).json({
      success: true,
      data: {
        id: Number(row.id),
        dataset: p.dataset,
        from: p.from ?? null,
        to: p.to ?? null,
        status: 'queued',
        requestedAt: row.requested_at.toISOString(),
      },
    });
  }),
);

/** Status of a queued sync request, with its run once picked up. */
v1AdminRouter.get(
  '/v1/admin/syncs/:id',
  guard,
  handle(async (req, res) => {
    const id = z
      .string()
      .regex(/^\d{1,18}$/, 'id must be a number')
      .parse(req.params.id);
    const [r] = await q<{
      id: string;
      dataset: string;
      window_from: string | null;
      window_to: string | null;
      requested_by: string;
      status: string;
      run_id: string | null;
      requested_at: Date;
      picked_at: Date | null;
      records_upserted: number | null;
      error: string | null;
    }>(
      `SELECT s.id, s.dataset, s.window_from::text, s.window_to::text, s.requested_by, s.status, s.run_id, s.requested_at, s.picked_at,
              r.records_upserted, r.error
         FROM sync_requests s LEFT JOIN fda_sync_runs r ON r.id = s.run_id WHERE s.id = $1`,
      [id],
    );
    if (!r) throw new ServiceError(404, Codes.NOT_FOUND, `Sync request ${id} not found`);
    res.status(200).json({
      success: true,
      data: {
        id: Number(r.id),
        dataset: r.dataset,
        from: r.window_from,
        to: r.window_to,
        requestedBy: r.requested_by,
        status: r.status,
        runId: r.run_id === null ? null : Number(r.run_id),
        requestedAt: r.requested_at.toISOString(),
        pickedAt: iso(r.picked_at),
        recordsUpserted: r.records_upserted,
        error: r.error,
      },
    });
  }),
);
