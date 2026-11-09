import { NextFunction, Request, Response } from 'express';
import { AccessClaims, verifyAccessToken } from '../services/TokenService';
import { AppError, ErrorCodes } from '../utils/AppError';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by `authenticate` for every protected route. */
    auth?: AccessClaims;
  }
}

/** Require a valid Bearer access token; sets req.auth = { userId, orgId, role }. */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  try {
    const header = req.headers.authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      throw new AppError(401, ErrorCodes.UNAUTHORIZED, 'Missing bearer token');
    }
    req.auth = verifyAccessToken(match[1].trim());
    next();
  } catch (err) {
    next(err);
  }
}

/** The authenticated identity; only call on routes behind `authenticate`. */
export function requireAuth(req: Request): AccessClaims {
  if (!req.auth) {
    throw new AppError(401, ErrorCodes.UNAUTHORIZED, 'Missing bearer token');
  }
  return req.auth;
}
