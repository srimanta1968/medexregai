import { closePool } from '../services/DataService';
import { bulkLoad } from './BulkLoader';

/**
 * Full-history load from openFDA bulk files:
 *   npm run fda:bulk -- classification
 *   npm run fda:bulk -- 510k recall
 *   npm run fda:bulk -- udi --max-partitions 2     (UDI has ~52 partitions)
 */
const KNOWN = ['classification', '510k', 'recall', 'udi'] as const;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf('--max-partitions');
  const maxPartitions = i >= 0 ? Number(args[i + 1]) : undefined;
  if (maxPartitions !== undefined && !(maxPartitions > 0)) throw new Error('--max-partitions must be a positive number');
  const names = args.filter((a, idx) => !a.startsWith('--') && args[idx - 1] !== '--max-partitions');
  const bad = names.filter((n) => !(KNOWN as readonly string[]).includes(n));
  if (!names.length || bad.length) throw new Error(`Name datasets to load: ${KNOWN.join(', ')}${bad.length ? ` (unknown: ${bad.join(', ')})` : ''}`);
  for (const name of names as (typeof KNOWN)[number][]) {
    const r = await bulkLoad(name, { maxPartitions, log: (m) => console.info(m) });
    console.info(`${name}: ${r.upserted.toLocaleString()} upserted from ${r.partitions} file(s), export date ${r.exportDate ?? 'unknown'}`);
  }
}

main()
  .then(() => closePool())
  .catch(async (err: unknown) => {
    console.error((err as Error).message);
    await closePool();
    process.exit(1);
  });
