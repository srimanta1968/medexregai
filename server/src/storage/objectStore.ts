import { createHash } from 'crypto';
import { KMSClient } from '@aws-sdk/client-kms';
import { S3Client } from '@aws-sdk/client-s3';
import { config } from '../config/env';
import { S3ObjectStore } from './s3ObjectStore';
import { KmsTenantKeys } from './tenantKeys';
import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import { dirname, join, resolve, sep } from 'path';

/**
 * Where client file bytes live while we hold them. Uploads stay; fetched copies of
 * linked files are deleted after processing (ADR-010), keeping only hash, text and
 * locations in the database.
 *
 * Drivers: "fs" (local disk, development and tests) here; "s3" (s3ObjectStore.ts, F8.1)
 * keeps every object under orgs/<firm id>/ and, with STORAGE_KMS=tenant, encrypts it with
 * that firm's own KMS key (tenantKeys.ts).
 */
export interface ObjectStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Idempotent: deleting a missing object succeeds. */
  delete(key: string): Promise<void>;
  /** Delete every object under `prefix` (which must end with "/"). Idempotent. Returns how many were removed. */
  deletePrefix(prefix: string): Promise<number>;
}

export class ObjectNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`Object ${key} does not exist`);
    this.name = 'ObjectNotFoundError';
  }
}

// orgs/<uuid>/files/<uuid>/v<n>-<sha256 prefix>: no "..", no leading slash, no backslash.
const KEY_RE = /^(?!.*\.\.)[a-z0-9][a-z0-9/_.-]{0,511}$/;

export function assertObjectKey(key: string): string {
  if (!KEY_RE.test(key)) throw new Error(`Invalid object key: ${JSON.stringify(key)}`);
  return key;
}

/** The prefix every version of one file is stored under (per-project deletion removes it whole). */
export function fileObjectPrefix(orgId: string, fileId: string): string {
  return assertObjectKey(`orgs/${orgId}/files/${fileId}/`.toLowerCase());
}

/** The prefix of objects that belong to a project as a whole (e.g. raw forwarded emails). */
export function projectObjectPrefix(orgId: string, projectId: string): string {
  return assertObjectKey(`orgs/${orgId}/projects/${projectId}/`.toLowerCase());
}

/** The key a file version is stored under. Prefixed by firm so per-tenant policies (F8.1) can apply. */
export function versionObjectKey(orgId: string, fileId: string, versionNo: number, sha256: string): string {
  return assertObjectKey(`orgs/${orgId}/files/${fileId}/v${versionNo}-${sha256.slice(0, 16)}`.toLowerCase());
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class FsObjectStore implements ObjectStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    const full = resolve(join(this.root, assertObjectKey(key)));
    if (!full.startsWith(this.root + sep)) throw new Error(`Object key escapes the store: ${key}`);
    return full;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const file = this.path(key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes, { mode: 0o600 });
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.path(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new ObjectNotFoundError(key);
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<number> {
    if (!prefix.endsWith('/')) throw new Error(`A prefix must end with "/": ${prefix}`);
    const dir = this.path(prefix.slice(0, -1));
    let count = 0;
    try {
      count = (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).length;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }
    await rm(dir, { recursive: true, force: true });
    return count;
  }
}

let shared: ObjectStore | null = null;

/**
 * The configured store. STORAGE_DRIVER=fs (default) keeps objects under STORAGE_FS_ROOT;
 * STORAGE_DRIVER=s3 uses S3_* (SeaweedFS locally, AWS S3 in production) and, with STORAGE_KMS=tenant,
 * encrypts each firm's objects with its own KMS key (F8.1).
 */
export function objectStore(): ObjectStore {
  if (shared) return shared;
  const driver = (process.env.STORAGE_DRIVER ?? 'fs').trim();
  if (driver === 's3') {
    shared = s3StoreFromConfig();
    return shared;
  }
  if (driver !== 'fs') throw new Error(`STORAGE_DRIVER must be fs or s3, got "${driver}"`);
  shared = new FsObjectStore(process.env.STORAGE_FS_ROOT || join(__dirname, '..', '..', '.data', 'objects'));
  return shared;
}

function s3StoreFromConfig(): ObjectStore {
  const s = config.storage;
  const credentials = s.accessKeyId && s.secretAccessKey ? { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey } : undefined; // else the task role
  const s3 = new S3Client({ region: s.region, endpoint: s.endpoint, forcePathStyle: s.forcePathStyle, credentials });
  const keys = s.kms === 'tenant' ? new KmsTenantKeys(new KMSClient({ region: s.region }), s.environment) : null;
  return new S3ObjectStore(s3, s.bucket, keys);
}
