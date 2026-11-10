import dotenv from 'dotenv';

dotenv.config();

/**
 * fda-data service configuration. Deliberately independent of the main app's
 * config: separate database, separate secrets, separate deployment (ADR-017).
 */
export interface Config {
  port: number;
  /** Primary FDA database (writes: sync, bulk loads, admin). */
  databaseUrl: string;
  /** Optional read replica for /v1 reads; falls back to the primary. */
  readDatabaseUrl: string | null;
  poolMax: number;
  /** Verified TLS to Postgres (RDS enforces it with rds.force_ssl). */
  dbSsl: boolean;
  openFda: {
    apiKey: string | null;
    maxPerMinute: number;
    initialLookbackDays: number;
    /** Product codes to track for MAUDE counts in addition to those pushed by clients. */
    extraEventProductCodes: string[];
    syncHourUtc: number;
  };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required (see services/fda-data/.env.example).`);
  return v;
}

function int(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}, got "${raw}".`);
  return n;
}

/** postgres:// URL for a host from FDA_DB_USER / _PASSWORD / _PORT / _NAME. */
function urlFor(host: string): string {
  const user = encodeURIComponent(required('FDA_DB_USER'));
  const password = encodeURIComponent(required('FDA_DB_PASSWORD'));
  const port = int('FDA_DB_PORT', 5432, 1, 65535);
  const name = encodeURIComponent(process.env.FDA_DB_NAME || 'fda_db');
  return `postgres://${user}:${password}@${host}:${port}/${name}`;
}

/** FDA_DATABASE_URL, or the same built from FDA_DB_HOST and its parts. */
function databaseUrl(): string {
  if (process.env.FDA_DATABASE_URL) return process.env.FDA_DATABASE_URL;
  if (!process.env.FDA_DB_HOST) required('FDA_DATABASE_URL');
  return urlFor(process.env.FDA_DB_HOST as string);
}

/** FDA_READ_DATABASE_URL, or a replica host FDA_READ_DB_HOST with the same credentials; null = use the primary. */
function readDatabaseUrl(): string | null {
  if (process.env.FDA_READ_DATABASE_URL) return process.env.FDA_READ_DATABASE_URL;
  return process.env.FDA_READ_DB_HOST ? urlFor(process.env.FDA_READ_DB_HOST) : null;
}

export function loadConfig(): Config {
  return {
    port: int('PORT', 4100, 1, 65535),
    databaseUrl: databaseUrl(),
    readDatabaseUrl: readDatabaseUrl(),
    poolMax: int('FDA_DB_POOL_MAX', 10, 1, 200),
    dbSsl: process.env.FDA_DB_SSL === 'true',
    openFda: {
      apiKey: process.env.OPENFDA_API_KEY || null,
      // openFDA's documented limit is 240 requests per minute.
      maxPerMinute: int('OPENFDA_MAX_PER_MINUTE', 200, 1, 240),
      initialLookbackDays: int('OPENFDA_INITIAL_LOOKBACK_DAYS', 90, 1, 3650),
      extraEventProductCodes: (process.env.FDA_EVENT_PRODUCT_CODES || '')
        .split(',')
        .map((c) => c.trim().toUpperCase())
        .filter((c) => /^[A-Z]{3}$/.test(c)),
      syncHourUtc: int('FDA_SYNC_HOUR_UTC', 3, 0, 23),
    },
  };
}

export const config = loadConfig();
