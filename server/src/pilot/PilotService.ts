import { createHash } from 'crypto';
import { projectHeader } from '../records/RecordService';
import { dataService } from '../services/DataService';
import { AppError, ErrorCodes } from '../utils/AppError';

/**
 * F4.2 pilot report: does the product save the firm time, and do consultants keep what it
 * drafts? Measured as PRD v2.0 §12 defines it:
 *  - whole-project consultant hours against the firm's own baseline (G3', target ≥ 25% lower),
 *    from FR-14.20 time capture (finished entries on the project) and pilot_baselines;
 *  - hours on drafted sections, the write + tabulate + reconcile codes (G2', target ≥ 30% lower);
 *  - statements accepted without material change (G2', target ≥ 70%), from the Word re-import:
 *    of the model-drafted statements in the version a consultant exported, how many came back
 *    unchanged. Any edit counts as a change (the diff cannot tell a material edit from a
 *    small one), so the rate is a floor.
 * Targets are the PRD's proposed targets, shown as such; the report states facts, the firm judges.
 */

export const DRAFTED_SECTION_CODES = ['write', 'tabulate', 'reconcile'];
export const TARGETS = { wholeProjectReduction: 0.25, draftedSectionsReduction: 0.3, acceptanceRate: 0.7 };

export interface Ctx {
  orgId: string;
  userId: string;
}

export interface BaselineRow {
  code: string;
  label: string;
  hours: number | null;
}

export interface Baseline {
  basis: string | null;
  updatedAt: string | null;
  updatedByName: string | null;
  activities: BaselineRow[];
  totalHours: number;
  complete: boolean;
}

export interface HoursRow {
  code: string;
  label: string;
  actualHours: number;
  baselineHours: number | null;
  /** (baseline - actual) / baseline; null without a baseline for the activity. */
  reduction: number | null;
}

export interface Comparison {
  actualHours: number;
  baselineHours: number | null;
  reduction: number | null;
  target: number;
  /** null when there is no baseline to compare with. */
  metTarget: boolean | null;
}

export interface Acceptance {
  sectionsReimported: number;
  draftedStatements: number;
  unchanged: number;
  edited: number;
  deleted: number;
  /** unchanged / drafted statements; null before any re-import. */
  rate: number | null;
  target: number;
  metTarget: boolean | null;
}

export interface PilotReport {
  projectId: string;
  projectName: string;
  clientName: string;
  deviceName: string;
  generatedAt: string;
  baseline: { basis: string | null; complete: boolean; totalHours: number };
  byActivity: HoursRow[];
  wholeProject: Comparison;
  draftedSections: Comparison;
  acceptance: Acceptance;
  timeEntries: number;
  people: number;
  signoffs: Signoff[];
  /** SHA-256 of the numbers above (not the timestamps), for sign-off records. */
  sha256: string;
}

