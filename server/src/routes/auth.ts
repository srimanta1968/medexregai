import { NextFunction, Request, Response, Router } from 'express';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { authService } from '../services/AuthService';
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
    res.status(200).json({ success: true, data: await authService.login(input) });
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
    await authService.requestPasswordReset(email);
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
