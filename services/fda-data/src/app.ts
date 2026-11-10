import express, { Express, Request, Response, Router } from 'express';
import helmet from 'helmet';
import { readPool } from './db/pool';
import { Codes, errorHandler } from './errors';

/**
 * The fda-data HTTP app. Called only by MedexRegAI services (server-to-server), so
 * there is no CORS: browsers never reach it. /health and /ready are open for the
 * orchestrator; everything under /v1 requires a service API key (mounted by later
 * tasks through `extraRouters`).
 */
export function createApp(extraRouters: Router[] = []): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(helmet());
  app.use(express.json({ limit: '256kb' }));

  /** Liveness: the process is up. */
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', service: 'fda-data' });
  });

  /** Readiness: the FDA database answers. */
  app.get('/ready', (_req: Request, res: Response) => {
    readPool()
      .query('SELECT 1')
      .then(() => res.status(200).json({ status: 'ready' }))
      .catch(() => res.status(503).json({ success: false, error: { code: Codes.NOT_READY, message: 'FDA database is not reachable' } }));
  });

  for (const r of extraRouters) app.use(r);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ success: false, error: { code: Codes.NOT_FOUND, message: 'Route not found' } });
  });
  app.use(errorHandler);
  return app;
}
