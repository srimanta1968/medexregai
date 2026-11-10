import { createWriteStream, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { Readable, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import { parser } from 'stream-json';
import { pick } from 'stream-json/filters/Pick';
import { streamArray } from 'stream-json/streamers/StreamArray';
import yauzl from 'yauzl';
import { q } from '../db/pool';
import { FdaDataset, upsertBatch } from './records';

/**
 * Full-history load from openFDA's bulk download files (https://open.fda.gov/data/downloads/).
 * The index (download.json) lists each dataset's zipped JSON partitions. Each zip
 * is streamed to a temp file, its JSON streamed record by record (the 510(k) file is
 * hundreds of MB), and upserted in batches, so memory stays flat. Deltas then keep
 * the copy current (FdaSyncService).
 */

type BulkDataset = Exclude<FdaDataset, 'event_counts'>;

interface Partition {
  file: string;
  records: number;
  display_name?: string;
}

const INDEX_URL = 'https://api.fda.gov/download.json';
const BATCH = 1000;

export interface BulkResult {
  dataset: BulkDataset;
  partitions: number;
  upserted: number;
  exportDate: string | null;
}

export async function bulkIndex(dataset: BulkDataset, fetchImpl: typeof fetch = fetch): Promise<{ partitions: Partition[]; exportDate: string | null }> {
  const res = await fetchImpl(INDEX_URL, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`download index ${res.status}`);
  const body = (await res.json()) as { results?: { device?: Record<string, { partitions?: Partition[]; export_date?: string }> } };
  const entry = body.results?.device?.[dataset];
  if (!entry?.partitions?.length) throw new Error(`no bulk files listed for device/${dataset}`);
  return { partitions: entry.partitions, exportDate: entry.export_date ?? null };
}

/** Download one zip to a temp file (yauzl needs random access). */
async function download(url: string, fetchImpl: typeof fetch): Promise<string> {
  if (!url.startsWith('https://download.open.fda.gov/')) throw new Error(`refusing to download from ${url}`);
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(30 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`download ${res.status} for ${url}`);
  const file = path.join(os.tmpdir(), `openfda-${Date.now()}-${path.basename(new URL(url).pathname)}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(file));
  return file;
}

/** Stream every record in the zip's JSON `results` array to onBatch. */
function streamZipResults(zipFile: string, onBatch: (records: Record<string, unknown>[]) => Promise<void>): Promise<number> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipFile, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('cannot open zip'));
      let total = 0;
      zip.on('entry', (entry: yauzl.Entry) => {
        if (!entry.fileName.endsWith('.json')) return zip.readEntry();
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e ?? new Error('cannot read zip entry'));
          let batch: Record<string, unknown>[] = [];
          const sink = new Writable({
            objectMode: true,
            write(chunk: { value: Record<string, unknown> }, _enc, done) {
              batch.push(chunk.value);
              total++;
              if (batch.length < BATCH) return done();
              const b = batch;
              batch = [];
              onBatch(b).then(() => done(), done);
            },
            final(done) {
              const b = batch;
              batch = [];
              (b.length ? onBatch(b) : Promise.resolve()).then(() => done(), done);
            },
          });
          pipeline(stream, parser(), pick({ filter: 'results' }), streamArray(), sink)
            .then(() => zip.readEntry())
            .catch(reject);
        });
      });
      zip.on('end', () => resolve(total));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

export async function bulkLoad(
  dataset: BulkDataset,
  opts: { maxPartitions?: number; fetchImpl?: typeof fetch; log?: (m: string) => void } = {},
): Promise<BulkResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? (() => undefined);
  const { partitions, exportDate } = await bulkIndex(dataset, fetchImpl);
  const selected = partitions.slice(0, opts.maxPartitions ?? partitions.length);
  const [run] = await q<{ id: string }>(`INSERT INTO fda_sync_runs (dataset, mode, window_to) VALUES ($1, 'bulk', $2) RETURNING id`, [dataset, exportDate]);
  let upserted = 0;
  try {
    for (const [i, p] of selected.entries()) {
      log(`${dataset}: partition ${i + 1}/${selected.length} (${p.records.toLocaleString()} records) downloading`);
      const file = await download(p.file, fetchImpl);
      try {
        await streamZipResults(file, async (records) => {
          upserted += await upsertBatch(dataset, records);
        });
      } finally {
        await fs.rm(file, { force: true });
      }
      log(`${dataset}: ${upserted.toLocaleString()} upserted so far`);
    }
    await q(`UPDATE fda_sync_runs SET status = 'succeeded', finished_at = now(), records_upserted = $2, source_last_updated = $3 WHERE id = $1`, [
      run.id,
      upserted,
      exportDate,
    ]);
    return { dataset, partitions: selected.length, upserted, exportDate };
  } catch (err) {
    await q(`UPDATE fda_sync_runs SET status = 'failed', finished_at = now(), records_upserted = $2, error = $3 WHERE id = $1`, [
      run.id,
      upserted,
      (err as Error).message.slice(0, 1000),
    ]);
    throw err;
  }
}
