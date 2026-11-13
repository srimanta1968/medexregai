/**
 * F8.1 CI gate (`npm run db:checks`, after migrations): the scale and isolation rules are checked
 * against the real schema, not just documented.
 *
 *  1. Row-level security: every tableCatalog 'tenant' table has org_id, RLS enabled and FORCED, and
 *     the tenant_isolation policy; any other table with org_id must be listed as 'platform' (a
 *     deliberate cross-firm table). The app role medexregai_app exists, is not a superuser, cannot
 *     bypass RLS, and has read/write on every catalog table.
 *  2. Isolation, for real: as medexregai_app inside a rolled-back transaction, a firm's row is
 *     invisible with no firm set and with another firm set, visible to its own firm, a cross-firm
 *     write is refused, and `SET row_security = off` is refused.
 *  3. Pagination: every GET list route in src/routes reads a limit/cursor, or is listed in
 *     BOUNDED_LISTS with the reason it cannot grow without bound. A new unlisted list fails.
 *  4. Indexes: each hot query is EXPLAINed with sequential scans disabled; a plan that still scans
 *     the table means no index serves it.
 *
 * Runs on an owner session from DataService.withOwnerSession; that role must be allowed to
 * SET ROLE medexregai_app (CI's superuser; locally DB_MIGRATION_USER).
 * Prints one line per check; exits 1 on any failure.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { OwnerQuery, withOwnerSession } from '../services/DataService';
import { TABLE_CATALOG } from './tableCatalog';

const APP_ROLE = 'medexregai_app';
const ROUTES_DIR = join(__dirname, '..', 'routes');

/** GET routes that return a whole list on purpose: each is small by construction. */
export const BOUNDED_LISTS: Record<string, string> = {
  '/api/settings/ai': 'one settings record per firm',
  '/api/settings/ai-providers/:providerId/evaluations': 'latest evaluations of one provider, LIMIT in EvalStore',
  '/api/app/navigation': 'fixed menu',
  '/api/audit/verify': 'one verification result',
  '/api/auth/mfa': "the caller's MFA status",
  '/api/billing': 'plan, balance, catalog and the latest ledger lines (LIMIT in BillingService)',
  '/api/connections/providers': 'fixed list of storage providers',
  '/api/project-sections/:sectionId/draft': 'one draft',
  '/api/projects/:projectId/estar-xml': 'export status of one project',
  '/api/fda-letters/:letterId/response-skeleton': 'one document built from one letter',
  '/api/file-versions/:versionId/passages': 'passages of one file version for citation display (bounded by the file)',
  '/api/projects/:projectId/revisions': 'recent revisions, LIMIT in ImpactService',
  '/api/file-versions/:versionId/impact': 'impact of one revision',
  '/api/projects/:projectId/inbound-email': "one project's inbound address",
  '/api/introductions/settings': "the firm's directory settings",
  '/api/pilot/baseline': 'one row per fixed time activity',
  '/api/projects/:projectId/pilot-report': 'one report',
  '/api/estar-templates': 'fixed eSTAR template list',
  '/api/projects/:projectId/readiness': 'one row per eSTAR section (fixed set)',
  '/api/projects/:projectId/records': 'latest 100 record events (LIMIT 100), full history via export',
  '/api/projects/:projectId/sections': 'one row per eSTAR section (fixed set)',
  '/api/project-sections/:sectionId/history': 'latest 100 status events of one section (LIMIT 100)',
  '/api/estar-sections': 'fixed eSTAR section catalog',
  '/api/projects/:projectId/estar-coverage': 'one row per eSTAR section (fixed set)',
  '/api/projects/:projectId/version-groups': 'open revision groups, LIMIT 200',
  '/api/auth/sso/providers': 'fixed SSO provider list',
  '/api/style-sources': "the firm's style settings",
  '/api/project-sections/:sectionId/precedents': 'top precedents for one section (LIMIT in StyleSourceService)',
  '/api/projects/:projectId/summary-tables': 'one table per eSTAR section that needs one (fixed set)',
  '/api/projects/:projectId/admin-docs': 'fixed set of administrative documents',
  '/api/time/activities': 'fixed time activity catalog',
  '/api/time/current': "the caller's running timer",
  '/api/time/summary': 'totals per project and activity for a bounded date range',
  '/api/trust-pack': 'fixed trust documents',
  '/api/settings/data-use': "the firm's data-use settings",
  '/api/usage': 'totals for a bounded month range',
};

