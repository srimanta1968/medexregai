import { dataService, Tx } from '../services/DataService';
import { AppError, ErrorCodes } from '../utils/AppError';
import { decodeCursor, Page, pageSize, toPage } from '../utils/pagination';

/**
 * F3.6 firm style sources: a firm's own section templates and its library of past wording.
 *
 * - Opt-in: nothing here reaches drafting until the firm turns style sources on, and each
 *   template or precedent can be turned off on its own.
 * - Isolated: every query filters on the caller's org_id; there is no cross-firm read.
 * - Style only: templates and precedents shape order and wording. Facts in a draft still
 *   come from client files and pass the citation gate (F3.2).
 * - Read at claim time: `forDrafting` is called when a draft is claimed, so turning a
 *   source off keeps it out of every draft started afterwards (well within an hour).
 */

export interface Ctx {
  orgId: string;
  userId: string;
}

export interface StyleSettings {
  enabled: boolean;
  updatedAt: string | null;
  updatedByName: string | null;
}

export interface FirmTemplate {
  id: string;
  sectionId: string;
  sectionTitle: string;
  name: string;
  body: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Precedent {
  id: string;
  sectionId: string;
  sectionTitle: string;
  sourceLabel: string;
  text: string;
  enabled: boolean;
  createdAt: string;
}

/** What drafting may use for one section, after both opt-in flags. */
export interface DraftingStyle {
  template: { id: string; name: string; body: string } | null;
  precedents: { id: string; sourceLabel: string; text: string }[];
}

/** One entry of section_drafts.style_sources. */
export interface StyleSourceRef {
  kind: 'template' | 'precedent';
  id: string;
  label: string;
}

interface TemplateRow {
  id: string;
  section_id: string;
  section_title: string;
  name: string;
  body: string;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

interface PrecedentRow {
  id: string;
  section_id: string;
  section_title: string;
  source_label: string;
  text: string;
  enabled: boolean;
  created_at: Date;
}

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

const toTemplate = (r: TemplateRow): FirmTemplate => ({
  id: r.id,
  sectionId: r.section_id,
  sectionTitle: r.section_title,
  name: r.name,
  body: r.body,
  enabled: r.enabled,
  createdAt: new Date(r.created_at).toISOString(),
  updatedAt: new Date(r.updated_at).toISOString(),
});

const toPrecedent = (r: PrecedentRow): Precedent => ({
  id: r.id,
  sectionId: r.section_id,
  sectionTitle: r.section_title,
  sourceLabel: r.source_label,
  text: r.text,
  enabled: r.enabled,
  createdAt: new Date(r.created_at).toISOString(),
});

/** Precedents offered to one draft: enough to show the firm's voice, few enough to stay style. */
export const PRECEDENTS_PER_DRAFT = 3;

const TEMPLATE_COLS = `t.id, t.section_id, s.title AS section_title, t.name, t.body, t.enabled, t.created_at, t.updated_at`;
const PRECEDENT_COLS = `p.id, p.section_id, s.title AS section_title, p.source_label, p.text, p.enabled, p.created_at`;

/** A unique or foreign-key violation is the caller's mistake, not a server error. */
async function guarded<T>(tx: Tx, table: Parameters<Tx['query']>[0], work: () => Promise<T>): Promise<T> {
  await tx.query(table, 'SAVEPOINT style_write');
  try {
    return await work();
  } catch (err) {
    await tx.query(table, 'ROLLBACK TO SAVEPOINT style_write');
    const code = (err as { code?: string }).code;
    if (code === '23505') throw new AppError(409, ErrorCodes.TEMPLATE_EXISTS, 'This firm already has a template for that section');
    if (code === '23503') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'sectionId is not an eSTAR section');
    throw err;
  }
}

export const styleSourceService = {
  async settings(orgId: string): Promise<StyleSettings> {
    const [row] = await dataService.query<{ style_sources_enabled: boolean; style_sources_updated_at: Date | null; updated_by_name: string | null }>(
      { orgId },
      'orgs',
      `SELECT o.style_sources_enabled, o.style_sources_updated_at, p.full_name AS updated_by_name
         FROM orgs o LEFT JOIN user_profiles p ON p.user_id = o.style_sources_updated_by
        WHERE o.id = $1`,
      [orgId],
    );
    if (!row) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Firm not found');
    return { enabled: row.style_sources_enabled, updatedAt: iso(row.style_sources_updated_at), updatedByName: row.updated_by_name };
  },

  async setEnabled(ctx: Ctx, enabled: boolean): Promise<StyleSettings> {
    await dataService.query(
      ctx,
      'orgs',
      `UPDATE orgs SET style_sources_enabled = $2, style_sources_updated_at = now(), style_sources_updated_by = $3, updated_at = now() WHERE id = $1`,
      [ctx.orgId, enabled, ctx.userId],
    );
    return this.settings(ctx.orgId);
  },

  // --- templates -------------------------------------------------------------------------

  async listTemplates(orgId: string, opts: { limit?: number; cursor?: string }): Promise<Page<FirmTemplate>> {
    const size = pageSize(opts.limit);
    const after = decodeCursor(opts.cursor);
    const rows = await dataService.query<TemplateRow>(
      { orgId },
      'firm_templates',
      `SELECT ${TEMPLATE_COLS} FROM firm_templates t JOIN estar_sections s ON s.id = t.section_id
        WHERE t.org_id = $1 AND ($2::timestamptz IS NULL OR (t.created_at, t.id) < ($2::timestamptz, $3::uuid))
        ORDER BY t.created_at DESC, t.id DESC LIMIT $4`,
      [orgId, after.createdAt, after.id, size + 1],
    );
    return toPage(rows, size, toTemplate);
  },

  async getTemplate(orgId: string, id: string): Promise<FirmTemplate> {
    const [row] = await dataService.query<TemplateRow>(
      { orgId },
      'firm_templates',
      `SELECT ${TEMPLATE_COLS} FROM firm_templates t JOIN estar_sections s ON s.id = t.section_id WHERE t.id = $1 AND t.org_id = $2`,
      [id, orgId],
    );
    if (!row) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Template not found');
    return toTemplate(row);
  },

  async createTemplate(ctx: Ctx, input: { sectionId: string; name: string; body: string; enabled?: boolean }): Promise<FirmTemplate> {
    const id = await dataService.transaction(ctx, (tx) =>
      guarded(tx, 'firm_templates', async () => {
        const [row] = await tx.query<{ id: string }>(
          'firm_templates',
          `INSERT INTO firm_templates (org_id, section_id, name, body, enabled, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id`,
          [ctx.orgId, input.sectionId, input.name, input.body, input.enabled ?? true, ctx.userId],
        );
        return row.id;
      }),
    );
    return this.getTemplate(ctx.orgId, id);
  },

  async updateTemplate(ctx: Ctx, id: string, input: { name?: string; body?: string; enabled?: boolean }): Promise<FirmTemplate> {
    const [row] = await dataService.query<{ id: string }>(
      ctx,
      'firm_templates',
      `UPDATE firm_templates SET name = COALESCE($3, name), body = COALESCE($4, body), enabled = COALESCE($5, enabled),
              updated_by = $6, updated_at = now()
        WHERE id = $1 AND org_id = $2 RETURNING id`,
      [id, ctx.orgId, input.name ?? null, input.body ?? null, input.enabled ?? null, ctx.userId],
    );
    if (!row) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Template not found');
    return this.getTemplate(ctx.orgId, id);
  },

  async deleteTemplate(ctx: Ctx, id: string): Promise<void> {
    const [row] = await dataService.query<{ id: string }>(ctx, 'firm_templates', 'DELETE FROM firm_templates WHERE id = $1 AND org_id = $2 RETURNING id', [id, ctx.orgId]);
    if (!row) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Template not found');
  },

  // --- precedents ------------------------------------------------------------------------

  async listPrecedents(orgId: string, opts: { sectionId?: string; limit?: number; cursor?: string }): Promise<Page<Precedent>> {
    const size = pageSize(opts.limit);
    const after = decodeCursor(opts.cursor);
    const rows = await dataService.query<PrecedentRow>(
      { orgId },
      'firm_precedents',
      `SELECT ${PRECEDENT_COLS} FROM firm_precedents p JOIN estar_sections s ON s.id = p.section_id
        WHERE p.org_id = $1 AND ($2::text IS NULL OR p.section_id = $2)
          AND ($3::timestamptz IS NULL OR (p.created_at, p.id) < ($3::timestamptz, $4::uuid))
        ORDER BY p.created_at DESC, p.id DESC LIMIT $5`,
      [orgId, opts.sectionId ?? null, after.createdAt, after.id, size + 1],
    );
    return toPage(rows, size, toPrecedent);
  },

  async getPrecedent(orgId: string, id: string): Promise<Precedent> {
    const [row] = await dataService.query<PrecedentRow>(
      { orgId },
      'firm_precedents',
      `SELECT ${PRECEDENT_COLS} FROM firm_precedents p JOIN estar_sections s ON s.id = p.section_id WHERE p.id = $1 AND p.org_id = $2`,
      [id, orgId],
    );
    if (!row) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Precedent not found');
    return toPrecedent(row);
  },

  async createPrecedent(ctx: Ctx, input: { sectionId: string; sourceLabel: string; text: string; enabled?: boolean }): Promise<Precedent> {
    const id = await dataService.transaction(ctx, (tx) =>
      guarded(tx, 'firm_precedents', async () => {
        const [row] = await tx.query<{ id: string }>(
          'firm_precedents',
          `INSERT INTO firm_precedents (org_id, section_id, source_label, text, enabled, created_by)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [ctx.orgId, input.sectionId, input.sourceLabel, input.text, input.enabled ?? true, ctx.userId],
        );
        return row.id;
      }),
    );
    return this.getPrecedent(ctx.orgId, id);
  },

  async updatePrecedent(ctx: Ctx, id: string, input: { sourceLabel?: string; text?: string; enabled?: boolean }): Promise<Precedent> {
    const [row] = await dataService.query<{ id: string }>(
      ctx,
      'firm_precedents',
      `UPDATE firm_precedents SET source_label = COALESCE($3, source_label), text = COALESCE($4, text), enabled = COALESCE($5, enabled), updated_at = now()
        WHERE id = $1 AND org_id = $2 RETURNING id`,
      [id, ctx.orgId, input.sourceLabel ?? null, input.text ?? null, input.enabled ?? null],
    );
    if (!row) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Precedent not found');
    return this.getPrecedent(ctx.orgId, id);
  },

  async deletePrecedent(ctx: Ctx, id: string): Promise<void> {
    const [row] = await dataService.query<{ id: string }>(ctx, 'firm_precedents', 'DELETE FROM firm_precedents WHERE id = $1 AND org_id = $2 RETURNING id', [id, ctx.orgId]);
    if (!row) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Precedent not found');
  },

  // --- drafting --------------------------------------------------------------------------

  /**
   * The template and the closest past wording drafting may use for one section of one firm,
   * or nothing when the firm has style sources off. `query` ranks precedents (section title
   * and device name); with no match the newest ones are used.
   */
  async forDrafting(orgId: string, sectionId: string, query: string): Promise<DraftingStyle> {
    const none: DraftingStyle = { template: null, precedents: [] };
    const [org] = await dataService.query<{ style_sources_enabled: boolean }>({ orgId }, 'orgs', 'SELECT style_sources_enabled FROM orgs WHERE id = $1', [orgId]);
    if (!org?.style_sources_enabled) return none;
    const [template] = await dataService.query<{ id: string; name: string; body: string }>(
      { orgId },
      'firm_templates',
      'SELECT id, name, body FROM firm_templates WHERE org_id = $1 AND section_id = $2 AND enabled',
      [orgId, sectionId],
    );
    const precedents = await dataService.query<{ id: string; source_label: string; text: string }>(
      { orgId },
      'firm_precedents',
      `SELECT id, source_label, text FROM firm_precedents
        WHERE org_id = $1 AND section_id = $2 AND enabled
        ORDER BY ts_rank(tsv, plainto_tsquery('english', $3)) DESC, created_at DESC, id
        LIMIT $4`,
      [orgId, sectionId, query, PRECEDENTS_PER_DRAFT],
    );
    return {
      template: template ?? null,
      precedents: precedents.map((p) => ({ id: p.id, sourceLabel: p.source_label, text: p.text })),
    };
  },
};

/** The entries recorded on a draft for the style it was written with. */
export function styleRefs(style: DraftingStyle): StyleSourceRef[] {
  return [
    ...(style.template ? [{ kind: 'template' as const, id: style.template.id, label: style.template.name }] : []),
    ...style.precedents.map((p) => ({ kind: 'precedent' as const, id: p.id, label: p.sourceLabel })),
  ];
}
