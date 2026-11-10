import { createHash } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { closePools, primaryPool } from './pool';

/**
 * Forward-only migrations for the FDA database, same rules as the main app:
 * NNN_name.sql, one transaction each, under an advisory lock, and refusing to run
 * if an applied file was edited or deleted.
 */
const DIR = join(__dirname, '..', '..', 'migrations');
const FILE_RE = /^(\d{3})_([a-z0-9_]+)\.sql$/;
const LOCK = 731_204_118;

const checksum = (sql: string): string => createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');

export async function runMigrations(): Promise<string[]> {
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => {
      const m = FILE_RE.exec(f);
      if (!m) throw new Error(`Migration "${f}" must be named NNN_snake_case.sql`);
      const sql = readFileSync(join(DIR, f), 'utf8');
      return { version: Number(m[1]), name: m[2], sql, checksum: checksum(sql) };
    })
    .sort((a, b) => a.version - b.version);
  const client = await primaryPool().connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY, name text NOT NULL, checksum char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await client.query<{ version: number; name: string; checksum: string }>('SELECT version, name, checksum FROM schema_migrations');
    const byVersion = new Map(files.map((f) => [f.version, f]));
    const bad = rows.filter((r) => byVersion.get(r.version)?.checksum !== r.checksum);
    if (bad.length)
      throw new Error(`Applied migrations edited or missing: ${bad.map((b) => `${b.version}_${b.name}`).join(', ')}. Write a new migration instead.`);
    const done = new Set(rows.map((r) => r.version));
    const applied: string[] = [];
    for (const m of files.filter((f) => !done.has(f.version))) {
      try {
        await client.query('BEGIN');
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [m.version, m.name, m.checksum]);
        await client.query('COMMIT');
        applied.push(`${m.version}_${m.name}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${m.version}_${m.name} failed: ${(err as Error).message}`);
      }
    }
    return applied;
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK]);
    } finally {
      client.release();
    }
  }
}

if (require.main === module) {
  runMigrations()
    .then(async (applied) => {
      console.info(applied.length ? `Applied ${applied.length} migration(s): ${applied.join(', ')}` : 'FDA database is up to date.');
      await closePools();
    })
    .catch(async (err: Error) => {
      console.error(`Migration failed: ${err.message}`);
      await closePools();
      process.exit(1);
    });
}