/** Hot list queries and the table each must reach through an index. */
const HOT_QUERIES: { name: string; table: string; sql: string }[] = [
  { name: 'clients list', table: 'client_workspaces', sql: 'SELECT id FROM client_workspaces WHERE org_id = $1 ORDER BY created_at DESC, id DESC LIMIT 51' },
  { name: 'devices of a client', table: 'devices', sql: 'SELECT id FROM devices WHERE org_id = $1 AND workspace_id = $2 ORDER BY created_at DESC, id DESC LIMIT 51' },
  { name: 'projects of a client', table: 'projects', sql: 'SELECT id FROM projects WHERE org_id = $1 AND workspace_id = $2 ORDER BY created_at DESC, id DESC LIMIT 51' },
  { name: 'portfolio (recent projects)', table: 'projects', sql: 'SELECT id FROM projects WHERE org_id = $1 ORDER BY updated_at DESC, id DESC LIMIT 51' },
  { name: 'project files', table: 'files', sql: 'SELECT id FROM files WHERE org_id = $1 AND project_id = $2 ORDER BY updated_at DESC, id DESC LIMIT 51' },
  {
    name: 'problems list',
    table: 'problems',
    sql: "SELECT id FROM problems WHERE org_id = $1 AND project_id = $2 AND status = 'open' ORDER BY severity, created_at DESC, id DESC LIMIT 51",
  },
  { name: 'client requests', table: 'client_requests', sql: 'SELECT id FROM client_requests WHERE org_id = $1 AND project_id = $2 ORDER BY created_at DESC, id DESC LIMIT 51' },
  { name: 'FDA letters', table: 'fda_letters', sql: 'SELECT id FROM fda_letters WHERE org_id = $1 AND project_id = $2 ORDER BY issued_on DESC, id DESC LIMIT 51' },
  { name: 'SE comparisons', table: 'se_comparisons', sql: 'SELECT id FROM se_comparisons WHERE org_id = $1 AND project_id = $2 ORDER BY created_at DESC, id DESC LIMIT 51' },
  { name: 'audit trail', table: 'audit_events', sql: 'SELECT id FROM audit_events WHERE org_id = $1 ORDER BY created_at DESC, id DESC LIMIT 51' },
  { name: 'API keys', table: 'api_keys', sql: 'SELECT id FROM api_keys WHERE org_id = $1 ORDER BY created_at DESC, id DESC LIMIT 51' },
  { name: 'credit ledger', table: 'credit_ledger', sql: 'SELECT id FROM credit_ledger WHERE org_id = $1 ORDER BY created_at DESC, id DESC LIMIT 51' },
  { name: 'introductions', table: 'introductions', sql: 'SELECT id FROM introductions WHERE org_id = $1 ORDER BY offered_at DESC, id DESC LIMIT 51' },
  { name: 'time entries', table: 'time_entries', sql: 'SELECT id FROM time_entries WHERE org_id = $1 AND user_id = $2 ORDER BY started_at DESC, id LIMIT 51' },
  { name: 'memberships at sign-in', table: 'memberships', sql: 'SELECT id FROM memberships WHERE user_id = $1' },
  { name: 'API key lookup', table: 'api_keys', sql: 'SELECT id FROM api_keys WHERE token_hash = $1' },
];

type Result = { name: string; ok: boolean; detail?: string };

