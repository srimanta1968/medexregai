import { createHash } from 'crypto';
import { dataService } from '../services/DataService';
import { disagree, extractFacts } from './factRules';
import { contradictionSeverity, gapSeverity } from './severity';

/**
 * F2.3 problems: contradictions between the client's documents and gaps in the evidence.
 *
 * Facts are extracted by rule from each version's passages (factRules.ts) and compared
 * deterministically after normalisation (units converted): a topic with two different
 * values across the project's CURRENT files is a contradiction (superseded revisions and
 * identical copies are left out). No AI model is used here: every extracted topic is a
 * structured value; free-text comparison with the guarded "contradiction" route is not
 * wired in yet.
 *
 * Gaps: an eSTAR section every 510(k) needs with no evidence, or a conditional section
 * that a document triggers ("supplied sterile", software, wireless, patient contact...)
 * with no evidence, quoting the trigger.
 *
 * A problem is matched on re-runs by its fingerprint (topic, files, values), so the
 * consultant's decision stands: a resolved contradiction comes back only when a file
 * changes the values involved (new fingerprint). Problems whose cause went away are kept
 * with still_present = false.
 */

const CORE_SECTIONS = ['device_description', 'indications_for_use', 'predicates_se', 'labeling', 'performance_testing'];

/** Conditional sections and what in a document makes them needed. */
const TRIGGERS: { sectionId: string; re: RegExp; why: string }[] = [
  { sectionId: 'sterility', re: /\b(?:supplied|provided|delivered|packaged)\s+sterile\b|\bsterile\s+(?:single[\s-]use|device|product)\b/i, why: 'the device is supplied sterile' },
  { sectionId: 'shelf_life', re: /\b(?:supplied|provided)\s+sterile\b|\bexpir(?:y|ation)\s+date\b|\bshelf[\s-]*life\b/i, why: 'the device has an expiry or is sterile' },
  {
    sectionId: 'biocompatibility',
    re: /\bpatient[\s-]contact(?:ing)?\b|\bcontact with (?:the )?(?:patient|skin|blood|tissue|mucosa)\b|\bimplant(?:able|ed)?\b|\bblood path\b|\bcatheter\b|\bneedle\b/i,
    why: 'the device contacts the patient',
  },
  { sectionId: 'software', re: /(?<!\b(?:no|without)\s)\b(?:software|firmware)\b/i, why: 'the device has software or firmware' },
  { sectionId: 'cybersecurity', re: /\b(?:wireless|bluetooth|wi-?fi|network(?:ed)?|cloud|internet|usb)\b/i, why: 'the device connects to other devices or networks' },
  {
    sectionId: 'emc_safety',
    re: /(?<!\bno\s)\b(?:battery|batteries|mains[\s-]powered|electrically powered|power supply|AC adapter|electrical)\b/i,
    why: 'the device is electrically powered',
  },
  { sectionId: 'reprocessing', re: /\breusable\b|\breprocess(?:ed|ing)?\b/i, why: 'the device is reusable' },
];

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

const snippet = (text: string, re: RegExp): string => {
  const m = re.exec(text);
  if (!m) return '';
  const start = Math.max(0, m.index - 80);
  return text.slice(start, m.index + m[0].length + 80).replace(/\s+/g, ' ').trim().slice(0, 240);
};

interface CurrentFact {
  id: string;
  file_id: string;
  file_name: string;
  section_id: string | null;
  topic_key: string;
  label: string;
  value: string;
  value_num: string | null;
}

