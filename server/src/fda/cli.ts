import { closePool } from '../services/DataService';
import { DATASETS, FdaSyncService } from './FdaSyncService';
import { FdaDataset } from './records';

/**
 * Run the openFDA delta sync by hand:
 *   npm run fda:sync                       all datasets
 *   npm run fda:sync -- 510k recall        some datasets
 *   npm run fda:sync -- 510k --from 2026-10-01 --to 2026-10-31
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const from = flag('--from');
  const to = flag('--to');
  for (const d of [from, to]) {
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`Dates must be YYYY-MM-DD, got ${d}`);
  }
  const named = args.filter((a, i) => !a.startsWith('--') && !['--from', '--to'].includes(args[i - 1] ?? ''));
  const unknown = named.filter((n) => !DATASETS.includes(n as FdaDataset));
  if (unknown.length) throw new Error(`Unknown dataset(s): ${unknown.join(', ')}. Known: ${DATASETS.join(', ')}`);
  const datasets = (named.length ? named : DATASETS) as FdaDataset[];

  const sync = new FdaSyncService();
  let failed = false;
  for (const d of datasets) {
    const r = await sync.run(d, { from, to });
    failed = failed || r.status === 'failed';
    console.info(`${d}: ${r.status}, ${r.upserted} upserted${r.windowFrom ? ` (${r.windowFrom}..${r.windowTo})` : ''}${r.sourceLastUpdated ? `, source as of ${r.sourceLastUpdated}` : ''}${r.error ? ` - ${r.error}` : ''}`);
  }
  await closePool();
  process.exit(failed ? 1 : 0);
}

main().catch(async (err: unknown) => {
  console.error((err as Error).message);
  await closePool();
  process.exit(1);
});
