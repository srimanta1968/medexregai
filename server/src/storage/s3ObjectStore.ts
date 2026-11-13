import { DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, NoSuchKey, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { assertObjectKey, ObjectNotFoundError, ObjectStore } from './objectStore';
import { TenantKeyStore } from './tenantKeys';

/** orgs/<org uuid>/...: every object belongs to exactly one firm (F8.1 per-tenant prefix). */
const ORG_PREFIX_RE = /^orgs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//;

/** The firm an object key belongs to; refuses keys outside orgs/<firm id>/. */
export function orgOfKey(key: string): string {
  const m = ORG_PREFIX_RE.exec(key);
  if (!m) throw new Error(`Object key must start with orgs/<firm id>/: ${JSON.stringify(key)}`);
  return m[1];
}

/**
 * S3 object store (STORAGE_DRIVER=s3). With a TenantKeyStore every object is written with SSE-KMS
 * under its firm's own key (S3 Bucket Keys on, to keep KMS calls and cost down); reads need no key
 * id, S3 decrypts with the key the object was written under, which the task role may use only for
 * tenant-tagged keys of its environment. Without one (local SeaweedFS) the bucket default applies.
 */
export class S3ObjectStore implements ObjectStore {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
    private readonly keys: TenantKeyStore | null,
  ) {}

  async put(key: string, bytes: Uint8Array): Promise<void> {
    assertObjectKey(key);
    const org = orgOfKey(key);
    const sse = this.keys ? { ServerSideEncryption: 'aws:kms' as const, SSEKMSKeyId: await this.keys.keyFor(org), BucketKeyEnabled: true } : {};
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ...sse }));
  }

  async get(key: string): Promise<Buffer> {
    assertObjectKey(key);
    try {
      const out = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!out.Body) throw new ObjectNotFoundError(key);
      return Buffer.from(await out.Body.transformToByteArray());
    } catch (err) {
      if (err instanceof NoSuchKey || (err instanceof S3ServiceException && err.$metadata.httpStatusCode === 404)) throw new ObjectNotFoundError(key);
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    assertObjectKey(key);
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** Delete every object under one firm's prefix (never wider than orgs/<firm id>/...). */
  async deletePrefix(prefix: string): Promise<number> {
    if (!prefix.endsWith('/')) throw new Error(`A prefix must end with "/": ${prefix}`);
    assertObjectKey(prefix.slice(0, -1));
    orgOfKey(prefix);
    let removed = 0;
    let token: string | undefined;
    do {
      const page = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      const objects = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (objects.length) {
        const out = await this.s3.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: objects, Quiet: true } }));
        if (out.Errors?.length) throw new Error(`Could not delete ${out.Errors.length} object(s) under ${prefix}: ${out.Errors[0].Code ?? 'error'}`);
        removed += objects.length;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return removed;
  }
}