export const problemEngine = {
  /** Extract the facts of one version (replacing any earlier extraction of it). */
  async extractForVersion(orgId: string, versionId: string): Promise<number> {
    const chunks = await dataService.query<{ id: string; text: string; start_location_id: string; file_id: string; project_id: string }>(
      { orgId },
      'chunks',
      `SELECT c.id, c.text, c.start_location_id, v.file_id, c.project_id
         FROM chunks c JOIN file_versions v ON v.id = c.file_version_id AND v.org_id = c.org_id
        WHERE c.file_version_id = $1 AND c.org_id = current_setting('app.org_id')::uuid ORDER BY c.ordinal`,
      [versionId],
    );
    let n = 0;
    await dataService.transaction({ orgId }, async (tx) => {
      await tx.query('facts', 'DELETE FROM facts WHERE version_id = $1 AND org_id = $2', [versionId, orgId]);
      for (const c of chunks) {
        for (const f of extractFacts(c.text)) {
          await tx.query(
            'facts',
            `INSERT INTO facts (org_id, project_id, file_id, version_id, chunk_id, location_id, kind, topic_key, label, value, unit, value_num, base_unit, quote, extracted_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, left($8, 120), left($9, 120), left($10, 200), $11, $12, $13, left($14, 300), 'rules')`,
            [orgId, c.project_id, c.file_id, versionId, c.id, c.start_location_id, f.kind, f.topicKey, f.label, f.value, f.unit, f.valueNum, f.baseUnit, f.quote],
          );
          n++;
        }
      }
    });
    return n;
  },

  /** Work out the project's contradictions and gaps and save them. */
  async detect(orgId: string, projectId: string): Promise<{ contradictions: number; gaps: number }> {
    const [{ files }] = await dataService.query<{ files: string }>(
      { orgId },
      'files',
      "SELECT count(*) AS files FROM files WHERE org_id = $1 AND project_id = $2 AND status = 'active'",
      [orgId, projectId],
    );
    const found: { fingerprint: string; row: unknown[] }[] = [];

    // Contradictions: facts of current, non-superseded files only.
    const facts = await dataService.query<CurrentFact>(
      { orgId },
      'facts',
      `SELECT ft.id, ft.file_id, fl.name AS file_name, a.section_id, ft.topic_key, ft.label, ft.value, ft.value_num
         FROM facts ft
         JOIN files fl ON fl.id = ft.file_id AND fl.org_id = ft.org_id AND fl.current_version_id = ft.version_id AND fl.status = 'active'
         LEFT JOIN file_assignments a ON a.file_id = fl.id AND a.org_id = fl.org_id AND a.is_current
        WHERE ft.org_id = $1 AND ft.project_id = $2
          AND NOT EXISTS (SELECT 1 FROM file_revision_members m WHERE m.file_id = fl.id AND m.role IN ('superseded', 'duplicate'))
        ORDER BY ft.topic_key, (a.section_id = 'labeling') DESC NULLS LAST, ft.created_at`,
      [orgId, projectId],
    );
    const byTopic = new Map<string, CurrentFact[]>();
    for (const f of facts) byTopic.set(f.topic_key, [...(byTopic.get(f.topic_key) ?? []), f]);
    for (const [topic, list] of byTopic) {
      const a = list[0];
      const valueOf = (f: CurrentFact) => ({ valueNum: f.value_num === null ? null : Number(f.value_num), value: f.value });
      const b = list.find((f) => f.file_id !== a.file_id && disagree(valueOf(a), valueOf(f)));
      if (!b) continue;
      const sev = contradictionSeverity(topic, { sectionId: a.section_id, ...valueOf(a) }, { sectionId: b.section_id, ...valueOf(b) });
      const values = [a.value, b.value].map((v) => v.toLowerCase()).sort();
      const fp = sha(`contradiction|${topic}|${[a.file_id, b.file_id].sort().join(',')}|${values.join('|')}`);
      found.push({
        fingerprint: fp,
        row: [
          'contradiction',
          topic,
          `${a.label}: ${a.file_name} says ${a.value}, ${b.file_name} says ${b.value}`,
          `${list.length} statements about ${topic} in this project's current files.`,
          sev.severity,
          sev.reason,
          a.id,
          b.id,
          null,
        ],
      });
    }

    // Gaps (only once the project has files to judge).
    if (Number(files) > 0) {
      const [p] = await dataService.query<{ submission_type: string }>({ orgId }, 'projects', 'SELECT submission_type FROM projects WHERE id = $1 AND org_id = $2', [
        projectId,
        orgId,
      ]);
      const counts = await dataService.query<{ id: string; title: string; n: string }>(
        { orgId },
        'file_assignments',
        `SELECT s.id, s.title,
                (SELECT count(*) FROM file_assignments a JOIN files f ON f.id = a.file_id AND f.org_id = a.org_id AND f.status = 'active'
                  WHERE a.org_id = $1 AND a.project_id = $2 AND a.is_current AND a.section_id = s.id) AS n
           FROM estar_sections s WHERE s.takes_evidence AND (s.applies_to = 'all' OR $3 = 'special')`,
        [orgId, projectId, p.submission_type],
      );
      const empty = new Map(counts.filter((c) => Number(c.n) === 0).map((c) => [c.id, c.title]));
      for (const id of CORE_SECTIONS) {
        if (!empty.has(id)) continue;
        const sev = gapSeverity(id, false);
        found.push({ fingerprint: sha(`gap|${id}`), row: ['gap', id, `No evidence for ${empty.get(id)}`, null, sev.severity, sev.reason, null, null, id] });
      }
      // Conditional sections: find the first passage (current files) that triggers each one.
      // Matched here, not in SQL: the triggers use JavaScript regex features (\b, look-behind).
      const wanted = TRIGGERS.filter((t) => empty.has(t.sectionId));
      const hits = new Map<string, { text: string; name: string }>();
      for (let offset = 0; wanted.some((t) => !hits.has(t.sectionId)); offset += 500) {
        const batch = await dataService.query<{ text: string; name: string }>(
          { orgId },
          'chunks',
          `SELECT c.text, f.name FROM chunks c
             JOIN files f ON f.current_version_id = c.file_version_id AND f.org_id = c.org_id AND f.status = 'active'
            WHERE c.org_id = $1 AND c.project_id = $2 ORDER BY c.id LIMIT 500 OFFSET $3`,
          [orgId, projectId, offset],
        );
        for (const c of batch) for (const t of wanted) if (!hits.has(t.sectionId) && t.re.test(c.text)) hits.set(t.sectionId, c);
        if (batch.length < 500) break;
      }
      for (const t of wanted) {
        const hit = hits.get(t.sectionId);
        if (!hit) continue;
        const sev = gapSeverity(t.sectionId, true);
        found.push({
          fingerprint: sha(`gap|${t.sectionId}`),
          row: [
            'gap',
            t.sectionId,
            `No evidence for ${empty.get(t.sectionId)}, but ${t.why}`,
            `${hit.name}: "${snippet(hit.text, t.re)}"`,
            sev.severity,
            sev.reason,
            null,
            null,
            t.sectionId,
          ],
        });
      }
    }

    await dataService.transaction({ orgId }, async (tx) => {
      for (const f of found) {
        await tx.query(
          'problems',
          `INSERT INTO problems (org_id, project_id, kind, topic_key, title, detail, severity, severity_reason, fact_a_id, fact_b_id, section_id, fingerprint)
           VALUES ($1, $2, $3, left($4, 120), left($5, 300), left($6, 1000), $7, left($8, 300), $9, $10, $11, $12)
           ON CONFLICT (project_id, fingerprint) DO UPDATE SET
             title = EXCLUDED.title, detail = EXCLUDED.detail, severity = EXCLUDED.severity, severity_reason = EXCLUDED.severity_reason,
             fact_a_id = EXCLUDED.fact_a_id, fact_b_id = EXCLUDED.fact_b_id, still_present = true, updated_at = now()`,
          [orgId, projectId, ...f.row, f.fingerprint],
        );
      }
      await tx.query(
        'problems',
        `UPDATE problems SET still_present = false, updated_at = now()
          WHERE org_id = $1 AND project_id = $2 AND still_present AND NOT (fingerprint = ANY($3::text[]))`,
        [orgId, projectId, found.map((f) => f.fingerprint)],
      );
      await tx.query('projects', 'UPDATE projects SET problems_checked_at = now() WHERE id = $1 AND org_id = $2', [projectId, orgId]);
    });
    return { contradictions: found.filter((f) => f.row[0] === 'contradiction').length, gaps: found.filter((f) => f.row[0] === 'gap').length };
  },

  /** Worker: re-check projects whose files or sorting changed since their last check. */
  async detectChanged(): Promise<{ projects: number }> {
    let n = 0;
    const orgs = await dataService.query<{ id: string }>({}, 'orgs', "SELECT id FROM orgs WHERE status = 'active' ORDER BY id");
    for (const { id: orgId } of orgs) {
      const due = await dataService.query<{ id: string }>(
        { orgId },
        'projects',
        `SELECT p.id FROM projects p
          WHERE p.org_id = $1
            AND GREATEST(
                  (SELECT max(f.updated_at) FROM files f WHERE f.project_id = p.id AND f.org_id = p.org_id),
                  (SELECT max(a.created_at) FROM file_assignments a WHERE a.project_id = p.id AND a.org_id = p.org_id),
                  (SELECT max(g.updated_at) FROM file_revision_groups g WHERE g.project_id = p.id AND g.org_id = p.org_id)
                ) > COALESCE(p.problems_checked_at, 'epoch')
          LIMIT 20`,
        [orgId],
      );
      for (const { id } of due) {
        try {
          await this.detect(orgId, id);
          n++;
        } catch (err) {
          console.warn(`[problems] project ${id}: ${(err as Error).message}`);
        }
      }
    }
    return { projects: n };
  },
};
