import { closePools, q } from '../db/pool';
import { Scope, createClient, revokeClient } from './apiClients';

/**
 * Manage fda-data API clients:
 *   npm run clients -- create medexregai-app fda:read fda:track [--rate 1200]
 *   npm run clients -- list
 *   npm run clients -- revoke medexregai-app
 * The key is printed once on create; store it in the caller's secret store
 * (e.g. FDA_SERVICE_KEY for the main app). It cannot be shown again.
 */
async function main(): Promise<void> {
  const [cmd, name, ...rest] = process.argv.slice(2);
  if (cmd === 'create' && name) {
    const r = rest.indexOf('--rate');
    const rate = r >= 0 ? Number(rest[r + 1]) : 1200;
    const scopes = rest.filter((s, i) => !s.startsWith('--') && rest[i - 1] !== '--rate') as Scope[];
    const { key, client } = await createClient(name, scopes, rate);
    console.info(`Created API client "${client.name}" with scopes ${client.scopes.join(', ')}, ${client.ratePerMinute}/min.`);
    console.info('Key (shown once, store it now):');
    console.info(key);
  } else if (cmd === 'list') {
    const rows = await q<{ name: string; key_prefix: string; scopes: string[]; last_used_at: Date | null; revoked_at: Date | null }>(
      'SELECT name, key_prefix, scopes, last_used_at, revoked_at FROM api_clients ORDER BY created_at'
    );
    for (const c of rows) {
      console.info(`${c.name}  fdk_${c.key_prefix}_…  ${c.scopes.join(',')}  ${c.revoked_at ? 'REVOKED' : 'active'}  last used ${c.last_used_at?.toISOString() ?? 'never'}`);
    }
  } else if (cmd === 'revoke' && name) {
    console.info((await revokeClient(name)) ? `Revoked "${name}".` : `No active client named "${name}".`);
  } else {
    throw new Error('Usage: clients create <name> <scope...> [--rate N] | clients list | clients revoke <name>');
  }
}

main()
  .then(() => closePools())
  .catch(async (err: unknown) => {
    console.error((err as Error).message);
    await closePools();
    process.exit(1);
  });
