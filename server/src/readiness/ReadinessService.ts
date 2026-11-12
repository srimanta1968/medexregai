import { dataService } from '../services/DataService';
import { AppError, ErrorCodes } from '../utils/AppError';
import { EstarRules, rulesFor } from './estarRules';

/**
 * F3.4 eSTAR attachment readiness. The attachments are the project's active files filed
 * under an eSTAR section that takes evidence (their current version). Each is checked
 * against the project's eSTAR template rules (estarRules.ts): name length, size, archive
 * type; the running total is checked against the whole-eSTAR limit.
 *
 *   error    eSTAR will not accept it (FDA's stated rule)
 *   warning  probably fine but worth a look (at the limit, size unknown, likely rejected)
 */

export type Severity = 'error' | 'warning';
export type CheckCode =
  | 'NAME_TOO_LONG'
  | 'NAME_AT_LIMIT'
  | 'FILE_TOO_LARGE'
  | 'ARCHIVE_REJECTED'
  | 'ARCHIVE_LIKELY_REJECTED'
  | 'SIZE_UNKNOWN'
  | 'TOTAL_TOO_LARGE';

export interface CheckIssue {
  code: CheckCode;
  severity: Severity;
  message: string;
  /** Whose rule: FDA's (quoted on the eSTAR page) or ours (an interpretation). */
  basis: 'fda' | 'interpretation';
}

export interface AttachmentCheck {
  fileId: string;
  name: string;
  nameLength: number;
  extension: string | null;
  sizeBytes: number | null;
  sectionId: string;
  sectionTitle: string;
  /** Sum of this and every attachment before it (section order), for the 4 GB limit. */
  runningTotalBytes: number;
  issues: CheckIssue[];
}

export interface Readiness {
  projectId: string;
  template: { key: string; label: string };
  rules: Pick<EstarRules, 'maxNameChars' | 'maxAttachmentBytes' | 'maxTotalBytes' | 'rejectedExtensions' | 'source'>;
  attachments: AttachmentCheck[];
  totalBytes: number;
  totalLimitBytes: number;
  /** Share of the whole-eSTAR limit used, 0-100+. */
  totalPercent: number;
  counts: { attachments: number; errors: number; warnings: number };
  ready: boolean;
  checkedAt: string;
}

const gb = (b: number): string => `${(b / 1e9).toFixed(b >= 1e10 ? 0 : 2)} GB`;

/** Pure: check a list of attachments (in submission order) against one template's rules. */
export function checkAttachments(
  rules: EstarRules,
  files: { fileId: string; name: string; sizeBytes: number | null; sectionId: string; sectionTitle: string }[],
): { attachments: AttachmentCheck[]; totalBytes: number } {
  let running = 0;
  let totalFlagged = false;
  const attachments = files.map((f) => {
    const issues: CheckIssue[] = [];
    const nameLength = [...f.name].length;
    const dot = f.name.lastIndexOf('.');
    const extension = dot > 0 ? f.name.slice(dot + 1).toLowerCase() : null;
    if (nameLength > rules.maxNameChars) {
      issues.push({
        code: 'NAME_TOO_LONG',
        severity: 'error',
        basis: 'fda',
        message: `The name is ${nameLength} characters; eSTAR does not accept names over ${rules.maxNameChars}. Shorten it by ${nameLength - rules.maxNameChars}.`,
      });
    } else if (nameLength === rules.maxNameChars) {
      issues.push({ code: 'NAME_AT_LIMIT', severity: 'warning', basis: 'interpretation', message: `The name is exactly ${rules.maxNameChars} characters, the most eSTAR accepts.` });
    }
    if (extension && rules.rejectedExtensions.includes(extension)) {
      issues.push({ code: 'ARCHIVE_REJECTED', severity: 'error', basis: 'fda', message: `eSTAR automatically rejects .${extension} files. Unpack it and attach the files inside.` });
    } else if (extension && rules.likelyRejectedExtensions.includes(extension)) {
      issues.push({
        code: 'ARCHIVE_LIKELY_REJECTED',
        severity: 'warning',
        basis: 'interpretation',
        message: `.${extension} is an archive; FDA gives zip as an example of a rejected type, so this is likely rejected too. Unpack it.`,
      });
    }
    if (f.sizeBytes === null) {
      issues.push({ code: 'SIZE_UNKNOWN', severity: 'warning', basis: 'interpretation', message: 'The file has not been downloaded, so its size is not known.' });
    } else {
      if (f.sizeBytes > rules.maxAttachmentBytes) {
        issues.push({
          code: 'FILE_TOO_LARGE',
          severity: 'error',
          basis: 'fda',
          message: `${gb(f.sizeBytes)} is over the ${gb(rules.maxAttachmentBytes)} attachment limit. Split or compress it.`,
        });
      }
      running += f.sizeBytes;
    }
    if (!totalFlagged && running > rules.maxTotalBytes) {
      totalFlagged = true;
      issues.push({
        code: 'TOTAL_TOO_LARGE',
        severity: 'error',
        basis: 'fda',
        message: `With this file the attachments total ${gb(running)}, over the ${gb(rules.maxTotalBytes)} limit for the whole eSTAR.`,
      });
    }
    return { fileId: f.fileId, name: f.name, nameLength, extension, sizeBytes: f.sizeBytes, sectionId: f.sectionId, sectionTitle: f.sectionTitle, runningTotalBytes: running, issues };
  });
  return { attachments, totalBytes: running };
}

