import { FdaClient, FdaServiceError } from '@medexregai/fda-sdk';
import { config } from '../config/env';
import { dataService } from '../services/DataService';
import { AppError, ErrorCodes } from '../utils/AppError';

/**
 * The app's only door to FDA data (ADR-017): the fda-data service via
 * @medexregai/fda-sdk. The app holds no FDA tables; this module turns service
 * errors into the app's own error shape and pushes tracked product codes.
 */

let client: FdaClient | null = null;

export function fdaClient(): FdaClient {
  if (!config.fda.serviceKey) {
    throw new AppError(503, ErrorCodes.FDA_UNAVAILABLE, 'FDA data service is not configured (FDA_SERVICE_KEY is empty).', { retryable: false });
  }
  if (!client) client = new FdaClient({ baseUrl: config.fda.serviceUrl, apiKey: config.fda.serviceKey, timeoutMs: config.fda.timeoutMs });
  return client;
}

/**
 * Map an SDK error to what the app's users see. Not-found and validation errors
 * pass through with the service's message; anything about reaching or
 * authenticating to the service is the platform's problem, so users get a
 * retryable 503 and the detail goes to the log.
 */
export function toAppError(err: unknown): unknown {
  if (!(err instanceof FdaServiceError)) return err;
  if (err.status === 404) return new AppError(404, ErrorCodes.NOT_FOUND, err.message);
  if (err.status === 400) return new AppError(400, ErrorCodes.VALIDATION_ERROR, err.message, err.details);
  if (err.status === 401 || err.status === 403) {
    console.error(`[fda] service rejected the app's key (${err.code}): check FDA_SERVICE_KEY and its scopes`);
  } else {
    console.warn(`[fda] service unavailable: ${err.code} ${err.message}`);
  }
  return new AppError(503, ErrorCodes.FDA_UNAVAILABLE, 'FDA data is unavailable right now. Try again shortly.', {
    retryable: true,
    retryAfterSeconds: err.retryAfterSeconds ?? 30,
  });
}

/** Run an FDA call and convert its errors. */
export async function fda<T>(call: (c: FdaClient) => Promise<T>): Promise<T> {
  try {
    return await call(fdaClient());
  } catch (err) {
    throw toAppError(err);
  }
}

/**
 * Send the distinct product codes of all firms' devices to the service so it keeps
 * their MAUDE counts. Only three-letter public FDA codes leave the app: no firm,
 * client or device identity (the platform view exposes nothing else).
 */
export async function pushTrackedProductCodes(): Promise<{ tracked: number; added: number } | null> {
  if (!config.fda.serviceKey) return null;
  const rows = await dataService.query<{ product_code: string }>({}, 'device_product_codes', 'SELECT product_code FROM device_product_codes', []);
  const codes = rows.map((r) => r.product_code).filter((c) => /^[A-Z]{3}$/.test(c));
  return fda((c) => c.putTrackedProductCodes(codes));
}

let pushTimer: NodeJS.Timeout | null = null;

/** Debounced push after device changes (several saves in a row cause one call). Never throws. */
export function schedulePushTrackedProductCodes(delayMs = 5000): void {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushTrackedProductCodes().catch((err: unknown) => console.warn(`[fda] tracked product codes push failed: ${(err as Error).message}`));
  }, delayMs);
  pushTimer.unref();
}
