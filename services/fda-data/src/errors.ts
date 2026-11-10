import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

/** Error with a stable SCREAMING_SNAKE_CASE code, mirrored by @medexregai/fda-sdk. */
export class ServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const Codes = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  RATE_LIMITED: 'RATE_LIMITED',
  SYNC_ALREADY_QUEUED: 'SYNC_ALREADY_QUEUED',
  NOT_READY: 'NOT_READY',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

/** Same body shape as the main app: { success: false, error: { code, message, details } }. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ServiceError) {
    res.status(err.status).json({
      success: false,
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }
  if (err instanceof ZodError) {
    const details = err.issues.map((i) => ({
      field: i.path.join('.'),
      message: i.message,
    }));
    res.status(400).json({
      success: false,
      error: {
        code: Codes.VALIDATION_ERROR,
        message: details[0]?.message ?? 'Invalid request',
        details,
      },
    });
    return;
  }
  console.error('[fda-data] unhandled error', err);
  res.status(500).json({
    success: false,
    error: { code: Codes.INTERNAL_ERROR, message: 'Internal Server Error' },
  });
}
