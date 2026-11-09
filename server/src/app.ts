import express, { Application, NextFunction, Request, Response } from 'express';
import cors, { CorsOptions } from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { AppConfig, config } from './config/env';

export interface HealthResponse {
  success: true;
  data: { status: 'ok'; timestamp: string };
}

export interface ErrorResponse {
  success: false;
  error: { code: string; message: string };
}

/** CORS that only answers for the configured origins (no wildcard with credentials). */
export function buildCorsOptions(allowedOrigins: string[]): CorsOptions {
  return {
    origin(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void): void {
      // Same-origin requests and server-to-server calls send no Origin header.
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: true,
  };
}

/** Build the Express app without binding a port, so tests can mount it directly. */
export function createApp(appConfig: AppConfig): Application {
  const app = express();

  app.use(helmet());
  app.use(cors(buildCorsOptions(appConfig.corsOrigins)));
  app.use(morgan(appConfig.logFormat));
  app.use(express.json({ limit: appConfig.bodyLimit }));
  app.use(express.urlencoded({ extended: true, limit: appConfig.bodyLimit }));

  // Liveness probe for Docker, load balancers and the ProjexLight test runner.
  // Public by design: it returns no data beyond "up". See tests/api_definitions/health.
  // projexlight-ignore SEC-AUTHZ-01: public liveness probe, declared requiresAuth:false
  app.get('/health', (_req: Request, res: Response<HealthResponse>): void => {
    res.status(200).json({ success: true, data: { status: 'ok', timestamp: new Date().toISOString() } });
  });

  app.use((_req: Request, res: Response<ErrorResponse>): void => {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  // Four-argument signature is how Express recognises an error handler.
  app.use((err: Error, _req: Request, res: Response<ErrorResponse>, _next: NextFunction): void => {
    console.error(err.stack || err.message);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal Server Error' } });
  });

  return app;
}

const app = createApp(config);

if (require.main === module) {
  app.listen(config.port, (): void => {
    console.log(`${config.appName} API listening on port ${config.port}`);
  });
}

export default app;
