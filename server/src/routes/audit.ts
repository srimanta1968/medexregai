import { NextFunction, Request, Response, Router } from 'express';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { requirePermission } from '../middleware/authorize';
import { verifyFirmChain } from '../services/AuditService';

export const auditRouter = Router();

/** Owners and admins check that their firm's audit log has not been altered. */
auditRouter.get('/api/audit/verify', authenticate, requirePermission('members:manage'), (req: Request, res: Response, next: NextFunction): void => {
  const { orgId, userId } = requireAuth(req);
  verifyFirmChain({ orgId, userId })
    .then((result) => res.status(200).json({ success: true, data: result }))
    .catch(next);
});
