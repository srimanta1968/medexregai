import { draftService } from '../drafting/DraftService';
import { Permission, roleHasPermission } from '../middleware/authorize';
import { problemEngine } from '../problems/ProblemEngine';
import { dataService } from '../services/DataService';
import { AppError, ErrorCodes } from '../utils/AppError';
import { citingCounts, DependentStatement, sectionsCitingFile } from './SourceGraph';

/**
 * F3.3 revision impact (UI 2.0 §5.3). When a client sends a new version of a file, list what
 * relied on the old one, each with the action that would bring it up to date:
 *
 *   draft         a section whose latest draft cites the old version   -> redraft
 *   problem       an open problem built on a fact from the old version  -> recheck
 *   request_item  a requested item for that problem or the file's section -> mark_received
 *
 * plus the facts that changed between the two versions. Nothing is changed until the
 * consultant chooses an action ("keep" records that nothing needs doing); every choice is kept.
 */

export type ImpactAction = 'redraft' | 'recheck' | 'mark_received' | 'keep';
export type ImpactKind = 'draft' | 'problem' | 'request_item';

const ALLOWED: Record<ImpactKind, ImpactAction[]> = {
  draft: ['redraft', 'keep'],
  problem: ['recheck', 'keep'],
  request_item: ['mark_received', 'keep'],
};

export interface FactChange {
  topicKey: string;
  label: string;
  before: string | null;
  after: string | null;
}

export interface ImpactItem {
  key: string;
  kind: ImpactKind;
  /** Where: the section, the problem or the request item. */
  title: string;
  /** What relied on the old version. */
  detail: string;
  /** The suggested action; any of `actions` may be chosen. */
  suggested: ImpactAction;
  actions: ImpactAction[];
  statements?: DependentStatement[];
  projectSectionId?: string;
  handled: { action: ImpactAction; by: string | null; at: string; result: Record<string, unknown> } | null;
  /** False once the item no longer depends on the old version (e.g. re-drafted); it stays listed as a record. */
  stillAffected: boolean;
}

export interface VersionRef {
  id: string;
  versionNo: number;
  createdAt: string;
}

export interface Impact {
  fileId: string;
  fileName: string;
  projectId: string;
  version: VersionRef;
  previous: VersionRef | null;
  changes: FactChange[];
  /** Passages whose text differs between the versions (removed and added), in reading order. */
  passages: { before: string | null; after: string | null }[];
  items: ImpactItem[];
}

const MAX_PASSAGE_CHANGES = 30;

export interface Revision {
  fileId: string;
  fileName: string;
  version: VersionRef;
  previousVersionNo: number;
  affectedStatements: number;
  handled: number;
}

async function must(orgId: string, userId: string, permission: Permission, what: string): Promise<void> {
  const [m] = await dataService.query<{ role: string }>(
    { orgId, userId },
    'memberships',
    `SELECT r.key AS role FROM memberships m JOIN roles r ON r.id = m.role_id WHERE m.org_id = $1 AND m.user_id = $2 AND m.status = 'active'`,
    [orgId, userId],
  );
  if (!m || !roleHasPermission(m.role, permission)) throw new AppError(403, ErrorCodes.FORBIDDEN, `Your role does not allow this action: ${what}`);
}

const fmt = (v: string | null, unit: string | null): string | null => (v === null ? null : unit ? `${v} ${unit}` : v);

