#!/usr/bin/env node
/**
 * Local development only: run a command against database `fda_db` on the same dev
 * Postgres the main app uses, reusing its DB_* settings from server/.env (read in
 * process, never printed or copied). Production uses its own instance and
 * FDA_DATABASE_URL (ADR-017).
 *
 *   node scripts/with-dev-db.js npx ts-node --transpile-only src/db/migrate.ts
 */
const { spawn } = require('child_process');
const path = require('path');
const dotenv = require('dotenv');

const appEnv = dotenv.config({ path: path.join(__dirname, '..', '..', '..', 'server', '.env'), processEnv: {} }).parsed || {};
const env = { ...process.env };
if (!env.FDA_DATABASE_URL) {
  for (const k of ['HOST', 'PORT', 'USER', 'PASSWORD']) {
    if (!env[`FDA_DB_${k}`] && appEnv[`DB_${k}`]) env[`FDA_DB_${k}`] = appEnv[`DB_${k}`];
  }
  env.FDA_DB_NAME = env.FDA_DB_NAME || 'fda_db';
}
for (const k of ['OPENFDA_API_KEY', 'OPENFDA_MAX_PER_MINUTE', 'FDA_EVENT_PRODUCT_CODES', 'FDA_SYNC_HOUR_UTC']) {
  if (!env[k] && appEnv[k]) env[k] = appEnv[k];
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error('usage: node scripts/with-dev-db.js <command> [args...]');
  process.exit(2);
}
const child = spawn(cmd, args, { env, stdio: 'inherit', shell: process.platform === 'win32' });
child.on('exit', (code) => process.exit(code ?? 1));
