/**
 * Local development only: create (or rotate) the main app's fda-data API key and
 * write FDA_SERVICE_URL / FDA_SERVICE_KEY into server/.env. The key is never
 * printed. Run with: npm run dev:app-key
 */
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createClient } from '../src/auth/apiClients';
import { closePools, q } from '../src/db/pool';

const NAME = 'medexregai-app-dev';
const ENV_FILE = join(__dirname, '..', '..', '..', 'server', '.env');

function setVar(text: string, name: string, value: string): string {
  const line = `${name}=${value}`;
  const re = new RegExp(`^${name}=.*$`, 'm');
  return re.test(text) ? text.replace(re, line) : `${text.replace(/\s*$/, '')}\n${line}\n`;
}

async function main(): Promise<void> {
  // Rotate: the old dev key stops working.
  await q('DELETE FROM api_clients WHERE name = $1', [NAME]);
  const { key } = await createClient(NAME, ['fda:read', 'fda:track']);
  let env = readFileSync(ENV_FILE, 'utf8');
  env = setVar(env, 'FDA_SERVICE_URL', process.env.FDA_SERVICE_URL || 'http://localhost:4100');
  env = setVar(env, 'FDA_SERVICE_KEY', key);
  writeFileSync(ENV_FILE, env);
  console.info(`API client "${NAME}" (fda:read, fda:track) created; FDA_SERVICE_URL and FDA_SERVICE_KEY written to server/.env (key not shown).`);
}

main()
  .then(() => closePools())
  .catch(async (err: unknown) => {
    console.error((err as Error).message);
    await closePools();
    process.exit(1);
  });
