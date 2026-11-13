import { NextFunction, Request, Response, Router } from 'express';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { z } from 'zod';
import { audit } from '../middleware/audit';
import { authService } from '../services/AuthService';
import { authThrottle } from '../services/AuthThrottle';
import { mfaService } from '../services/MfaService';
import { AppError, ErrorCodes } from '../utils/AppError';
import {
  loginSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  refreshSchema,
  registerSchema,
} from '../validators/authSchemas';

type Handler = (req: Request, res: Response) => Promise<void>;

/** Forward async errors to the error middleware. */
const handle =
  (fn: Handler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

// Routes carry their full path (/api/auth/...) so each is greppable and matches its
// api_definition exactly; the router is mounted at the app root.
export const authRouter = Router();

// Public: these PROVIDE authentication (register, login, refresh, password reset).

authRouter.post(
  '/api/auth/register',
  handle(async (req, res) => {
    const input = registerSchema.parse(req.body);
    const session = await authService.register(input);
    res.status(201).json({ success: true, data: session });
  })
);

authRouter.post(
  '/api/auth/login',
  handle(async (req, res) => {
    const input = loginSchema.parse(req.body);
    // F4.4: at the limit, refuse before checking the password, so a right guess does not help.
    await authThrottle.check('login', req.ip, input.email);
    try {
      const result = await authService.login(input);
      await authThrottle.clearAccount('login', input.email);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      if (err instanceof AppError && err.code === ErrorCodes.INVALID_CREDENTIALS) await authThrottle.record('login', req.ip, input.email, true);
      throw err;
    }
  })
);

authRouter.post(
  '/api/auth/refresh',
  handle(async (req, res) => {
    const { refreshToken } = refreshSchema.parse(req.body);
    res.status(200).json({ success: true, data: await authService.refresh(refreshToken) });
  })
);

authRouter.post(
  '/api/auth/password-reset/request',
  handle(async (req, res) => {
    const { email } = passwordResetRequestSchema.parse(req.body);
    // Per IP: 429. Per account: the same 202, but no email is sent, so the answer never reveals an account.
    await authThrottle.check('password_reset', req.ip);
    const accountLimited = await authThrottle.accountLimited('password_reset', email);
    await authThrottle.record('password_reset', req.ip, email, false);
    if (!accountLimited) await authService.requestPasswordReset(email);
    res.status(202).json({
      success: true,
      data: { message: 'If an account exists for this email, a reset link has been sent.' },
    });
  })
);

authRouter.post(
  '/api/auth/password-reset/confirm',
  handle(async (req, res) => {
    const { token, newPassword } = passwordResetConfirmSchema.parse(req.body);
    await authService.confirmPasswordReset(token, newPassword);
    res.status(200).json({ success: true, data: { message: 'Password updated. Please sign in again.' } });
  })
);

// Protected: require a valid access token.

authRouter.post(
  '/api/auth/logout',
  authenticate,
  handle(async (req, res) => {
    const { userId } = requireAuth(req);
    const { refreshToken } = refreshSchema.parse(req.body);
    await authService.logout(userId, refreshToken);
    res.status(200).json({ success: true, data: { message: 'Signed out' } });
  })
);

authRouter.get(
  '/api/auth/me',
  authenticate,
  handle(async (req, res) => {
    const { userId, orgId } = requireAuth(req);
    res.status(200).json({ success: true, data: await authService.me(userId, orgId) });
  })
);

// F4.4 two-step sign-in (authenticator app, TOTP). Password sign-in only; provider sign-in relies
// on the identity provider's own second factor.

const codeBody = z
  .object({ code: z.string({ error: (iss) => (iss.input === undefined ? 'code is required' : 'code must be text') }).trim().min(6, 'code is too short').max(20, 'code is too long') })
  .strict();
const verifyBody = codeBody.extend({
  mfaToken: z.string({ error: (iss) => (iss.input === undefined ? 'mfaToken is required' : 'mfaToken must be text') }).min(20, 'mfaToken is invalid').max(2000, 'mfaToken is invalid'),
});

/** Public: the second step of sign-in, trading the challenge token and a code for a session. */
authRouter.post(
  '/api/auth/mfa/verify',
  handle(async (req, res) => {
    const { mfaToken, code } = verifyBody.parse(req.body);
    const userId = mfaService.challengeUser(mfaToken);
    await authThrottle.check('mfa', req.ip, userId);
    if (!(await mfaService.consume(userId, code))) {
      await authThrottle.record('mfa', req.ip, userId, true);
      throw new AppError(401, ErrorCodes.INVALID_MFA_CODE, 'The code is not correct or has already been used');
    }
    await authThrottle.clearAccount('mfa', userId);
    res.status(200).json({ success: true, data: await authService.completeMfa(userId) });
  })
);

authRouter.get(
  '/api/auth/mfa',
  authenticate,
  handle(async (req, res) => {
    const { userId } = requireAuth(req);
    res.status(200).json({ success: true, data: await mfaService.status(userId) });
  })
);

authRouter.post(
  '/api/auth/mfa/setup',
  authenticate,
  audit('auth.mfa_setup_started', { targetType: 'user', targetId: (req) => req.auth?.userId }),
  handle(async (req, res) => {
    const { userId } = requireAuth(req);
    const me = await authService.me(userId, requireAuth(req).orgId);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await mfaService.setup(userId, me.user.email) });
  })
);

authRouter.post(
  '/api/auth/mfa/enable',
  authenticate,
  audit('auth.mfa_enabled', { targetType: 'user', targetId: (req) => req.auth?.userId }),
  handle(async (req, res) => {
    const { userId } = requireAuth(req);
    const { code } = codeBody.parse(req.body);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await mfaService.enable(userId, code) });
  })
);

authRouter.post(
  '/api/auth/mfa/disable',
  authenticate,
  audit('auth.mfa_disabled', { targetType: 'user', targetId: (req) => req.auth?.userId }),
  handle(async (req, res) => {
    const { userId } = requireAuth(req);
    const { code } = codeBody.parse(req.body);
    await authThrottle.check('mfa', req.ip, userId);
    try {
      await mfaService.disable(userId, code);
    } catch (err) {
      if (err instanceof AppError && err.code === ErrorCodes.INVALID_MFA_CODE) await authThrottle.record('mfa', req.ip, userId, true);
      throw err;
    }
    res.status(200).json({ success: true, data: { enabled: false } });
  })
);
