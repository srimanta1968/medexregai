import { Pool, QueryResultRow } from 'pg';
import { config } from '../config';

/**
 * Two pools: `primary` for writes (sync, loads, admin) and `read` for /v1 reads.
 * Pointing FDA_READ_DATABASE_URL at a replica scales reads without code changes;
 * without it, reads use the primary.
 */
let primary: Pool | null = null;
let read: Pool | null = null;

export function primaryPool(): Pool {
  if (!primary) primary = new Pool({ connectionString: config.databaseUrl, max: config.poolMax, application_name: 'fda-data' });
  return primary;
}

export function readPool(): Pool {
  if (!config.readDatabaseUrl) return primaryPool();
  if (!read) read = new Pool({ connectionString: config.readDatabaseUrl, max: config.poolMax, application_name: 'fda-data-read' });
  return read;
}

export async function q<T extends QueryResultRow>(sql: string, params: unknown[] = [], pool: Pool = readPool()): Promise<T[]> {
  return (await pool.query<T>(sql, params)).rows;
}

export async function closePools(): Promise<void> {
  await Promise.all([primary?.end(), read?.end()]);
  primary = null;
  read = null;
}
