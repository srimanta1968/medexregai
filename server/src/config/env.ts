import dotenv from 'dotenv';

// Tests supply a complete fake environment (tests/setup/test-env.ts); loading a
// developer's server/.env there would make results depend on local settings.
if (process.env.NODE_ENV !== 'test') {
  dotenv.config();
}

/**
 * Which AI provider serves a route. Our own self-hosted models are the default
 * (Ollama in dev/test, an OpenAI-compatible vLLM server in production); third-party
 * providers are opt-in per route or per firm.
 */
export type LlmProviderKind = 'ollama' | 'openai_compatible' | 'anthropic';

/**
 * How outgoing email is delivered. "log" writes the message to the server log and is
 * for local development only: it is refused when NODE_ENV=production. A real
 * transport (SMTP / provider API) is added with the notifications feature (F10.6).
 */
export type MailTransport = 'log';

export interface DatabaseSettings {
  host: string;
  port: number;
  name: string;
  user: string;
  password: string;
  ssl: boolean;
  poolMin: number;
  poolMax: number;
}

export interface StorageSettings {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export interface LlmSettings {
  provider: LlmProviderKind;
  baseUrl: string;
  generationModel: string;
  embeddingModel: string;
  requestTimeoutMs: number;
}

export interface AppConfig {
  nodeEnv: string;
  port: number;
  appName: string;
  db: DatabaseSettings;
  jwt: { secret: string; expiresIn: string; refreshTtlDays: number };
  /** Public URL of the web app, used to build links in emails (password reset). */
  appBaseUrl: string;
  mail: { transport: MailTransport; from: string };
  encryptionKey: string;
  bcryptRounds: number;
  corsOrigins: string[];
  redisUrl: string;
  storage: StorageSettings;
  llm: LlmSettings;
  logLevel: string;
  logFormat: string;
  rateLimit: { windowMs: number; maxRequests: number };
  bodyLimit: string;
}

/** Origins the ProjexLight platform previews the app from, plus local dev servers. */
export const DEFAULT_CORS_ORIGINS: readonly string[] = [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://projexlight.com',
  'https://dev.projexlight.com',
];

const LLM_PROVIDERS: readonly LlmProviderKind[] = ['ollama', 'openai_compatible', 'anthropic'];

type Env = Record<string, string | undefined>;

/**
 * Read a required variable. Secrets and credentials have NO fallback: a missing
 * value stops startup instead of silently running with a known default.
 */
export function requireEnv(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. Run scripts/setup-env.sh to create server/.env.`
    );
  }
  return value.trim();
}

/** Read an optional variable, using `fallback` when it is unset or blank. */
export function optionalEnv(env: Env, name: string, fallback: string): string {
  const value = env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

/** Parse a positive integer, rejecting garbage rather than coercing it to NaN. */
export function parsePositiveInt(raw: string, name: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got "${raw}".`);
  }
  return n;
}

/** Merge the comma-separated CORS_ORIGIN list with the platform defaults, de-duplicated. */
export function parseCorsOrigins(raw: string | undefined): string[] {
  const extra = (raw || '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter((o) => o.length > 0);
  return Array.from(new Set([...DEFAULT_CORS_ORIGINS, ...extra]));
}

/** Validate the provider name so a typo fails at startup, not on the first AI call. */
export function parseLlmProvider(raw: string): LlmProviderKind {
  if ((LLM_PROVIDERS as readonly string[]).includes(raw)) {
    return raw as LlmProviderKind;
  }
  throw new Error(`AI_PROVIDER must be one of ${LLM_PROVIDERS.join(', ')}, got "${raw}".`);
}

/**
 * The encryption key protects stored OAuth tokens and firm API keys, so it must be
 * a 32-byte key encoded as 64 hex characters (AES-256).
 */
export function parseEncryptionKey(raw: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes). Run scripts/setup-env.sh.');
  }
  return raw.toLowerCase();
}

/** Request-log formats morgan understands. */
export const LOG_FORMATS: readonly string[] = ['combined', 'common', 'dev', 'short', 'tiny'];

/**
 * Map LOG_FORMAT to a morgan format. Anything else (e.g. the "json" an older template
 * shipped) would be printed literally on every request, so it falls back to "combined".
 */
export function parseLogFormat(raw: string): string {
  return LOG_FORMATS.includes(raw) ? raw : 'combined';
}

