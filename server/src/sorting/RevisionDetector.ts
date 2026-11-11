import { createHash } from 'crypto';
import { dataService } from '../services/DataService';
import { AppError, ErrorCodes } from '../utils/AppError';

/**
 * F2.2 version and duplicate detection.
 *
 * Files in a project are grouped by their base name with revision and copy markers
 * removed ("SL-22 accelerated ageing report rev B.pdf" and "... rev A.pdf" share a
 * base). Each member's revision is read from the name, or for drawings from the
 * title block ("REV D") on the first pages. A group gets an automatic current file
 * only when exactly one member has the highest revision; otherwise (a tie, labels
 * that cannot be ordered such as "C" and "C1", or no revision at all) the group is
 * 'unclear' and the consultant is asked. Byte-identical members are duplicates. A
 * consultant's choice stands until the group's files change.
 */

export interface Revision {
  label: string;
  from: 'name' | 'title_block';
  /** Sort key; null when the label cannot be ordered against the others. */
  rank: number | null;
}

const NAME_REV = /(?:^|[\s._(-])(?:rev(?:ision)?|r)[\s._-]*([a-z]{1,2}\d{0,2}|\d{1,3})(?=$|[\s._)-])/i;
const NAME_VER = /(?:^|[\s._(-])v(?:er(?:sion)?)?[\s._-]*(\d{1,3})(?=$|[\s._)-])/i;
const TITLE_BLOCK_REV = /\bREV(?:ISION)?\s*[:.]?\s*([A-Z]{1,2}\d{0,2}|\d{1,3})\b/;

/** Letters A..Z, AA..; digits as numbers. "C1"-style labels have no safe order: rank null. */
function rankOf(label: string): number | null {
  if (/^\d+$/.test(label)) return Number(label);
  const u = label.toUpperCase();
  if (/^[A-Z]$/.test(u)) return u.charCodeAt(0) - 64;
  if (/^[A-Z]{2}$/.test(u)) return 26 * (u.charCodeAt(0) - 64) + (u.charCodeAt(1) - 64);
  return null;
}

export function revisionFromName(name: string): Revision | null {
  const stem = name.replace(/\.[a-z0-9]{1,5}$/i, '');
  const m = NAME_REV.exec(stem) ?? NAME_VER.exec(stem);
  if (!m) return null;
  return { label: m[1].toUpperCase(), from: 'name', rank: rankOf(m[1]) };
}

export function revisionFromTitleBlock(text: string): Revision | null {
  const m = TITLE_BLOCK_REV.exec(text);
  return m ? { label: m[1].toUpperCase(), from: 'title_block', rank: rankOf(m[1]) } : null;
}

/** The name with revision, version, copy and "final/draft" markers removed. */
export function baseKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/, '')
    .replace(new RegExp(NAME_REV.source, 'gi'), ' ')
    .replace(new RegExp(NAME_VER.source, 'gi'), ' ')
    .replace(/\((\d{1,2}|copy)\)|\bcopy( of)?\b|\b(final|draft|signed|clean|redline)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 300);
}

interface Member {
  id: string;
  name: string;
  sha256: string | null;
  revision: Revision | null;
}

export interface Decision {
  status: 'clear' | 'unclear';
  currentFileId: string | null;
  reason: string;
  roles: Map<string, 'current' | 'superseded' | 'duplicate' | 'candidate'>;
}

/** Pure: given a group's members, which is current, or why it is unclear. */
export function decide(members: Member[]): Decision {
  const roles = new Map<string, 'current' | 'superseded' | 'duplicate' | 'candidate'>();
  // Byte-identical copies: keep the first as the representative.
  const bySha = new Map<string, Member>();
  const distinct: Member[] = [];
  for (const m of members) {
    const rep = m.sha256 ? bySha.get(m.sha256) : undefined;
    if (rep) {
      roles.set(m.id, 'duplicate');
      continue;
    }
    if (m.sha256) bySha.set(m.sha256, m);
    distinct.push(m);
  }
  if (distinct.length === 1) {
    roles.set(distinct[0].id, 'current');
    return { status: 'clear', currentFileId: distinct[0].id, reason: 'The other files are identical copies.', roles };
  }
  const unclear = (reason: string): Decision => {
    for (const m of distinct) roles.set(m.id, 'candidate');
    return { status: 'unclear', currentFileId: null, reason, roles };
  };
  const ranked = distinct.filter((m) => m.revision?.rank !== null && m.revision?.rank !== undefined);
  if (ranked.length < distinct.length) {
    const odd = distinct.filter((m) => !ranked.includes(m));
    const labels = distinct.map((m) => (m.revision ? `rev ${m.revision.label}` : 'no revision')).join(', ');
    return unclear(
      odd.some((m) => m.revision)
        ? `Revision labels cannot be put in order (${labels}). Which is current?`
        : `Not every file shows a revision (${labels}). Which is current?`,
    );
  }
  const top = Math.max(...ranked.map((m) => m.revision!.rank!));
  const latest = ranked.filter((m) => m.revision!.rank === top);
  if (latest.length > 1) return unclear(`More than one file is rev ${latest[0].revision!.label} with different contents. Which is current?`);
  const current = latest[0];
  for (const m of distinct) roles.set(m.id, m.id === current.id ? 'current' : 'superseded');
  const older = distinct.filter((m) => m.id !== current.id).map((m) => `rev ${m.revision!.label}`);
  return {
    status: 'clear',
    currentFileId: current.id,
    reason: `rev ${current.revision!.label} (from the ${current.revision!.from === 'title_block' ? 'title block' : 'name'}) is the latest; ${older.join(', ')} superseded.`,
    roles,
  };
}

