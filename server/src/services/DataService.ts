import { Pool, PoolClient, QueryResultRow } from 'pg';
import { databaseConfig } from '../config/database';
import { assertCatalogTable, CatalogTable, tableScope } from '../db/tableCatalog';

let pool: Pool | null = null;

/**
 * The single connection pool, owned by the data layer. Only DataService and the
 * migration runner (server/src/db/migrate.ts) may use it; everything else goes
 * through dataService (coding standard "Direct Database Pool Usage").
 */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool(databaseConfig);
    pool.on('error', (err: Error) => {
      // An idle client failing (e.g. the database restarted) must not crash the API.
      console.error('Postgres pool error:', err.message);
    });
  }
  return pool;
}

/** Close the pool (scripts and graceful shutdown). Never throws. */
export async function closePool(): Promise<void> {
  if (!pool) {
    return;
  }
  const current = pool;
  pool = null;
  try {
    await current.end();
  } catch (err) {
    console.error('Error closing the Postgres pool:', (err as Error).message);
  }
}

/** Who the query runs for. Tenant tables require orgId. */
export interface QueryContext {
  orgId?: string;
  userId?: string;
}

/** A query handle bound to one transaction and one context. */
export interface Tx {
  query<T extends QueryResultRow>(table: CatalogTable, sql: string, params?: unknown[]): Promise<T[]>;
  /**
   * Enter an org context mid-transaction, for flows that create the org itself
   * (sign-up: create firm, then the owner's membership). Only allowed while no org
   * is set, so a transaction can never hop from one tenant to another.
   */
  setOrg(orgId: string): Promise<void>;
  /**
   * Read a tenant row by a secret token before any org is known (invite links,
   * password-reset links). The token hash is the credential and selects exactly one
   * row, so the SQL must filter on `token_hash = $1`; anything else is refused.
   * Use setOrg() with the row's org_id before touching other tenant data.
   */
  lookupByToken<T extends QueryResultRow>(table: CatalogTable, sql: string, params: unknown[]): Promise<T[]>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuid(value: string | undefined, name: string): string {
  if (!value || !UUID_RE.test(value)) {
    throw new Error(`${name} must be a UUID`);
  }
  return value;
}

/**
 * The only way application code talks to Postgres.
 *
 * - Every statement names the table it touches; the name is checked against the
 *   catalog, so unknown tables never reach SQL.
 * - Statements on tenant tables need an org context. The org and user ids are set
 *   as transaction-local settings (app.org_id / app.user_id) so the row-level
 *   security policies added in F8.1 can enforce isolation in the database too.
 * - Always parameterised: callers pass values in `params`, never in `sql`.
 */
export class DataService {
  /** Run a single statement in its own transaction. */
  async query<T extends QueryResultRow>(
    ctx: QueryContext,
    table: CatalogTable,
    sql: string,
    params: unknown[] = []
  ): Promise<T[]> {
    return this.transaction(ctx, (tx) => tx.query<T>(table, sql, params));
  }

  /** Run several statements atomically under one context; rolls back on any error. */
  async transaction<R>(ctx: QueryContext, work: (tx: Tx) => Promise<R>): Promise<R> {
    const client: PoolClient = await getPool().connect();
    let orgId: string | undefined = ctx.orgId ? assertUuid(ctx.orgId, 'orgId') : undefined;
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)",
        [orgId || '', ctx.userId ? assertUuid(ctx.userId, 'userId') : '']
      );

      const tx: Tx = {
        query: async <T extends QueryResultRow>(table: CatalogTable, sql: string, params: unknown[] = []) => {
          const checked = assertCatalogTable(table);
          if (tableScope(checked) === 'tenant' && !orgId) {
            throw new Error(`Table "${checked}" is tenant-scoped: an orgId is required.`);
          }
          const result = await client.query<T>(sql, params);
          return result.rows;
        },
        lookupByToken: async <T extends QueryResultRow>(table: CatalogTable, sql: string, params: unknown[]) => {
          assertCatalogTable(table);
          if (!/\btoken_hash\s*=\s*\$1(?!\d)/.test(sql)) {
            throw new Error('lookupByToken queries must filter on token_hash = $1');
          }
          const result = await client.query<T>(sql, params);
          return result.rows;
        },
        setOrg: async (newOrgId: string) => {
          if (orgId) {
            throw new Error('This transaction already has an org context; it cannot switch tenants.');
          }
          orgId = assertUuid(newOrgId, 'orgId');
          await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
        },
      };

      const value = await work(tx);
      await client.query('COMMIT');
      return value;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection may already be broken; the original error is what matters.
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

/** Shared instance; DataService holds no per-request state. */
export const dataService = new DataService();
