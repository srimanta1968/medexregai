import { NextFunction, Request, Response, Router } from 'express';
import { config } from '../config/env';
import { enabledNavItems } from '../config/navigation';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { roleHasPermission } from '../middleware/authorize';

export const appShellRouter = Router();

/**
 * The signed-in user's menu: items enabled for the current phase flags (APP_PHASE,
 * FEATURE_FLAGS_ON/OFF) and allowed for their role in the current firm.
 */
appShellRouter.get('/api/app/navigation', authenticate, (req: Request, res: Response, next: NextFunction): void => {
  try {
    const { role } = requireAuth(req);
    const items = enabledNavItems(config.features)
      .filter((item) => !item.permission || roleHasPermission(role, item.permission))
      .map(({ key, label, description, phase, scope, built }) => ({ key, label, description, phase, scope, built }));
    res.status(200).json({ success: true, data: { phase: config.features.phase, items } });
  } catch (err) {
    next(err);
  }
});