async function rlsSchema(run: OwnerQuery): Promise<Result[]> {
  const out: Result[] = [];
  const { rows } = await run<{ relname: string; has_org: boolean; rls: boolean; forced: boolean; policy: boolean }>(
    `SELECT t.relname,
            EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attname = 'org_id' AND NOT a.attisdropped) AS has_org,
            t.relrowsecurity AS rls, t.relforcerowsecurity AS forced,
            EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = t.oid AND p.polname = 'tenant_isolation') AS policy
       FROM pg_class t WHERE t.relkind = 'r' AND t.relnamespace = 'public'::regnamespace`,
  );
  const byName = new Map(rows.map((r) => [r.relname, r]));
  const catalog = TABLE_CATALOG as Record<string, string>;
  const bad: string[] = [];
  for (const [table, scope] of Object.entries(catalog)) {
    if (scope !== 'tenant') continue;
    const r = byName.get(table);
    if (!r) bad.push(`${table}: missing`);
    else if (!r.has_org || !r.rls || !r.forced || !r.policy) bad.push(`${table}: org_id ${r.has_org}, rls ${r.rls}, forced ${r.forced}, policy ${r.policy}`);
  }
  out.push({ name: 'every tenant table has org_id + forced RLS + tenant_isolation', ok: bad.length === 0, detail: bad.join('; ') });
  const stray = rows.filter((r) => r.has_org && !r.forced && catalog[r.relname] !== 'platform').map((r) => r.relname);
  out.push({ name: 'no unprotected org_id table outside the platform list', ok: stray.length === 0, detail: stray.join(', ') });

  const role = await run<{ rolsuper: boolean; rolbypassrls: boolean }>('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', [APP_ROLE]);
  const r = role.rows[0];
  out.push({ name: `${APP_ROLE} exists, not superuser, no BYPASSRLS`, ok: Boolean(r && !r.rolsuper && !r.rolbypassrls), detail: r ? JSON.stringify(r) : 'missing' });
  const ungranted: string[] = [];
  for (const table of Object.keys(catalog)) {
    if (!byName.has(table)) continue;
    const g = await run<{ ok: boolean }>("SELECT has_table_privilege($1, $2, 'SELECT,INSERT,UPDATE,DELETE') AS ok", [APP_ROLE, `public.${table}`]);
    if (!g.rows[0].ok) ungranted.push(table);
  }
  out.push({ name: `${APP_ROLE} can read and write every catalog table`, ok: ungranted.length === 0, detail: ungranted.join(', ') });
  return out;
}

async function rlsBehaviour(run: OwnerQuery): Promise<Result[]> {
  const out: Result[] = [];
  await run('BEGIN');
  try {
    const [{ id: orgA }] = (
      await run<{ id: string }>("INSERT INTO orgs (name, slug) VALUES ('RLS check firm', 'rls-check-' || substr(md5(random()::text), 1, 12)) RETURNING id")
    ).rows;
    await run("SELECT set_config('app.org_id', $1, true)", [orgA]);
    const [{ id: clientId }] = (await run<{ id: string }>("INSERT INTO client_workspaces (org_id, name) VALUES ($1, 'RLS check client') RETURNING id", [orgA])).rows;
    await run(`SET LOCAL ROLE ${APP_ROLE}`);
    const visible = async (org: string) => {
      await run("SELECT set_config('app.org_id', $1, true)", [org]);
      return (await run('SELECT 1 FROM client_workspaces WHERE id = $1', [clientId])).rowCount;
    };
    const other = '00000000-0000-4000-8000-000000000001';
    out.push({ name: 'no firm set: row hidden', ok: (await visible('')) === 0 });
    out.push({ name: "another firm: row hidden", ok: (await visible(other)) === 0 });
    out.push({ name: 'own firm: row visible', ok: (await visible(orgA)) === 1 });
    await run("SELECT set_config('app.org_id', $1, true)", [other]);
    await run('SAVEPOINT w');
    let refused = false;
    try {
      await run("INSERT INTO client_workspaces (org_id, name) VALUES ($1, 'cross-firm write')", [orgA]);
    } catch {
      refused = true;
    }
    await run('ROLLBACK TO SAVEPOINT w');
    out.push({ name: 'cross-firm write refused', ok: refused });
    await run('SAVEPOINT s');
    let offRefused = false;
    try {
      await run('SET LOCAL row_security = off');
      await run('SELECT 1 FROM client_workspaces LIMIT 1');
    } catch {
      offRefused = true;
    }
    await run('ROLLBACK TO SAVEPOINT s');
    out.push({ name: 'row_security = off refused', ok: offRefused });
  } finally {
    await run('ROLLBACK');
  }
  return out;
}