export const readinessService = {
  async check(orgId: string, projectId: string): Promise<Readiness> {
    const [p] = await dataService.query<{ estar_template: string }>({ orgId }, 'projects', 'SELECT estar_template FROM projects WHERE id = $1 AND org_id = $2', [projectId, orgId]);
    if (!p) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
    const rules = rulesFor(p.estar_template);
    const rows = await dataService.query<{ file_id: string; name: string; size_bytes: string | null; section_id: string; title: string }>(
      { orgId },
      'files',
      `SELECT f.id AS file_id, f.name, v.size_bytes, s.id AS section_id, s.title
         FROM files f
         JOIN file_assignments a ON a.file_id = f.id AND a.org_id = f.org_id AND a.is_current
         JOIN estar_sections s ON s.id = a.section_id AND s.takes_evidence
         -- The current version, or (before one is chosen, e.g. while it is read) the latest one.
         LEFT JOIN LATERAL (
           SELECT size_bytes FROM file_versions x
            WHERE x.file_id = f.id AND x.org_id = f.org_id AND x.discarded_at IS NULL
            ORDER BY (x.id = f.current_version_id) DESC, x.version_no DESC LIMIT 1
         ) v ON true
        WHERE f.org_id = $1 AND f.project_id = $2 AND f.status = 'active' AND a.section_id IS NOT NULL
        ORDER BY s.ordinal, f.name`,
      [orgId, projectId],
    );
    const { attachments, totalBytes } = checkAttachments(
      rules,
      rows.map((r) => ({ fileId: r.file_id, name: r.name, sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes), sectionId: r.section_id, sectionTitle: r.title })),
    );
    const all = attachments.flatMap((a) => a.issues);
    const errors = all.filter((i) => i.severity === 'error').length;
    return {
      projectId,
      template: { key: rules.key, label: rules.label },
      rules: { maxNameChars: rules.maxNameChars, maxAttachmentBytes: rules.maxAttachmentBytes, maxTotalBytes: rules.maxTotalBytes, rejectedExtensions: rules.rejectedExtensions, source: rules.source },
      attachments,
      totalBytes,
      totalLimitBytes: rules.maxTotalBytes,
      totalPercent: Math.round((totalBytes / rules.maxTotalBytes) * 1000) / 10,
      counts: { attachments: attachments.length, errors, warnings: all.length - errors },
      ready: errors === 0,
      checkedAt: new Date().toISOString(),
    };
  },

  async setTemplate(orgId: string, userId: string, projectId: string, key: string): Promise<Readiness> {
    const rows = await dataService.query<{ id: string }>(
      { orgId, userId },
      'projects',
      'UPDATE projects SET estar_template = $3, updated_at = now() WHERE id = $1 AND org_id = $2 RETURNING id',
      [projectId, orgId, key],
    );
    if (!rows.length) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
    return this.check(orgId, projectId);
  },
};
