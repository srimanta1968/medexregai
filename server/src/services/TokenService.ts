import { createHash, randomBytes } from 'crypto';
import jwt, { JwtPayload, TokenExpiredError } from 'jsonwebtoken';
import { config } from '../config/env';
import { AppError, ErrorCodes } from '../utils/AppError';

export interface AccessClaims {
  userId: string;
  orgId: string;
  role: string;
}

const ISSUER = 'medexregai';
const AUDIENCE = 'medexregai-api';

/** A random opaque token (refresh, password reset) and the hash we store for it. */
export function newOpaqueToken(): { token: string; hash: string } {
  const token = randomBytes(48).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Short-lived access token (JWT, HS256) carrying the user, current firm and role. */
export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign({ org: claims.orgId, role: claims.role }, config.jwt.secret, {
    algorithm: 'HS256',
    subject: claims.userId,
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: config.jwt.expiresIn as jwt.SignOptions['expiresIn'],
  });
}

/** Verify signature, algorithm, issuer, audience and expiry; never accepts alg "none". */
export function verifyAccessToken(token: string): AccessClaims {
  try {
    const payload = jwt.verify(token, config.jwt.secret, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    }) as JwtPayload;
    if (typeof payload.sub !== 'string' || typeof payload.org !== 'string' || typeof payload.role !== 'string') {
      throw new AppError(401, ErrorCodes.UNAUTHORIZED, 'Invalid or expired token');
    }
    return { userId: payload.sub, orgId: payload.org, role: payload.role };
  } catch (err) {
    if (err instanceof AppError) {
      throw err;
    }
    if (err instanceof TokenExpiredError) {
      throw new AppError(401, ErrorCodes.TOKEN_EXPIRED, 'Access token has expired');
    }
    throw new AppError(401, ErrorCodes.UNAUTHORIZED, 'Invalid or expired token');
  }
}

/** Access-token lifetime in seconds, for the expiresIn field clients use to schedule refresh. */
export function accessTokenTtlSeconds(): number {
  const decoded = jwt.decode(signAccessToken({ userId: 'ttl', orgId: 'ttl', role: 'ttl' })) as JwtPayload;
  return (decoded.exp ?? 0) - (decoded.iat ?? 0);
}
