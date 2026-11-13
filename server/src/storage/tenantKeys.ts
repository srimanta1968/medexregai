import { AlreadyExistsException, CreateAliasCommand, CreateKeyCommand, EnableKeyRotationCommand, KMSClient, ScheduleKeyDeletionCommand } from '@aws-sdk/client-kms';
import { dataService } from '../services/DataService';

/**
 * F8.1 per-tenant storage keys. Each firm's client files in S3 are encrypted (SSE-KMS) with that
 * firm's own customer-managed KMS key, so access can be audited per firm in CloudTrail and a firm's
 * files can be made unreadable at once by scheduling its key for deletion (crypto-shredding).
 *
 * The key is created the first time a firm stores a file and recorded in org_storage_keys (RLS).
 * Tags and the alias follow the IAM policy in infra/terraform/modules/platform/compute.tf
 * (api_tenant_keys): tag keys medexregai:tenant and medexregai:environment only, alias
 * alias/medexregai-<environment>-tenant-<org id>.
 */
export interface TenantKeyStore {
  /** The KMS key ARN that encrypts this firm's objects; created on first use. */
  keyFor(orgId: string): Promise<string>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A key created by a task that lost the race to record it is never used; delete it soon. */
const LOSER_KEY_DELETION_DAYS = 7;

export class KmsTenantKeys implements TenantKeyStore {
  private readonly cache = new Map<string, string>();
  private readonly pending = new Map<string, Promise<string>>();

  constructor(
    private readonly kms: KMSClient,
    private readonly environment: string,
  ) {}

  async keyFor(orgId: string): Promise<string> {
    if (!UUID_RE.test(orgId)) throw new Error(`orgId must be a UUID: ${orgId}`);
    const cached = this.cache.get(orgId);
    if (cached) return cached;
    let p = this.pending.get(orgId);
    if (!p) {
      p = this.resolve(orgId).finally(() => this.pending.delete(orgId));
      this.pending.set(orgId, p);
    }
    const arn = await p;
    this.cache.set(orgId, arn);
    return arn;
  }

  private async recorded(orgId: string): Promise<string | undefined> {
    const [row] = await dataService.query<{ kms_key_arn: string }>({ orgId }, 'org_storage_keys', 'SELECT kms_key_arn FROM org_storage_keys WHERE org_id = $1', [orgId]);
    return row?.kms_key_arn;
  }

  private async resolve(orgId: string): Promise<string> {
    const existing = await this.recorded(orgId);
    if (existing) return existing;

    const created = await this.kms.send(
      new CreateKeyCommand({
        Description: `MedexRegAI ${this.environment}: client files of firm ${orgId}`,
        KeyUsage: 'ENCRYPT_DECRYPT',
        KeySpec: 'SYMMETRIC_DEFAULT',
        Tags: [
          { TagKey: 'medexregai:tenant', TagValue: orgId },
          { TagKey: 'medexregai:environment', TagValue: this.environment },
        ],
      }),
    );
    const keyId = created.KeyMetadata?.KeyId;
    const arn = created.KeyMetadata?.Arn;
    if (!keyId || !arn) throw new Error('KMS CreateKey returned no key');
    await this.kms.send(new EnableKeyRotationCommand({ KeyId: keyId }));

    const [won] = await dataService.query<{ kms_key_arn: string }>(
      { orgId },
      'org_storage_keys',
      'INSERT INTO org_storage_keys (org_id, kms_key_arn) VALUES ($1, $2) ON CONFLICT (org_id) DO NOTHING RETURNING kms_key_arn',
      [orgId, arn],
    );
    if (!won) {
      // Another API task recorded a key for this firm first: use that one and retire ours.
      await this.kms.send(new ScheduleKeyDeletionCommand({ KeyId: keyId, PendingWindowInDays: LOSER_KEY_DELETION_DAYS }));
      const winner = await this.recorded(orgId);
      if (!winner) throw new Error(`No storage key recorded for firm ${orgId}`);
      return winner;
    }
    try {
      await this.kms.send(new CreateAliasCommand({ AliasName: `alias/medexregai-${this.environment}-tenant-${orgId}`, TargetKeyId: keyId }));
    } catch (err) {
      // The alias is only a readable name for operators; the recorded ARN is what encrypts.
      if (!(err instanceof AlreadyExistsException)) throw err;
    }
    return arn;
  }
}
