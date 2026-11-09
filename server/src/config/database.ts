import { config } from './env';

export interface DatabasePoolConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean | { rejectUnauthorized: boolean };
  min: number;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
}

/**
 * Connection settings for the shared pool. Bounded pool size and timeouts keep a
 * slow query from exhausting connections; in production the pool sits behind
 * PgBouncer (see E8 F8.1).
 */
export const databaseConfig: DatabasePoolConfig = {
  host: config.db.host,
  port: config.db.port,
  database: config.db.name,
  user: config.db.user,
  password: config.db.password,
  ssl: config.db.ssl ? { rejectUnauthorized: true } : false,
  min: config.db.poolMin,
  max: config.db.poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
};
