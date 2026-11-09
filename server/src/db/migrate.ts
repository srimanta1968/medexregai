import { createHash } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { PoolClient } from 'pg';
import { closePool, getPool } from '../services/DataService';

export interface MigrationFile {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
}

export interface MigrationPlan {
  pending: MigrationFile[];
  /** Applied migrations whose file has since been edited. Editing history is refused. */
  changed: { version: number; name: string }[];
  /** Applied migrations whose file no longer exists. */
  missing: { version: number; name: string }[];
}

export const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');
const FILE_RE = /^(\d{3})_([a-z0-9_]+)\.sql$/;
// Arbitrary constant: only one migration run at a time across all API instances.
const ADVISORY_LOCK_KEY = 482_917_301;

export function checksum(sql: string): string {
  // Normalise line endings so a Windows checkout does not look like an edit.
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

/** Read and validate migration files: NNN_name.sql, unique versions, ascending order. */
export function parseMigrationFiles(files: { fileName: string; sql: string }[]): MigrationFile[] {
  const seen = new Map<number, string>();
  const parsed = files
    .filter((f) => f.fileName.endsWith('.sql'))
    .map((f) => {
      const m = FILE_RE.exec(f.fileName);
      if (!m) {
        throw new Error(`Migration "${f.fileName}" must be named NNN_snake_case.sql`);
      }
      const version = Number(m[1]);
      const earlier = seen.get(version);
      if (earlier) {
        throw new Error(`Migrations "${earlier}" and "${f.fileName}" share version ${m[1]}`);
      }
      seen.set(version, f.fileName);
      return { version, name: m[2], sql: f.sql, checksum: checksum(f.sql) };
    });
  return parsed.sort((a, b) => a.version - b.version);
}

/** Decide what to run. Pure: no database access. */
export function planMigrations(files: MigrationFile[], applied: AppliedMigration[]): MigrationPlan {
  const byVersion = new Map(files.map((f) => [f.version, f]));
  const appliedVersions = new Set(applied.map((a) => a.version));
  const changed = applied
    .filter((a) => byVersion.has(a.version) && byVersion.get(a.version)!.checksum !== a.checksum)
    .map((a) => ({ version: a.version, name: a.name }));
  const missing = applied
    .filter((a) => !byVersion.has(a.version))
    .map((a) => ({ version: a.version, name: a.name }));
  const pending = files.filter((f) => !appliedVersions.has(f.version));
  return { pending, changed, missing };
}

export function loadMigrationFiles(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  const fileNames = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  return parseMigrationFiles(fileNames.map((fileName) => ({ fileName, sql: readFileSync(join(dir, fileName), 'utf8') })));
}

async function ensureHistoryTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      checksum    CHAR(64) NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
}

/**
 * Apply pending migrations, each in its own transaction, under an advisory lock.
 * Refuses to run if an applied migration was edited or deleted: history is fixed;
 * write a new migration instead.
 */
export async function runMigrations(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const files = loadMigrationFiles(dir);
  const client = await getPool().connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await ensureHistoryTable(client);
    const { rows } = await client.query<AppliedMigration>(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version'
    );
    const plan = planMigrations(files, rows);
    if (plan.changed.length || plan.missing.length) {
      const describe = (xs: { version: number; name: string }[]): string =>
        xs.map((x) => `${String(x.version).padStart(3, '0')}_${x.name}`).join(', ');
      throw new Error(
        [
          plan.changed.length ? `edited after being applied: ${describe(plan.changed)}` : '',
          plan.missing.length ? `applied but missing on disk: ${describe(plan.missing)}` : '',
        ]
          .filter(Boolean)
          .join('; ') + '. Write a new migration instead of changing history.'
      );
    }
    for (const migration of plan.pending) {
      try {
        await client.query('BEGIN');
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
          migration.version,
          migration.name,
          migration.checksum,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${migration.version}_${migration.name} failed: ${(err as Error).message}`);
      }
    }
    return plan.pending;
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    } finally {
      client.release();
    }
  }
}

if (require.main === module) {
  runMigrations()
    .then((applied) => {
      console.log(
        applied.length
          ? `Applied ${applied.length} migration(s): ${applied.map((m) => `${m.version}_${m.name}`).join(', ')}`
          : 'Database is up to date.'
      );
      return closePool();
    })
    .catch(async (err: Error) => {
      console.error(`Migration failed: ${err.message}`);
      await closePool();
      process.exit(1);
    });
}
