import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import { dirname, join, resolve, sep } from 'path';

/**
 * The FDA document bucket: public 510(k) summary PDFs (F1.2). Kept apart from the
 * client-file bucket by design (ADR-017): nothing here is customer data, and fda-data
 * never has access to client files.
 *
 * Drivers: "s3" (AWS S3, or any S3-compatible store such as the local SeaweedFS) when
 * FDA_DOCS_BUCKET is set; otherwise "fs" under FDA_DOCS_DIR (local development).
 */
export interface DocumentStore {
  readonly driver: 's3' | 'fs';
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Size in bytes, or null when the object does not exist. */
  size(key: string): Promise<number | null>;
}

// 510k-summaries/K123456.pdf: no "..", no leading slash, no backslash.
const KEY_RE = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9/_.-]{0,255}$/;

export function assertDocumentKey(key: string): string {
  if (!KEY_RE.test(key)) throw new Error(`Invalid document key: ${JSON.stringify(key)}`);
  return key;
}

export function summaryKey(kNumber: string): string {
  return assertDocumentKey(`510k-summaries/${kNumber}.pdf`);
}

export class FsDocumentStore implements DocumentStore {
  readonly driver = 'fs' as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    const p = resolve(join(this.root, assertDocumentKey(key)));
    if (!p.startsWith(this.root + sep)) throw new Error(`Document key escapes the store: ${key}`);
    return p;
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }

  async size(key: string): Promise<number | null> {
    try {
      return (await stat(this.path(key))).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
}

export interface S3StoreOptions {
  bucket: string;
  region: string;
  /** Set for an S3-compatible store (local SeaweedFS); omit for AWS. */
  endpoint?: string;
  forcePathStyle?: boolean;
  /** Omit in AWS: the task role's credentials are used. */
  accessKeyId?: string;
  secretAccessKey?: string;
}

export class S3DocumentStore implements DocumentStore {
  readonly driver = 's3' as const;
  private readonly client: S3Client;

  constructor(private readonly opts: S3StoreOptions) {
    this.client = new S3Client({
      region: opts.region,
      endpoint: opts.endpoint || undefined,
      forcePathStyle: opts.forcePathStyle ?? Boolean(opts.endpoint),
      credentials:
        opts.accessKeyId && opts.secretAccessKey ? { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey } : undefined,
    });
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.opts.bucket, Key: assertDocumentKey(key), Body: bytes, ContentType: contentType }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: assertDocumentKey(key) }));
    if (!out.Body) throw new Error(`Document ${key} has no body`);
    return Buffer.from(await out.Body.transformToByteArray());
  }

  async size(key: string): Promise<number | null> {
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.opts.bucket, Key: assertDocumentKey(key) }));
      return out.ContentLength ?? 0;
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw err;
    }
  }
}
