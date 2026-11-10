import { randomUUID } from 'crypto';
import { dataService } from '../services/DataService';
import { openSecret, sealSecret, secretHint } from '../utils/secretBox';
import { ProviderSettings } from './providers';

/**
 * Firm-supplied AI providers (F7.1 bring-your-own model). The only code that
 * touches key_ciphertext: public reads never select it, and the decrypted key is
 * handed only to the provider adapter for that firm's own calls.
 */

export type FirmProviderKind = 'openai_compatible' | 'anthropic';

/** What the API may return about a firm provider. Never includes the key. */
export interface FirmProvider {
  id: string;
  name: string;
  kind: FirmProviderKind;
  baseUrl: string;
  generationModel: string;
  keyHint: string;
  testStatus: 'untested' | 'passed' | 'failed';
  testedAt: string | null;
  testError: string | null;
  evalStatus: 'not_run' | 'running' | 'passed' | 'failed';
  evalAt: string | null;
  enabledRoutes: string[];
  createdAt: string;
}

const PUBLIC_COLUMNS = `id, name, kind, base_url, generation_model, key_hint, test_status, tested_at, test_error,
  eval_status, eval_at, enabled_routes, created_at`;

interface Row {
  id: string;
  name: string;
  kind: FirmProviderKind;
  base_url: string;
  generation_model: string;
  key_hint: string;
  test_status: FirmProvider['testStatus'];
  tested_at: Date | null;
  test_error: string | null;
  eval_status: FirmProvider['evalStatus'];
  eval_at: Date | null;
  enabled_routes: string[];
  created_at: Date;
}

const toPublic = (r: Row): FirmProvider => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  baseUrl: r.base_url,
  generationModel: r.generation_model,
  keyHint: r.key_hint,
  testStatus: r.test_status,
  testedAt: r.tested_at ? r.tested_at.toISOString() : null,
  testError: r.test_error,
  evalStatus: r.eval_status,
  evalAt: r.eval_at ? r.eval_at.toISOString() : null,
  enabledRoutes: r.enabled_routes,
  createdAt: r.created_at.toISOString(),
});

/** AAD for the sealed key: a ciphertext only opens on its own firm and row. */
const keyContext = (orgId: string, id: string): string => `firm-provider:${orgId}:${id}`;

export interface NewFirmProvider {
  name: string;
  kind: FirmProviderKind;
  baseUrl: string;
  generationModel: string;
  apiKey: string;
}

export const firmProviderStore = {
  async create(orgId: string, userId: string, p: NewFirmProvider): Promise<FirmProvider> {
    const id = randomUUID();
    const [row] = await dataService.query<Row>(
      { orgId, userId },
      'firm_model_providers',
      `INSERT INTO firm_model_providers (id, org_id, name, kind, base_url, generation_model, key_ciphertext, key_hint, created_by)
       VALUES ($1, current_setting('app.org_id')::uuid, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${PUBLIC_COLUMNS}`,
      [id, p.name, p.kind, p.baseUrl, p.generationModel, sealSecret(p.apiKey, keyContext(orgId, id)), secretHint(p.apiKey), userId]
    );
    return toPublic(row);
  },

  async list(orgId: string): Promise<FirmProvider[]> {
    const rows = await dataService.query<Row>(
      { orgId },
      'firm_model_providers',
      `SELECT ${PUBLIC_COLUMNS} FROM firm_model_providers WHERE org_id = current_setting('app.org_id')::uuid ORDER BY created_at DESC, id DESC`,
      []
    );
    return rows.map(toPublic);
  },

  async get(orgId: string, id: string): Promise<FirmProvider | null> {
    const [row] = await dataService.query<Row>(
      { orgId },
      'firm_model_providers',
      `SELECT ${PUBLIC_COLUMNS} FROM firm_model_providers WHERE org_id = current_setting('app.org_id')::uuid AND id = $1`,
      [id]
    );
    return row ? toPublic(row) : null;
  },

  /** Provider settings with the decrypted key, for this firm's own AI calls only. */
  async settingsForCalls(orgId: string, id: string, timeoutMs: number): Promise<ProviderSettings | null> {
    const [row] = await dataService.query<{ kind: FirmProviderKind; base_url: string; generation_model: string; key_ciphertext: string }>(
      { orgId },
      'firm_model_providers',
      `SELECT kind, base_url, generation_model, key_ciphertext FROM firm_model_providers
        WHERE org_id = current_setting('app.org_id')::uuid AND id = $1`,
      [id]
    );
    if (!row) return null;
    return {
      kind: row.kind,
      baseUrl: row.base_url,
      generationModel: row.generation_model,
      // Firms never supply embeddings; the platform embedding model is used.
      embeddingModel: '',
      timeoutMs,
      apiKey: openSecret(row.key_ciphertext, keyContext(orgId, id)),
    };
  },

  /** The firm provider enabled for an AI route, if any (at most one per route). */
  async forRoute(orgId: string, route: string): Promise<FirmProvider | null> {
    const [row] = await dataService.query<Row>(
      { orgId },
      'firm_model_providers',
      `SELECT ${PUBLIC_COLUMNS} FROM firm_model_providers
        WHERE org_id = current_setting('app.org_id')::uuid AND $1 = ANY (enabled_routes) AND test_status = 'passed'
        ORDER BY updated_at DESC LIMIT 1`,
      [route]
    );
    return row ? toPublic(row) : null;
  },
};