export const impactService = {
  /** New versions (version 2 and later) of the project's files, newest first, with how much relied on the old one. */
  async revisions(orgId: string, projectId: string, limit = 50): Promise<Revision[]> {
    const [p] = await dataService.query<{ id: string }>({ orgId }, 'projects', 'SELECT id FROM projects WHERE id = $1 AND org_id = $2', [projectId, orgId]);
    if (!p) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
    const rows = await dataService.query<{ file_id: string; name: string; id: string; version_no: number; created_at: Date; prev_no: number; handled: string }>(
      { orgId },
      'file_versions',
      `SELECT f.id AS file_id, f.name, v.id, v.version_no, v.created_at,
              (SELECT max(o.version_no) FROM file_versions o WHERE o.file_id = v.file_id AND o.org_id = v.org_id AND o.version_no < v.version_no AND o.discarded_at IS NULL) AS prev_no,
              (SELECT count(*) FROM impact_actions a WHERE a.org_id = v.org_id AND a.new_version_id = v.id) AS handled
         FROM file_versions v JOIN files f ON f.id = v.file_id AND f.org_id = v.org_id AND f.status = 'active'
        WHERE v.org_id = $1 AND f.project_id = $2 AND v.version_no > 1 AND v.discarded_at IS NULL
        ORDER BY v.created_at DESC LIMIT $3`,
      [orgId, projectId, limit],
    );
    const counts = await citingCounts(
      orgId,
      rows.map((r) => ({ fileId: r.file_id, versionId: r.id })),
    );
    return rows
      .filter((r) => r.prev_no !== null)
      .map((r) => ({
        fileId: r.file_id,
        fileName: r.name,
        version: { id: r.id, versionNo: r.version_no, createdAt: r.created_at.toISOString() },
        previousVersionNo: r.prev_no,
        affectedStatements: counts.get(r.id) ?? 0,
        handled: Number(r.handled),
      }));
  },

  /** What a new version of a file affects. */
  async impact(orgId: string, versionId: string): Promise<Impact> {
    const [v] = await dataService.query<{ id: string; file_id: string; version_no: number; created_at: Date; name: string; project_id: string }>(
      { orgId },
      'file_versions',
      `SELECT v.id, v.file_id, v.version_no, v.created_at, f.name, f.project_id
         FROM file_versions v JOIN files f ON f.id = v.file_id AND f.org_id = v.org_id
        WHERE v.id = $1 AND v.org_id = $2`,
      [versionId, orgId],
    );
    if (!v) throw new AppError(404, ErrorCodes.NOT_FOUND, 'File version not found');
    const [prev] = await dataService.query<{ id: string; version_no: number; created_at: Date }>(
      { orgId },
      'file_versions',
      `SELECT id, version_no, created_at FROM file_versions
        WHERE org_id = $1 AND file_id = $2 AND version_no < $3 AND discarded_at IS NULL ORDER BY version_no DESC LIMIT 1`,
      [orgId, v.file_id, v.version_no],
    );
    const base: Impact = {
      fileId: v.file_id,
      fileName: v.name,
      projectId: v.project_id,
      version: { id: v.id, versionNo: v.version_no, createdAt: v.created_at.toISOString() },
      previous: prev ? { id: prev.id, versionNo: prev.version_no, createdAt: prev.created_at.toISOString() } : null,
      changes: [],
      passages: [],
      items: [],
    };
    if (!prev) return base;

    // Facts that changed between the two versions (same topic, different value; or gone / new).
    const facts = await dataService.query<{ version_id: string; topic_key: string; label: string; value: string; unit: string | null }>(
      { orgId },
      'facts',
      `SELECT DISTINCT ON (version_id, topic_key) version_id, topic_key, label, value, unit
         FROM facts WHERE org_id = $1 AND version_id = ANY($2::uuid[]) ORDER BY version_id, topic_key, created_at`,
      [orgId, [prev.id, v.id]],
    );
    const before = new Map(facts.filter((f) => f.version_id === prev.id).map((f) => [f.topic_key, f]));
    const after = new Map(facts.filter((f) => f.version_id === v.id).map((f) => [f.topic_key, f]));
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const b = before.get(key);
      const a = after.get(key);
      const bv = b ? fmt(b.value, b.unit) : null;
      const av = a ? fmt(a.value, a.unit) : null;
      if (bv !== av) base.changes.push({ topicKey: key, label: (a ?? b)!.label, before: bv, after: av });
    }
    base.changes.sort((x, y) => x.label.localeCompare(y.label));

    // Passage text that differs (not every change is a fact the extractor knows).
    const locs = await dataService.query<{ file_version_id: string; text: string }>(
      { orgId },
      'source_locations',
      'SELECT file_version_id, text FROM source_locations WHERE org_id = $1 AND file_version_id = ANY($2::uuid[]) ORDER BY file_version_id, ordinal',
      [orgId, [prev.id, v.id]],
    );
    const norm = (t: string): string => t.replace(/\s+/g, ' ').trim();
    const oldTexts = locs.filter((l) => l.file_version_id === prev.id).map((l) => norm(l.text)).filter(Boolean);
    const newTexts = locs.filter((l) => l.file_version_id === v.id).map((l) => norm(l.text)).filter(Boolean);
    const oldSet = new Set(oldTexts);
    const newSet = new Set(newTexts);
    const removed = oldTexts.filter((t) => !newSet.has(t));
    const added = newTexts.filter((t) => !oldSet.has(t));
    for (let i = 0; i < Math.max(removed.length, added.length) && base.passages.length < MAX_PASSAGE_CHANGES; i++) {
      base.passages.push({ before: removed[i] ?? null, after: added[i] ?? null });
    }

    const handled = new Map(
      (
        await dataService.query<{
          item_key: string;
          action: ImpactAction;
          actor: string | null;
          created_at: Date;
          result: Record<string, unknown>;
          item: { kind: ImpactKind; title: string; detail: string } | null;
        }>(
          { orgId },
          'impact_actions',
          `SELECT a.item_key, a.action, u.full_name AS actor, a.created_at, a.result - 'item' AS result, a.result -> 'item' AS item
             FROM impact_actions a LEFT JOIN user_profiles u ON u.user_id = a.actor_id
            WHERE a.org_id = $1 AND a.new_version_id = $2`,
          [orgId, v.id],
        )
      ).map((h) => [h.item_key, { action: h.action, by: h.actor, at: h.created_at.toISOString(), result: h.result, item: h.item }]),
    );
    const record = (key: string) => {
      const h = handled.get(key);
      return h ? { action: h.action, by: h.by, at: h.at, result: h.result } : null;
    };

    // Drafts that cite an older version of this file.
    for (const s of await sectionsCitingFile(orgId, v.file_id, v.id)) {
      const n = s.statements.length;
      base.items.push({
        key: `draft:${s.projectSectionId}`,
        kind: 'draft',
        title: `${s.title} draft`,
        detail: `${n} statement${n === 1 ? '' : 's'} in draft v${s.draftVersionNo} cite${n === 1 ? 's' : ''} ${[...new Set(s.statements.map((x) => `v${x.citedVersionNo}`))].join(', ')} of ${v.name}`,
        suggested: 'redraft',
        actions: ALLOWED.draft,
        statements: s.statements,
        projectSectionId: s.projectSectionId,
        handled: record(`draft:${s.projectSectionId}`),
        stillAffected: true,
      });
    }

    // Open problems built on a fact from an older version of this file.
    const problems = await dataService.query<{ id: string; title: string; kind: string; severity: string }>(
      { orgId },
      'problems',
      `SELECT DISTINCT p.id, p.title, p.kind, p.severity FROM problems p
         JOIN facts ft ON ft.id IN (p.fact_a_id, p.fact_b_id) AND ft.org_id = p.org_id
        WHERE p.org_id = $1 AND p.project_id = $2 AND p.status = 'open' AND p.still_present
          AND ft.file_id = $3
          AND (SELECT fv.version_no FROM file_versions fv WHERE fv.id = ft.version_id) < (SELECT nv.version_no FROM file_versions nv WHERE nv.id = $4)`,
      [orgId, v.project_id, v.file_id, v.id],
    );
    for (const p of problems) {
      base.items.push({
        key: `problem:${p.id}`,
        kind: 'problem',
        title: p.title,
        detail: `A ${p.severity} ${p.kind} found using v${prev.version_no}; the new version may change it`,
        suggested: 'recheck',
        actions: ALLOWED.problem,
        handled: record(`problem:${p.id}`),
        stillAffected: true,
      });
    }

    // Requested items this file may answer: those raised for the problems above, or for the file's section.
    const items = await dataService.query<{ id: string; label: string; request_title: string; position: number }>(
      { orgId },
      'client_request_items',
      `SELECT i.id, i.label, r.title AS request_title, i.position FROM client_request_items i
         JOIN client_requests r ON r.id = i.request_id AND r.org_id = i.org_id
        WHERE i.org_id = $1 AND r.project_id = $2 AND r.status IN ('draft', 'open') AND i.status = 'requested'
          AND (i.gap_ref = ANY($3::varchar[])
               OR i.section_id IN (SELECT a.section_id FROM file_assignments a WHERE a.org_id = $1 AND a.file_id = $4 AND a.is_current))
        ORDER BY r.title, i.position`,
      [orgId, v.project_id, problems.map((p) => `problem:${p.id}`), v.file_id],
    );
    for (const i of items) {
      base.items.push({
        key: `request_item:${i.id}`,
        kind: 'request_item',
        title: `${i.request_title}, item ${i.position}`,
        detail: i.label,
        suggested: 'mark_received',
        actions: ALLOWED.request_item,
        handled: record(`request_item:${i.id}`),
        stillAffected: true,
      });
    }
    // What was handled and no longer depends on the old version stays listed, as a record.
    for (const [key, h] of handled) {
      if (base.items.some((i) => i.key === key) || !h.item) continue;
      base.items.push({
        key,
        kind: h.item.kind,
        title: h.item.title,
        detail: h.item.detail,
        suggested: h.action,
        actions: [],
        handled: { action: h.action, by: h.by, at: h.at, result: h.result },
        stillAffected: false,
      });
    }
    return base;
  },

  /** Carry out the action the consultant chose for one item, and record it. */
  async act(orgId: string, userId: string, versionId: string, input: { itemKey: string; action: ImpactAction }): Promise<ImpactItem> {
    await must(orgId, userId, 'projects:write', 'act on a revision');
    const impact: Impact = await this.impact(orgId, versionId);
    const item = impact.items.find((i) => i.key === input.itemKey);
    if (!item) throw new AppError(404, ErrorCodes.NOT_FOUND, 'This version does not affect that item');
    if (!item.actions.includes(input.action)) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `${input.action} is not an action for this item; choose ${item.actions.join(' or ')}`, [
        { field: 'action', message: `Allowed: ${item.actions.join(', ')}` },
      ]);
    }
    const id = input.itemKey.split(':')[1];
    let result: Record<string, unknown> = {};
    if (input.action === 'redraft') {
      const d = await draftService.request(orgId, userId, item.projectSectionId!);
      result = { draftId: d.id, draftVersionNo: d.versionNo };
    } else if (input.action === 'recheck') {
      // Make sure the new version's facts are there before checking again.
      await problemEngine.extractForVersion(orgId, versionId);
      const counts = await problemEngine.detect(orgId, impact.projectId);
      const [p] = await dataService.query<{ status: string; still_present: boolean }>({ orgId }, 'problems', 'SELECT status, still_present FROM problems WHERE id = $1 AND org_id = $2', [
        id,
        orgId,
      ]);
      result = { ...counts, problemStillPresent: p ? p.still_present && p.status === 'open' : false };
    } else if (input.action === 'mark_received') {
      await dataService.query(
        { orgId, userId },
        'client_request_items',
        `UPDATE client_request_items SET status = 'received', received_at = COALESCE(received_at, now()) WHERE id = $1 AND org_id = $2`,
        [id, orgId],
      );
      result = { receivedFile: impact.fileName, versionNo: impact.version.versionNo };
    }
    await dataService.query(
      { orgId, userId },
      'impact_actions',
      `INSERT INTO impact_actions (org_id, project_id, new_version_id, item_key, action, result, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (new_version_id, item_key) DO UPDATE SET action = EXCLUDED.action, result = EXCLUDED.result, actor_id = EXCLUDED.actor_id, created_at = now()`,
      [orgId, impact.projectId, versionId, input.itemKey, input.action, JSON.stringify({ ...result, item: { kind: item.kind, title: item.title, detail: item.detail } }), userId],
    );
    const after: Impact = await this.impact(orgId, versionId);
    return after.items.find((i) => i.key === input.itemKey)!;
  },
};
