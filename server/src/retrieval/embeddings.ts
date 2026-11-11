import { recordAiCall } from '../ai/AiMeter';
import { platformProviders } from '../ai/providers';
import { dataService } from '../services/DataService';

/**
 * Fill in chunk embeddings (F7.2 index step, used by F7.3 search). Always our platform
 * embedding model, even for firms with their own generation model, so every index in
 * the product shares one vector space. Runs in the worker; meters each batch (route "embed").
 */

/** Must match chunks.embedding vector(1024) (migration 015; bge-m3). */
export const EMBEDDING_DIMENSIONS = 1024;
const BATCH = 32;

export class EmbeddingDimensionError extends Error {}

/** Embed up to `limit` chunks of one firm that have no embedding yet. Returns how many were embedded. */
export async function embedPending(orgId: string, limit = 128): Promise<number> {
  const embeddings = platformProviders().embeddings;
  let done = 0;
  while (done < limit) {
    const rows = await dataService.query<{ id: string; project_id: string; text: string; section_path: string | null }>(
      { orgId },
      'chunks',
      'SELECT id, project_id, text, section_path FROM chunks WHERE org_id = $1 AND embedding IS NULL ORDER BY created_at LIMIT $2',
      [orgId, Math.min(BATCH, limit - done)],
    );
    if (!rows.length) break;
    // The heading travels with the text so "5.2 Tensile" passages are found by their section too.
    const inputs = rows.map((r) => (r.section_path ? `${r.section_path}\n${r.text}` : r.text));
    const started = Date.now();
    let result;
    try {
      result = await embeddings.embed(inputs);
    } catch (error) {
      await recordAiCall({
        orgId,
        projectId: rows[0].project_id,
        route: 'embed',
        provider: embeddings.kind,
        model: embeddings.embeddingModel,
        source: 'platform',
        outcome: { ok: false, error, latencyMs: Date.now() - started },
      });
      throw error;
    }
    if (result.dimensions !== EMBEDDING_DIMENSIONS) {
      throw new EmbeddingDimensionError(`${result.model} returns ${result.dimensions}-dimension vectors; the index needs ${EMBEDDING_DIMENSIONS} (bge-m3)`);
    }
    await dataService.transaction({ orgId }, async (tx) => {
      await tx.query(
        'chunks',
        `UPDATE chunks c SET embedding = v.vec::vector, embedding_model = $3
           FROM unnest($2::uuid[], $4::text[]) AS v(id, vec)
          WHERE c.id = v.id AND c.org_id = $1 AND c.embedding IS NULL`,
        [orgId, rows.map((r) => r.id), result.model, result.vectors.map((v) => `[${v.join(',')}]`)],
      );
    });
    // One metering row per batch, charged to the first chunk's project (batches are per firm, usually one project).
    await recordAiCall({
      orgId,
      projectId: rows[0].project_id,
      route: 'embed',
      provider: result.provider,
      model: result.model,
      source: 'platform',
      outcome: { ok: true, result: { usage: { inputTokens: result.usage.inputTokens, outputTokens: 0 }, latencyMs: result.latencyMs, model: result.model } },
    });
    done += rows.length;
  }
  return done;
}

/** Worker pass over all active firms. */
export async function embedPendingAll(perOrg = 128): Promise<number> {
  const orgs = await dataService.query<{ id: string }>({}, 'orgs', "SELECT id FROM orgs WHERE status = 'active' ORDER BY id");
  let total = 0;
  for (const { id } of orgs) total += await embedPending(id, perOrg);
  return total;
}
