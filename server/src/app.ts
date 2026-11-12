import express, { Application, NextFunction, Request, Response } from 'express';
import cors, { CorsOptions } from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { ZodError } from 'zod';
import { AppConfig, config } from './config/env';
import { authRouter } from './routes/auth';
import { invitesRouter } from './routes/invites';
import { pilotRequestsRouter } from './routes/pilotRequests';
import { workspaceRouter } from './routes/workspace';
import { appShellRouter } from './routes/appShell';
import { auditRouter } from './routes/audit';
import { fdaRouter } from './routes/fda';
import { aiSettingsRouter } from './routes/aiSettings';
import { filesRouter } from './routes/files';
import { citationsRouter } from './routes/citations';
import { requestsRouter } from './routes/requests';
import { trustRouter } from './routes/trust';
import { inboundEmailRouter } from './routes/inboundEmail';
import { searchRouter } from './routes/search';
import { ssoRouter } from './routes/sso';
import { connectionsRouter } from './routes/connections';
import { sortingRouter } from './routes/sorting';
import { problemsRouter } from './routes/problems';
import { sectionsRouter } from './routes/sections';
import { draftsRouter } from './routes/drafts';
import { impactRouter } from './routes/impact';
import { readinessRouter } from './routes/readiness';
import { recordsRouter } from './routes/records';
import { AppError, ErrorCodes } from './utils/AppError';

export interface HealthResponse {
  success: true;
  data: { status: 'ok'; timestamp: string };
}

export interface ErrorResponse {
  success: false;
  error: { code: string; message: string; details?: unknown };
}

/** Map any thrown error to a status and a client-safe body (no internals for 500s). */
export function toErrorResponse(err: unknown): { status: number; body: ErrorResponse } {
  if (err instanceof AppError) {
    return { status: err.status, body: { success: false, error: { code: err.code, message: err.message, details: err.details } } };
  }
  if (err instanceof ZodError) {
    const details = err.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    return {
      status: 400,
      body: { success: false, error: { code: ErrorCodes.VALIDATION_ERROR, message: details[0]?.message || 'Invalid request', details } },
    };
  }
  // express.json() rejects malformed bodies with a SyntaxError carrying status 400.
  if (err instanceof SyntaxError && (err as { status?: number }).status === 400) {
    return { status: 400, body: { success: false, error: { code: ErrorCodes.VALIDATION_ERROR, message: 'Request body is not valid JSON' } } };
  }
  return { status: 500, body: { success: false, error: { code: ErrorCodes.INTERNAL_ERROR, message: 'Internal Server Error' } } };
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
  // Client IP for rate limiting comes from X-Forwarded-For only through trusted hops.
  app.set('trust proxy', appConfig.trustProxy);

  app.use(helmet());
  app.use(cors(buildCorsOptions(appConfig.corsOrigins)));
  // Upload-link tokens are credentials: never write them to access logs (F2.4).
  morgan.token('url', (req: Request) => (req.originalUrl || req.url).replace(/\/u\/[^/?#]+/, '/u/[token]'));
  app.use(morgan(appConfig.logFormat));
  app.use(express.json({ limit: appConfig.bodyLimit }));
  app.use(express.urlencoded({ extended: true, limit: appConfig.bodyLimit }));

  // Liveness probe for Docker, load balancers and the ProjexLight test runner.
  // Public by design: it returns no data beyond "up". See tests/api_definitions/health.
  // projexlight-ignore SEC-AUTHZ-01: public liveness probe, declared requiresAuth:false
  app.get('/health', (_req: Request, res: Response<HealthResponse>): void => {
    res.status(200).json({ success: true, data: { status: 'ok', timestamp: new Date().toISOString() } });
  });

  app.use(authRouter);
  app.use(invitesRouter);
  app.use(ssoRouter);
  app.use(pilotRequestsRouter);
  app.use(workspaceRouter);
  app.use(appShellRouter);
  app.use(auditRouter);
  app.use(fdaRouter);
  app.use(aiSettingsRouter);
  app.use(filesRouter);
  app.use(citationsRouter);
  app.use(searchRouter);
  app.use(requestsRouter);
  app.use(trustRouter);
  app.use(inboundEmailRouter);
  app.use(connectionsRouter);
  app.use(sortingRouter);
  app.use(problemsRouter);
  app.use(sectionsRouter);
  app.use(draftsRouter);
  app.use(impactRouter);
  app.use(readinessRouter);
  app.use(recordsRouter);

  app.use((_req: Request, res: Response<ErrorResponse>): void => {
    res.status(404).json({ success: false, error: { code: ErrorCodes.NOT_FOUND, message: 'Route not found' } });
  });

  // Four-argument signature is how Express recognises an error handler.
  app.use((err: Error, _req: Request, res: Response<ErrorResponse>, _next: NextFunction): void => {
    const { status, body } = toErrorResponse(err);
    if (status >= 500) {
      console.error(err.stack || err.message);
    }
    res.status(status).json(body);
  });

  return app;
}

const app = createApp(config);

if (require.main === module) {
  app.listen(config.port, (): void => {
    console.info(`${config.appName} API listening on port ${config.port}`);
  });
}

export default app;
