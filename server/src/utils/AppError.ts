/**
 * An error the API reports to the client as-is: HTTP status, a stable
 * SCREAMING_SNAKE_CASE code clients can branch on (MUST-66), and a message.
 * Anything that is not an AppError becomes a generic 500 with no internals.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** The error codes used across the API. Reuse these before adding a new one. */
export const ErrorCodes = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  UNAUTHORIZED: 'UNAUTHORIZED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  INVALID_REFRESH_TOKEN: 'INVALID_REFRESH_TOKEN',
  INVALID_RESET_TOKEN: 'INVALID_RESET_TOKEN',
  NO_ACTIVE_MEMBERSHIP: 'NO_ACTIVE_MEMBERSHIP',
} as const;
