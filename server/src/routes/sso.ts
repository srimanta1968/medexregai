import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { config } from '../config/env';
import { SSO_COOKIE, SsoError, ssoService } from '../services/SsoService';

type Handler = (req: Request, res: Response) => Promise<void>;

const handle =
  (fn: Handler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

const exchangeSchema = z.object({ code: z.string({ required_error: 'code is required' }).min(20, 'code is invalid').max(200, 'code is invalid') });

const cookieOptions = (maxAgeMs: number) => ({
  httpOnly: true,
  secure: config.appBaseUrl.startsWith('https://'),
  sameSite: 'lax' as const, // must survive the top-level redirect back from the provider
  path: '/api/auth/sso',
  maxAge: maxAgeMs,
});

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      return decodeURIComponent(rest.join('='));
    }
  }
  return undefined;
}

// Full paths (/api/auth/sso/...) so each route matches its api_definition exactly.
export const ssoRouter = Router();

/** Public: which providers the sign-in page should show. */
ssoRouter.get(
  '/api/auth/sso/providers',
  handle(async (_req, res) => {
    res.status(200).json({ success: true, data: { providers: ssoService.enabledProviders() } });
  })
);

/** Public: begin sign-in; redirects the browser to the provider. */
ssoRouter.get(
  '/api/auth/sso/:provider/start',
  handle(async (req, res) => {
    const { url, cookie } = await ssoService.start(req.params.provider);
    res.cookie(SSO_COOKIE, cookie, cookieOptions(10 * 60 * 1000));
    res.redirect(302, url);
  })
);

/**
 * Public: the provider redirects here. Always answers with a redirect to the web app,
 * either /sso/complete#code=<one-time code> or /login?sso_error=<reason>.
 */
ssoRouter.get(
  '/api/auth/sso/:provider/callback',
  handle(async (req, res) => {
    const pending = readCookie(req, SSO_COOKIE);
    res.clearCookie(SSO_COOKIE, { path: '/api/auth/sso' });
    try {
      const code = await ssoService.callback(req.params.provider, req.query as Record<string, unknown>, pending);
      res.redirect(302, `${config.appBaseUrl}/sso/complete#code=${encodeURIComponent(code)}`);
    } catch (err) {
      if (!(err instanceof SsoError)) {
        throw err;
      }
      console.warn(`[sso] ${req.params.provider} sign-in failed (${err.reason}): ${err.message}`);
      res.redirect(302, `${config.appBaseUrl}/login?sso_error=${err.reason}`);
    }
  })
);

/** Public: trade the one-time code for a session (the code is the credential). */
ssoRouter.post(
  '/api/auth/sso/exchange',
  handle(async (req, res) => {
    const { code } = exchangeSchema.parse(req.body);
    res.status(200).json({ success: true, data: await ssoService.exchange(code) });
  })
);