export interface Signoff {
  id: string;
  signerName: string;
  signerTitle: string;
  note: string | null;
  signedAt: string;
  reportSha256: string;
  /** False when the numbers changed after this sign-off. */
  current: boolean;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const reductionOf = (baseline: number | null, actual: number): number | null => (baseline && baseline > 0 ? round2((baseline - actual) / baseline) : null);

function compare(actual: number, baseline: number | null, target: number): Comparison {
  const reduction = reductionOf(baseline, actual);
  return { actualHours: round2(actual), baselineHours: baseline === null ? null : round2(baseline), reduction, target, metTarget: reduction === null ? null : reduction >= target };
}

export const pilotService = {
  async baseline(orgId: string): Promise<Baseline> {
    const rows = await dataService.query<{ code: string; label: string; hours: string | null; basis: string | null; updated_at: Date | null; updated_by_name: string | null }>(
      { orgId },
      'pilot_baselines',
      `SELECT a.code, a.label, b.hours, b.basis, b.updated_at, p.full_name AS updated_by_name
         FROM time_activities a
         LEFT JOIN pilot_baselines b ON b.activity_code = a.code AND b.org_id = $1
         LEFT JOIN user_profiles p ON p.user_id = b.updated_by
        ORDER BY a.ordinal`,
      [orgId],
    );
    const latest = rows.filter((r) => r.updated_at).sort((a, b) => +new Date(b.updated_at!) - +new Date(a.updated_at!))[0];
    const activities = rows.map((r) => ({ code: r.code, label: r.label, hours: r.hours === null ? null : Number(r.hours) }));
    return {
      basis: latest?.basis ?? null,
      updatedAt: latest?.updated_at ? new Date(latest.updated_at).toISOString() : null,
      updatedByName: latest?.updated_by_name ?? null,
      activities,
      totalHours: round2(activities.reduce((s, a) => s + (a.hours ?? 0), 0)),
      complete: activities.every((a) => a.hours !== null),
    };
  },

  /** Replace the firm's baseline: hours per activity code (missing codes are cleared). */
  async setBaseline(ctx: Ctx, input: { basis?: string | null; hours: Record<string, number> }): Promise<Baseline> {
    const codes = (await dataService.query<{ code: string }>({}, 'time_activities', 'SELECT code FROM time_activities')).map((r) => r.code);
    const unknown = Object.keys(input.hours).filter((c) => !codes.includes(c));
    if (unknown.length) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `Not activity codes: ${unknown.join(', ')}`, unknown.map((c) => ({ field: `hours.${c}`, message: 'Unknown activity code' })));
    }
    await dataService.transaction(ctx, async (tx) => {
      await tx.query('pilot_baselines', 'DELETE FROM pilot_baselines WHERE org_id = $1', [ctx.orgId]);
      const entries = Object.entries(input.hours);
      if (entries.length) {
        await tx.query(
          'pilot_baselines',
          `INSERT INTO pilot_baselines (org_id, activity_code, hours, basis, updated_by)
           SELECT $1, h.code, h.hours, $3, $4 FROM jsonb_to_recordset($2::jsonb) AS h(code varchar, hours numeric)`,
          [ctx.orgId, JSON.stringify(entries.map(([code, hours]) => ({ code, hours }))), input.basis ?? null, ctx.userId],
        );
      }
    });
    return this.baseline(ctx.orgId);
  },

  /** Of the model-drafted statements in each re-imported version, how many came back unchanged. */
  async acceptance(orgId: string, projectId: string): Promise<Acceptance> {
    const [r] = await dataService.query<{ sections: number; drafted: number; unchanged: number; edited: number }>(
      { orgId },
      'section_drafts',
      `WITH latest_import AS (
         SELECT DISTINCT ON (d.project_section_id) d.id, d.based_on_draft_id
           FROM section_drafts d JOIN project_sections ps ON ps.id = d.project_section_id AND ps.org_id = d.org_id
          WHERE d.org_id = $1 AND ps.project_id = $2 AND d.origin = 'imported' AND d.status = 'ready' AND d.based_on_draft_id IS NOT NULL
          ORDER BY d.project_section_id, d.version_no DESC),
       base AS (
         SELECT li.id AS import_id, b.id AS statement_id
           FROM latest_import li JOIN draft_statements b ON b.draft_id = li.based_on_draft_id AND b.org_id = $1
          WHERE b.kind = 'statement' AND b.origin = 'generated'),
       successor AS (
         SELECT base.statement_id, s.origin
           FROM base JOIN draft_statements s ON s.draft_id = base.import_id AND s.org_id = $1 AND s.source_statement_id = base.statement_id)
       SELECT (SELECT count(*) FROM latest_import)::int AS sections,
              (SELECT count(*) FROM base)::int AS drafted,
              (SELECT count(*) FROM successor WHERE origin = 'generated')::int AS unchanged,
              (SELECT count(*) FROM successor WHERE origin <> 'generated')::int AS edited`,
      [orgId, projectId],
    );
    const drafted = Number(r.drafted);
    const unchanged = Number(r.unchanged);
    const edited = Number(r.edited);
    const rate = drafted ? round2(unchanged / drafted) : null;
    return {
      sectionsReimported: Number(r.sections),
      draftedStatements: drafted,
      unchanged,
      edited,
      deleted: drafted - unchanged - edited,
      rate,
      target: TARGETS.acceptanceRate,
      metTarget: rate === null ? null : rate >= TARGETS.acceptanceRate,
    };
  },

  async report(orgId: string, projectId: string): Promise<PilotReport> {
    const h = await projectHeader(orgId, projectId);
    const baseline: Baseline = await this.baseline(orgId);
    const actual = await dataService.query<{ code: string; seconds: number; entries: number; people: number }>(
      { orgId },
      'time_entries',
      `SELECT activity_code AS code, sum(floor(extract(epoch FROM (ended_at - started_at))))::int AS seconds,
              count(*)::int AS entries, count(DISTINCT user_id)::int AS people
         FROM time_entries WHERE org_id = $1 AND project_id = $2 AND ended_at IS NOT NULL GROUP BY activity_code`,
      [orgId, projectId],
    );
    const [{ people }] = await dataService.query<{ people: number }>(
      { orgId },
      'time_entries',
      'SELECT count(DISTINCT user_id)::int AS people FROM time_entries WHERE org_id = $1 AND project_id = $2 AND ended_at IS NOT NULL',
      [orgId, projectId],
    );
    const hoursOf = (code: string) => (actual.find((a) => a.code === code)?.seconds ?? 0) / 3600;
    const byActivity: HoursRow[] = baseline.activities.map((a) => ({
      code: a.code,
      label: a.label,
      actualHours: round2(hoursOf(a.code)),
      baselineHours: a.hours,
      reduction: reductionOf(a.hours, hoursOf(a.code)),
    }));
    const sum = (rows: HoursRow[], pick: (r: HoursRow) => number | null): number | null =>
      rows.some((r) => pick(r) === null) ? null : rows.reduce((s, r) => s + (pick(r) ?? 0), 0);
    const drafted = byActivity.filter((r) => DRAFTED_SECTION_CODES.includes(r.code));
    const wholeBaseline = baseline.totalHours > 0 ? baseline.totalHours : null;
    const acceptance: Acceptance = await this.acceptance(orgId, projectId);
    const numbers = {
      projectId,
      baseline: { basis: baseline.basis, complete: baseline.complete, totalHours: baseline.totalHours },
      byActivity,
      wholeProject: compare(byActivity.reduce((s, r) => s + r.actualHours, 0), wholeBaseline, TARGETS.wholeProjectReduction),
      draftedSections: compare(drafted.reduce((s, r) => s + r.actualHours, 0), sum(drafted, (r) => r.baselineHours), TARGETS.draftedSectionsReduction),
      acceptance,
      timeEntries: actual.reduce((s, a) => s + Number(a.entries), 0),
      people: Number(people),
    };
    const sha256 = createHash('sha256').update(JSON.stringify(numbers)).digest('hex');
    const signoffs = await dataService.query<{ id: string; signer_name: string; signer_title: string; note: string | null; signed_at: Date; report_sha256: string }>(
      { orgId },
      'pilot_signoffs',
      `SELECT id, signer_name, signer_title, note, signed_at, report_sha256 FROM pilot_signoffs
        WHERE org_id = $1 AND project_id = $2 ORDER BY signed_at DESC LIMIT 20`,
      [orgId, projectId],
    );
    return {
      ...numbers,
      projectName: h.projectName,
      clientName: h.clientName,
      deviceName: h.deviceName,
      generatedAt: new Date().toISOString(),
      signoffs: signoffs.map((s) => ({
        id: s.id,
        signerName: s.signer_name,
        signerTitle: s.signer_title,
        note: s.note,
        signedAt: new Date(s.signed_at).toISOString(),
        reportSha256: s.report_sha256,
        current: s.report_sha256 === sha256,
      })),
      sha256,
    };
  },
};