export const revisionDetector = {
  /** Work out the revision groups of one project and save them. Returns the number of unclear groups. */
  async detect(orgId: string, projectId: string): Promise<{ groups: number; unclear: number }> {
    const files = await dataService.query<{ id: string; name: string; sha256: string | null; first_text: string | null }>(
      { orgId },
      'files',
      `SELECT f.id, f.name, v.sha256,
              (SELECT string_agg(c.text, ' ') FROM (SELECT text FROM chunks WHERE file_version_id = v.id AND org_id = f.org_id ORDER BY ordinal LIMIT 2) c) AS first_text
         FROM files f
         LEFT JOIN LATERAL (SELECT id, sha256 FROM file_versions WHERE file_id = f.id AND org_id = f.org_id ORDER BY version_no DESC LIMIT 1) v ON true
        WHERE f.org_id = $1 AND f.project_id = $2 AND f.status = 'active'`,
      [orgId, projectId],
    );
    const groups = new Map<string, Member[]>();
    for (const f of files) {
      const key = baseKey(f.name);
      if (!key) continue;
      const fromName = revisionFromName(f.name);
      const revision = fromName ?? (f.first_text ? revisionFromTitleBlock(f.first_text.slice(0, 3000)) : null);
      const list = groups.get(key) ?? [];
      list.push({ id: f.id, name: f.name, sha256: f.sha256, revision });
      groups.set(key, list);
    }
    let unclear = 0;
    let saved = 0;
    await dataService.transaction({ orgId }, async (tx) => {
      const keep: string[] = [];
      for (const [key, members] of groups) {
        if (members.length < 2) continue;
        keep.push(key);
        saved++;
        members.sort((a, b) => a.id.localeCompare(b.id));
        const hash = createHash('sha256')
          .update(members.map((m) => `${m.id}:${m.sha256 ?? ''}`).join('|'))
          .digest('hex');
        const [existing] = await tx.query<{ id: string; status: string; members_hash: string }>(
          'file_revision_groups',
          'SELECT id, status, members_hash FROM file_revision_groups WHERE project_id = $1 AND org_id = $2 AND base_key = $3 FOR UPDATE',
          [projectId, orgId, key],
        );
        // A consultant's choice stands while the group's files are unchanged.
        if (existing?.status === 'confirmed' && existing.members_hash === hash) continue;
        const d = decide(members);
        if (d.status === 'unclear') unclear++;
        const [g] = await tx.query<{ id: string }>(
          'file_revision_groups',
          `INSERT INTO file_revision_groups (org_id, project_id, base_key, status, current_file_id, reason, members_hash)
           VALUES ($1, $2, $3, $4, $5, left($6, 500), $7)
           ON CONFLICT (project_id, base_key) DO UPDATE SET status = EXCLUDED.status, current_file_id = EXCLUDED.current_file_id,
             reason = EXCLUDED.reason, members_hash = EXCLUDED.members_hash, confirmed_by = NULL, confirmed_at = NULL, updated_at = now()
           RETURNING id`,
          [orgId, projectId, key, d.status, d.currentFileId, d.reason, hash],
        );
        await tx.query('file_revision_members', 'DELETE FROM file_revision_members WHERE group_id = $1 AND org_id = $2', [g.id, orgId]);
        for (const m of members) {
          await tx.query(
            'file_revision_members',
            `INSERT INTO file_revision_members (group_id, org_id, file_id, revision_label, revision_from, role) VALUES ($1, $2, $3, $4, $5, $6)`,
            [g.id, orgId, m.id, m.revision?.label ?? null, m.revision?.from ?? null, d.roles.get(m.id) ?? 'candidate'],
          );
        }
      }
      // Groups whose files were removed or renamed apart.
      await tx.query(
        'file_revision_groups',
        'DELETE FROM file_revision_groups WHERE project_id = $1 AND org_id = $2 AND NOT (base_key = ANY($3::text[]))',
        [projectId, orgId, keep],
      );
    });
    return { groups: saved, unclear };
  },

  /** The consultant says which file is current. Only a member of the group can be. */
  async confirm(orgId: string, userId: string, projectId: string, groupId: string, fileId: string): Promise<void> {
    await dataService.transaction({ orgId, userId }, async (tx) => {
      const [g] = await tx.query<{ id: string }>(
        'file_revision_groups',
        'SELECT id FROM file_revision_groups WHERE id = $1 AND project_id = $2 AND org_id = $3 FOR UPDATE',
        [groupId, projectId, orgId],
      );
      if (!g) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Version group not found');
      const members = await tx.query<{ file_id: string; role: string }>(
        'file_revision_members',
        'SELECT file_id, role FROM file_revision_members WHERE group_id = $1 AND org_id = $2',
        [groupId, orgId],
      );
      if (!members.some((m) => m.file_id === fileId)) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'That file is not one of the versions in this group', [{ field: 'fileId', message: 'Not in this group' }]);
      }
      for (const m of members) {
        const role = m.file_id === fileId ? 'current' : m.role === 'duplicate' ? 'duplicate' : 'superseded';
        await tx.query('file_revision_members', 'UPDATE file_revision_members SET role = $3 WHERE group_id = $1 AND file_id = $2', [groupId, m.file_id, role]);
      }
      await tx.query(
        'file_revision_groups',
        `UPDATE file_revision_groups SET status = 'confirmed', current_file_id = $2, reason = 'Chosen by a consultant.', confirmed_by = $3, confirmed_at = now(), updated_at = now()
          WHERE id = $1`,
        [groupId, fileId, userId],
      );
    });
  },

  /** A project's version groups, unclear ones first. */
  async list(orgId: string, projectId: string) {
    const [p] = await dataService.query<{ id: string }>({ orgId }, 'projects', 'SELECT id FROM projects WHERE id = $1 AND org_id = $2', [projectId, orgId]);
    if (!p) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
    const rows = await dataService.query<{
      id: string;
      status: 'clear' | 'unclear' | 'confirmed';
      current_file_id: string | null;
      reason: string;
      members: { fileId: string; name: string; revisionLabel: string | null; revisionFrom: string | null; role: string }[];
    }>(
      { orgId },
      'file_revision_groups',
      `SELECT g.id, g.status, g.current_file_id, g.reason,
              (SELECT json_agg(json_build_object('fileId', m.file_id, 'name', f.name, 'revisionLabel', m.revision_label, 'revisionFrom', m.revision_from, 'role', m.role)
                                ORDER BY m.revision_label NULLS FIRST, f.name)
                 FROM file_revision_members m JOIN files f ON f.id = m.file_id AND f.org_id = m.org_id WHERE m.group_id = g.id) AS members
         FROM file_revision_groups g
        WHERE g.org_id = $1 AND g.project_id = $2
        ORDER BY (g.status = 'unclear') DESC, g.updated_at DESC
        LIMIT 200`,
      [orgId, projectId],
    );
    return rows.map((r) => ({ id: r.id, status: r.status, needsDecision: r.status === 'unclear', currentFileId: r.current_file_id, reason: r.reason, members: r.members ?? [] }));
  },

  /** Worker: re-detect projects whose files changed since their groups were last worked out. */
  async detectChanged(): Promise<{ projects: number; unclear: number }> {
    const totals = { projects: 0, unclear: 0 };
    const orgs = await dataService.query<{ id: string }>({}, 'orgs', "SELECT id FROM orgs WHERE status = 'active' ORDER BY id");
    for (const { id: orgId } of orgs) {
      const projects = await dataService.query<{ project_id: string }>(
        { orgId },
        'files',
        `SELECT f.project_id FROM files f
          WHERE f.org_id = $1
          GROUP BY f.project_id
         HAVING max(f.updated_at) > COALESCE((SELECT max(g.updated_at) FROM file_revision_groups g WHERE g.project_id = f.project_id AND g.org_id = $1), 'epoch')
            AND count(*) > 1
          LIMIT 20`,
        [orgId],
      );
      for (const { project_id } of projects) {
        try {
          const r = await this.detect(orgId, project_id);
          totals.projects++;
          totals.unclear += r.unclear;
        } catch (err) {
          console.warn(`[versions] project ${project_id}: ${(err as Error).message}`);
        }
      }
    }
    return totals;
  },
};