/** Validate MAIL_TRANSPORT; the log transport must never be used in production. */
export function parseMailTransport(raw: string, nodeEnv: string): MailTransport {
  if (raw !== 'log') {
    throw new Error(`MAIL_TRANSPORT must be "log" (the only transport so far), got "${raw}".`);
  }
  if (nodeEnv === 'production') {
    throw new Error('MAIL_TRANSPORT=log only writes emails to the log and is not allowed in production.');
  }
  return raw;
}

/** Build the typed application config from an environment map. */
export function loadConfig(env: Env): AppConfig {
  const jwtSecret = requireEnv(env, 'JWT_SECRET');
  if (jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters. Run scripts/setup-env.sh.');
  }

  const nodeEnv = optionalEnv(env, 'NODE_ENV', 'development');

  return {
    nodeEnv,
    port: parsePositiveInt(optionalEnv(env, 'PORT', '3000'), 'PORT'),
    appName: optionalEnv(env, 'APP_NAME', 'MedexRegAI'),
    db: {
      host: requireEnv(env, 'DB_HOST'),
      port: parsePositiveInt(optionalEnv(env, 'DB_PORT', '5432'), 'DB_PORT'),
      name: requireEnv(env, 'DB_NAME'),
      user: requireEnv(env, 'DB_USER'),
      password: requireEnv(env, 'DB_PASSWORD'),
      ssl: optionalEnv(env, 'DB_SSL', 'false') === 'true',
      poolMin: parsePositiveInt(optionalEnv(env, 'DB_POOL_MIN', '2'), 'DB_POOL_MIN'),
      poolMax: parsePositiveInt(optionalEnv(env, 'DB_POOL_MAX', '10'), 'DB_POOL_MAX'),
    },
    jwt: {
      secret: jwtSecret,
      expiresIn: optionalEnv(env, 'JWT_EXPIRES_IN', '15m'),
      refreshTtlDays: parsePositiveInt(optionalEnv(env, 'REFRESH_TOKEN_TTL_DAYS', '30'), 'REFRESH_TOKEN_TTL_DAYS'),
    },
    appBaseUrl: optionalEnv(env, 'APP_BASE_URL', 'http://localhost:5173').replace(/\/+$/, ''),
    mail: {
      transport: parseMailTransport(optionalEnv(env, 'MAIL_TRANSPORT', 'log'), nodeEnv),
      from: optionalEnv(env, 'MAIL_FROM', 'MedexRegAI <no-reply@localhost>'),
    },
    encryptionKey: parseEncryptionKey(requireEnv(env, 'ENCRYPTION_KEY')),
    bcryptRounds: parsePositiveInt(optionalEnv(env, 'BCRYPT_ROUNDS', '12'), 'BCRYPT_ROUNDS'),
    corsOrigins: parseCorsOrigins(env.CORS_ORIGIN),
    redisUrl: requireEnv(env, 'REDIS_URL'),
    storage: {
      endpoint: requireEnv(env, 'S3_ENDPOINT'),
      region: optionalEnv(env, 'S3_REGION', 'us-east-1'),
      bucket: requireEnv(env, 'S3_BUCKET'),
      accessKeyId: requireEnv(env, 'S3_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv(env, 'S3_SECRET_ACCESS_KEY'),
      forcePathStyle: optionalEnv(env, 'S3_FORCE_PATH_STYLE', 'true') === 'true',
    },
    llm: {
      provider: parseLlmProvider(optionalEnv(env, 'AI_PROVIDER', 'ollama')),
      baseUrl: requireEnv(env, 'AI_BASE_URL'),
      generationModel: requireEnv(env, 'AI_GENERATION_MODEL'),
      embeddingModel: requireEnv(env, 'AI_EMBEDDING_MODEL'),
      requestTimeoutMs: parsePositiveInt(optionalEnv(env, 'AI_REQUEST_TIMEOUT_MS', '120000'), 'AI_REQUEST_TIMEOUT_MS'),
    },
    logLevel: optionalEnv(env, 'LOG_LEVEL', 'info'),
    logFormat: parseLogFormat(optionalEnv(env, 'LOG_FORMAT', 'dev')),
    rateLimit: {
      windowMs: parsePositiveInt(optionalEnv(env, 'RATE_LIMIT_WINDOW_MS', '900000'), 'RATE_LIMIT_WINDOW_MS'),
      maxRequests: parsePositiveInt(optionalEnv(env, 'RATE_LIMIT_MAX_REQUESTS', '300'), 'RATE_LIMIT_MAX_REQUESTS'),
    },
    bodyLimit: optionalEnv(env, 'BODY_PARSER_LIMIT', '1mb'),
  };
}

/** Process-wide config, validated once at import. Startup fails fast on a bad .env. */
export const config: AppConfig = loadConfig(process.env);
