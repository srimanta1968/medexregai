import { NextFunction, Request, Response } from 'express';
import { dataService } from '../services/DataService';
import { AppError, ErrorCodes } from '../utils/AppError';
import { requireAuth } from './authenticate';

/**
 * What each built-in role may do. Custom roles with their own permission matrix
 * arrive with F10.2; until then these keys are the vocabulary routes guard on.
 */
export type Permission =
  | 'members:invite'
  | 'members:manage'
  | 'firm:manage'
  | 'billing:manage'
  | 'projects:read'
  | 'projects:write'
  | 'drafts:review';

export const ROLE_PERMISSIONS: Readonly<Record<string, readonly Permission[]>> = {
  owner: ['members:invite', 'members:manage', 'firm:manage', 'billing:manage', 'projects:read', 'projects:write', 'drafts:review'],
  admin: ['members:invite', 'members:manage', 'firm:manage', 'projects:read', 'projects:write', 'drafts:review'],
  editor: ['projects:read', 'projects:write'],
  reviewer: ['projects:read', 'drafts:review'],
  viewer: ['projects:read'],
};

export function roleHasPermission(role: string, permission: Permission): boolean {
  return (ROLE_PERMISSIONS[role] ?? []).includes(permission);
}

/**
 * Allow the request only if the user's CURRENT role in the token's firm grants the
 * permission. The role is read from the database, not trusted from the token, so a
 * role change or deactivation takes effect on the next request. Must run after
 * `authenticate`. Refusal is 403 FORBIDDEN.
 */
export function requirePermission(permission: Permission) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const { userId, orgId } = requireAuth(req);
      const rows = await dataService.query<{ role: string }>(
        { orgId, userId },
        'memberships',
        `SELECT r.key AS role
           FROM memberships m JOIN roles r ON r.id = m.role_id JOIN orgs o ON o.id = m.org_id
          WHERE m.org_id = $1 AND m.user_id = $2 AND m.status = 'active' AND o.status = 'active'`,
        [orgId, userId]
      );
      const role = rows[0]?.role;
      if (!role) {
        throw new AppError(403, ErrorCodes.FORBIDDEN, 'You are not an active member of this firm');
      }
      if (!roleHasPermission(role, permission)) {
        throw new AppError(403, ErrorCodes.FORBIDDEN, `Your role (${role}) does not allow this action`);
      }
      req.auth = { ...req.auth!, role };
      next();
    } catch (err) {
      next(err);
    }
  };
}