/** GET routes per file, and whether each reads a page size (directly or through a schema in its file). */
export function listRoutes(dir: string = ROUTES_DIR): { path: string; paged: boolean }[] {
  const found: { path: string; paged: boolean }[] = [];
  for (const f of readdirSync(dir).filter((x) => /\.(ts|js)$/.test(x) && !x.endsWith('.d.ts'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    // Schemas in this file that define a page size: `const listQuery = z.object({ limit: ... })`.
    const pagedSchemas = [...src.matchAll(/const (\w+)\s*=\s*z\b([\s\S]*?);\n/g)].filter((x) => /\blimit\b/.test(x[2])).map((x) => x[1]);
    const blocks = src.split(/\n(?=\w+Router\.(?:get|post|put|patch|delete)\()/);
    for (const block of blocks) {
      const m = /^\w+Router\.get\(\s*'([^']+)'/.exec(block);
      if (!m) continue;
      const path = m[1];
      if (/\/:\w+$/.test(path) || /(export|csv|pdf|certificate|callback|start|health|status|meta|me)$/.test(path)) continue;
      const handler = block.split(/\n\);\n/)[0];
      const schemaPaged = pagedSchemas.some((n) => new RegExp(`\\b${n}\\b`).test(handler));
      found.push({ path, paged: /\blimit\b|pageSize|\bcursor\b/.test(handler) || schemaPaged });
    }
  }
  return found;
}

function pagination(): Result[] {
  const routes = listRoutes();
  const unlisted = routes.filter((r) => !r.paged && !BOUNDED_LISTS[r.path]).map((r) => r.path);
  const known = new Set(routes.map((r) => r.path));
  const stale = Object.keys(BOUNDED_LISTS).filter((p) => !known.has(p));
  return [
    { name: `every GET list route is cursor-paged or listed as bounded (${routes.length} routes)`, ok: unlisted.length === 0, detail: unlisted.join(', ') },
    { name: 'no stale entries in BOUNDED_LISTS', ok: stale.length === 0, detail: stale.join(', ') },
  ];
}

async function indexes(run: OwnerQuery): Promise<Result[]> {
  const out: Result[] = [];
  await run('BEGIN');
  try {
    await run('SET LOCAL enable_seqscan = off');
    for (const q of HOT_QUERIES) {
      const n = (q.sql.match(/\$\d/g) ?? []).length;
      const params = Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-00000000000${i + 1}`);
      const plan = await run<{ 'QUERY PLAN': unknown }>(`EXPLAIN (FORMAT JSON) ${q.sql}`, params);
      const text = JSON.stringify(plan.rows[0]['QUERY PLAN']);
      const seq = new RegExp(`"Node Type":"Seq Scan"[^}]*"Relation Name":"${q.table}"`).test(text);
      out.push({ name: `index: ${q.name}`, ok: !seq, detail: seq ? `sequential scan on ${q.table}` : undefined });
    }
  } finally {
    await run('ROLLBACK');
  }
  return out;
}

export async function runScaleChecks(): Promise<Result[]> {
  return withOwnerSession(async (run) => [...(await rlsSchema(run)), ...(await rlsBehaviour(run)), ...pagination(), ...(await indexes(run))]);
}

/* eslint-disable no-console -- a CLI report */
if (require.main === module) {
  runScaleChecks()
    .then((results) => {
      for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${!r.ok && r.detail ? `  -> ${r.detail}` : ''}`);
      const failed = results.filter((r) => !r.ok).length;
      console.log(failed ? `\n${failed} check(s) failed` : `\nall ${results.length} checks passed`);
      process.exit(failed ? 1 : 0);
    })
    .catch((err: unknown) => {
      console.error('scale checks could not run:', err);
      process.exit(1);
    });
}
