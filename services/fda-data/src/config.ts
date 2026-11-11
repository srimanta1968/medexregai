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
  /** Public 510(k) summary PDFs (F1.2), fetched politely and cached in the FDA document bucket. */
  docs: {
    /** FDA_DOCS_ENABLED (default true): the worker fetches summaries for tracked product codes. */
    enabled: boolean;
    /** FDA_DOCS_BUCKET: S3 bucket for the PDFs; blank = local directory FDA_DOCS_DIR. */
    bucket: string | null;
    region: string;
    endpoint: string | null;
    forcePathStyle: boolean;
    accessKeyId: string | null;
    secretAccessKey: string | null;
    dir: string;
    /** At least this long between two requests to accessdata.fda.gov. */
    minIntervalMs: number;
    /** K-numbers fetched per worker pass. */
    batchSize: number;
    /** A summary PDF larger than this is refused (failed, not cached). */
    maxBytes: number;
    timeoutMs: number;
    /** Fetched summaries parsed, chunked and embedded per worker pass. */
    indexBatch: number;
  };
  /** The sandboxed parser (services/docproc) that turns summary PDFs into page passages. */
  docproc: { url: string; apiKey: string | null; timeoutMs: number };
  /** Embedding model for the summary index (bge-m3, 1024 dimensions, same as the app). */
  embedding: { provider: 'ollama' | 'openai_compatible'; baseUrl: string; model: string; apiKey: string | null; timeoutMs: number };
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
    docs: {
      enabled: process.env.FDA_DOCS_ENABLED !== 'false',
      bucket: process.env.FDA_DOCS_BUCKET || null,
      region: process.env.FDA_DOCS_REGION || process.env.AWS_REGION || 'us-east-1',
      endpoint: process.env.FDA_DOCS_S3_ENDPOINT || null,
      forcePathStyle: process.env.FDA_DOCS_S3_FORCE_PATH_STYLE === 'true',
      accessKeyId: process.env.FDA_DOCS_S3_ACCESS_KEY_ID || null,
      secretAccessKey: process.env.FDA_DOCS_S3_SECRET_ACCESS_KEY || null,
      dir: process.env.FDA_DOCS_DIR || 'data/fda-docs',
      minIntervalMs: int('FDA_DOCS_MIN_INTERVAL_MS', 5000, 1000, 600_000),
      batchSize: int('FDA_DOCS_BATCH', 20, 1, 500),
      maxBytes: int('FDA_DOCS_MAX_BYTES', 50 * 1024 * 1024, 1024, 500 * 1024 * 1024),
      timeoutMs: int('FDA_DOCS_TIMEOUT_MS', 60_000, 1000, 600_000),
      indexBatch: int('FDA_DOCS_INDEX_BATCH', 5, 1, 100),
    },
    docproc: {
      url: process.env.DOCPROC_URL || 'http://localhost:4200',
      apiKey: process.env.DOCPROC_API_KEY || null,
      timeoutMs: int('DOCPROC_TIMEOUT_MS', 150_000, 1000, 900_000),
    },
    embedding: {
      provider: process.env.FDA_EMBEDDING_PROVIDER === 'openai_compatible' ? 'openai_compatible' : 'ollama',
      // Explicitly empty = no embedding model: PDFs are still fetched, indexing waits.
      baseUrl: process.env.FDA_EMBEDDING_URL ?? 'http://localhost:11434',
      model: process.env.FDA_EMBEDDING_MODEL || 'bge-m3',
      apiKey: process.env.FDA_EMBEDDING_API_KEY || null,
      timeoutMs: int('FDA_EMBEDDING_TIMEOUT_MS', 120_000, 1000, 600_000),
    },
  };
}

export const config = loadConfig();
