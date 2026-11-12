import { dataService } from '../services/DataService';

/**
 * F3.3 statement -> source dependency graph (statement_sources, migration 032; edges are
 * written with each draft's statements in SectionDrafter.saveStatements).
 *
 * Only a section's LATEST ready draft counts: older versions are history, and re-drafting
 * replaces what they said.
 */

export interface DependentStatement {
  statementId: string;
  ordinal: number;
  text: string;
  /** The file version the statement cites (an older one than the new version). */
  citedVersionId: string;
  citedVersionNo: number;
  locator: string;
}

export interface DependentSection {
  projectSectionId: string;
  sectionId: string;
  title: string;
  draftId: string;
  draftVersionNo: number;
  statements: DependentStatement[];
}

/**
 * Sections whose latest ready draft cites a version of `fileId` OLDER than `newVersionId`,
 * with the statements that do. A draft already citing the new version (or a later one) is not affected.
 */
export async function sectionsCitingFile(orgId: string, fileId: string, newVersionId: string): Promise<DependentSection[]> {
  const rows = await dataService.query<{
    project_section_id: string;
    section_id: string;
    title: string;
    draft_id: string;
    draft_version_no: number;
    statement_id: string;
    ordinal: number;
    text: string;
    file_version_id: string;
    cited_version_no: number;
    locator: string;
  }>(
    { orgId },
    'statement_sources',
    `WITH latest AS (
       SELECT DISTINCT ON (d.project_section_id) d.id, d.project_section_id, d.version_no
         FROM section_drafts d
        WHERE d.org_id = $1 AND d.status = 'ready'
        ORDER BY d.project_section_id, d.version_no DESC
     )
     SELECT ps.id AS project_section_id, ps.section_id, s.title, l.id AS draft_id, l.version_no AS draft_version_no,
            st.id AS statement_id, st.ordinal, st.text, ss.file_version_id, v.version_no AS cited_version_no, ss.locator
       FROM statement_sources ss
       JOIN latest l ON l.id = ss.draft_id
       JOIN draft_statements st ON st.id = ss.statement_id AND st.org_id = ss.org_id
       JOIN file_versions v ON v.id = ss.file_version_id AND v.org_id = ss.org_id
       JOIN project_sections ps ON ps.id = l.project_section_id AND ps.org_id = ss.org_id
       JOIN estar_sections s ON s.id = ps.section_id
      WHERE ss.org_id = $1 AND ss.file_id = $2
        AND v.version_no < (SELECT nv.version_no FROM file_versions nv WHERE nv.id = $3 AND nv.org_id = $1)
      ORDER BY s.ordinal, st.ordinal`,
    [orgId, fileId, newVersionId],
  );
  const bySection = new Map<string, DependentSection>();
  for (const r of rows) {
    const sec =
      bySection.get(r.project_section_id) ??
      ({ projectSectionId: r.project_section_id, sectionId: r.section_id, title: r.title, draftId: r.draft_id, draftVersionNo: r.draft_version_no, statements: [] } as DependentSection);
    bySection.set(r.project_section_id, sec);
    // A statement citing two passages of the same old version appears once.
    if (!sec.statements.some((s) => s.statementId === r.statement_id)) {
      sec.statements.push({
        statementId: r.statement_id,
        ordinal: r.ordinal,
        text: r.text,
        citedVersionId: r.file_version_id,
        citedVersionNo: r.cited_version_no,
        locator: r.locator,
      });
    }
  }
  return [...bySection.values()];
}

/** For each new version: how many statements in latest drafts cite an older version of its file (the revisions list). */
export async function citingCounts(orgId: string, pairs: { fileId: string; versionId: string }[]): Promise<Map<string, number>> {
  if (!pairs.length) return new Map();
  const rows = await dataService.query<{ version_id: string; n: string }>(
    { orgId },
    'statement_sources',
    `WITH latest AS (
       SELECT DISTINCT ON (d.project_section_id) d.id FROM section_drafts d
        WHERE d.org_id = $1 AND d.status = 'ready' ORDER BY d.project_section_id, d.version_no DESC
     )
     SELECT want.version_id, count(DISTINCT ss.statement_id) AS n
       FROM unnest($2::uuid[], $3::uuid[]) AS want(file_id, version_id)
       JOIN file_versions nv ON nv.id = want.version_id AND nv.org_id = $1
       JOIN statement_sources ss ON ss.org_id = $1 AND ss.file_id = want.file_id
       JOIN file_versions cv ON cv.id = ss.file_version_id AND cv.org_id = $1 AND cv.version_no < nv.version_no
       JOIN latest l ON l.id = ss.draft_id
      GROUP BY want.version_id`,
    [orgId, pairs.map((p) => p.fileId), pairs.map((p) => p.versionId)],
  );
  return new Map(rows.map((r) => [r.version_id, Number(r.n)]));
}
