import { FdaClient, FdaServiceError } from '@medexregai/fda-sdk';
import { config } from '../config/env';
import { fdaClient } from '../fda/fdaService';
import { dataService } from '../services/DataService';

/**
 * F3.5 draft check: every predicate K-number (K + 6 digits, or DEN + 6 digits for De Novo)
 * written in a section draft is looked up in FDA's 510(k) data through the FDA layer
 * (@medexregai/fda-sdk, ADR-017). A K-number found there is "verified" and gets its recall
 * and MAUDE flags; one that is not is flagged so a mistyped or invented predicate never
 * reaches a submission unnoticed. Results are stored per draft, dated with the FDA data's
 * own as-of date, and shown inline next to the statements that mention them.
 *
 * Runs in the worker (checkPendingDrafts) after a draft is ready; drafts are claimed
 * pending -> checking so two workers never check the same one.
 */

export type FdaCheckStatus = 'pending' | 'checking' | 'done' | 'failed';
export type ReferenceStatus = 'verified' | 'not_found' | 'unavailable';

export interface ReferenceCheck {
  kNumber: string;
  status: ReferenceStatus;
  /** Statements (by ordinal) that mention the K-number. */
  statementOrdinals: number[];
  clearance: {
    applicant: string | null;
    deviceName: string | null;
    productCode: string | null;
    decisionDate: string | null;
    decisionDescription: string | null;
    clearanceType: string | null;
    fdaUrl: string;
  } | null;
  flags: {
    recalls: { total: number; open: number; items: { productResNumber: string; recallStatus: string | null; dateInitiated: string | null; reasonForRecall: string | null; fdaUrl: string | null }[] };
    maude: { scope: 'product_code'; productCode: string | null; tracked: boolean; reportsLast12Months: number | null; note: string };
  } | null;
  /** Plain-language findings for the consultant. */
  notes: string[];
  dataAsOf: string | null;
  checkedAt: string;
}

export interface DraftFdaCheck {
  status: FdaCheckStatus;
  checkedAt: string | null;
  error: string | null;
  references: ReferenceCheck[];
  counts: { references: number; verified: number; notFound: number; unavailable: number; withRecalls: number };
}

/** K-numbers as the FDA issues them. Upper case only: "k123456" in prose is far more often something else. */
const K_NUMBER = /\b(K|DEN)(\d{6})\b/g;

/** The distinct K-numbers in the statements, each with the ordinals that mention it, in order of first mention. */
export function findKNumbers(statements: { ordinal: number; text: string }[]): Map<string, number[]> {
  const found = new Map<string, number[]>();
  for (const s of statements) {
    for (const m of s.text.matchAll(K_NUMBER)) {
      const k = `${m[1]}${m[2]}`;
      const at = found.get(k) ?? [];
      if (!at.includes(s.ordinal)) at.push(s.ordinal);
      found.set(k, at);
    }
  }
  return found;
}

/** Recalls shown per K-number; the totals are always complete. */
const RECALLS_KEPT = 3;
/** A claim older than this is a dead worker's. */
const STALE_CLAIM = "interval '10 minutes'";

/** Look one K-number up. Never throws: an unreachable service gives "unavailable". */
export async function checkKNumber(client: FdaClient | null, kNumber: string, statementOrdinals: number[]): Promise<ReferenceCheck> {
  const base = { kNumber, statementOrdinals, checkedAt: new Date().toISOString() };
  if (!client) {
    return { ...base, status: 'unavailable', clearance: null, flags: null, notes: ['The FDA data service is not configured, so this K-number could not be checked.'], dataAsOf: null };
  }
  try {
    const c = await client.getClearance(kNumber);
    const notes: string[] = [];
    const decision = c.decisionDescription ?? '';
    if (/not substantially equivalent/i.test(decision)) notes.push(`FDA's decision for ${kNumber} is "${decision}", so it cannot serve as a predicate.`);
    let flags: ReferenceCheck['flags'] = null;
    try {
      const f = await client.getFlags(kNumber);
      flags = {
        recalls: {
          total: f.recalls.total,
          open: f.recalls.open,
          items: f.recalls.items.slice(0, RECALLS_KEPT).map((r) => ({
            productResNumber: r.productResNumber,
            recallStatus: r.recallStatus,
            dateInitiated: r.dateInitiated,
            reasonForRecall: r.reasonForRecall,
            fdaUrl: r.fdaUrl,
          })),
        },
        maude: {
          scope: 'product_code',
          productCode: f.productCode,
          tracked: f.maude.tracked,
          reportsLast12Months: f.maude.reportsLast12Months,
          note: f.maude.tracked
            ? `MAUDE counts are for product code ${f.productCode ?? 'unknown'} as a whole, not this device alone.`
            : 'MAUDE counts are not tracked for this product code yet. Add it to a device in your workspace to start tracking.',
        },
      };
      if (f.recalls.total) notes.push(`${f.recalls.total} recall${f.recalls.total === 1 ? '' : 's'} linked to ${kNumber} in FDA's recall data${f.recalls.open ? `, ${f.recalls.open} still open` : ''}.`);
    } catch (err) {
      if (!(err instanceof FdaServiceError)) throw err;
      notes.push('Recall and MAUDE flags could not be read just now; re-check later.');
    }
    return {
      ...base,
      status: 'verified',
      clearance: {
        applicant: c.applicant,
        deviceName: c.deviceName,
        productCode: c.productCode,
        decisionDate: c.decisionDate,
        decisionDescription: c.decisionDescription,
        clearanceType: c.clearanceType,
        fdaUrl: c.fdaUrl,
      },
      flags,
      notes,
      dataAsOf: c.dataAsOf,
    };
  } catch (err) {
    if (err instanceof FdaServiceError && err.status === 404) {
      return {
        ...base,
        status: 'not_found',
        clearance: null,
        flags: null,
        notes: [`${kNumber} is not in our copy of FDA's 510(k) data. Check it for a typo; a very recent clearance may not be in the copy yet.`],
        dataAsOf: null,
      };
    }
    if (!(err instanceof FdaServiceError)) throw err;
    return { ...base, status: 'unavailable', clearance: null, flags: null, notes: ['FDA data was unavailable when this was checked; re-check later.'], dataAsOf: null };
  }
}

function clientOrNull(): FdaClient | null {
  if (!config.fda.serviceKey) return null;
  return fdaClient();
}

/**
 * Check one draft. Claims it pending -> checking first, so it is a no-op when another worker
 * has it or it is not pending. Replaces the draft's previous results.
 */
export async function checkDraft(orgId: string, draftId: string): Promise<boolean> {
  const [claimed] = await dataService.query<{ id: string }>(
    { orgId },
    'section_drafts',
    `UPDATE section_drafts SET fda_check_status = 'checking', fda_check_started_at = now(), fda_check_error = NULL
      WHERE id = $1 AND org_id = $2 AND status = 'ready' AND fda_check_status = 'pending' RETURNING id`,
    [draftId, orgId],
  );
  if (!claimed) return false;
  try {
    const statements = await dataService.query<{ ordinal: number; text: string }>(
      { orgId },
      'draft_statements',
      'SELECT ordinal, text FROM draft_statements WHERE org_id = $1 AND draft_id = $2 ORDER BY ordinal',
      [orgId, draftId],
    );
    const client = clientOrNull();
    const results: ReferenceCheck[] = [];
    // One at a time: a draft names a handful of predicates, and the service rate-limits.
    for (const [k, ordinals] of findKNumbers(statements)) results.push(await checkKNumber(client, k, ordinals));
    await dataService.transaction({ orgId }, async (tx) => {
      await tx.query('draft_fda_checks', 'DELETE FROM draft_fda_checks WHERE org_id = $1 AND draft_id = $2', [orgId, draftId]);
      if (results.length) {
        await tx.query(
          'draft_fda_checks',
          `INSERT INTO draft_fda_checks (org_id, draft_id, k_number, statement_ordinals, status, clearance, flags, data_as_of, checked_at)
           SELECT $1, $2, r.k_number, r.statement_ordinals, r.status, r.clearance, r.flags, r.data_as_of, r.checked_at
             FROM jsonb_to_recordset($3::jsonb) AS r(k_number varchar, statement_ordinals int[], status varchar, clearance jsonb, flags jsonb, data_as_of date, checked_at timestamptz)`,
          [
            orgId,
            draftId,
            JSON.stringify(
              results.map((r) => ({
                k_number: r.kNumber,
                statement_ordinals: r.statementOrdinals,
                status: r.status,
                clearance: r.clearance ? { ...r.clearance, notes: r.notes } : { notes: r.notes },
                flags: r.flags,
                data_as_of: r.dataAsOf,
                checked_at: r.checkedAt,
              })),
            ),
          ],
        );
      }
      await tx.query(
        'section_drafts',
        `UPDATE section_drafts SET fda_check_status = 'done', fda_checked_at = now() WHERE id = $1 AND org_id = $2`,
        [draftId, orgId],
      );
    });
    return true;
  } catch (err) {
    await dataService.query(
      { orgId },
      'section_drafts',
      `UPDATE section_drafts SET fda_check_status = 'failed', fda_check_error = $3 WHERE id = $1 AND org_id = $2`,
      [draftId, orgId, (err as Error).message.slice(0, 500)],
    );
    console.error(`[draft-check] draft ${draftId} failed: ${(err as Error).message}`);
    return false;
  }
}

/** Worker pass: check ready drafts waiting for their FDA check, a few per firm per pass. */
export async function checkPendingDrafts(perOrg = 5): Promise<number> {
  let checked = 0;
  const orgs = await dataService.query<{ id: string }>({}, 'orgs', "SELECT id FROM orgs WHERE status = 'active' ORDER BY id");
  for (const { id: orgId } of orgs) {
    await dataService.query(
      { orgId },
      'section_drafts',
      `UPDATE section_drafts SET fda_check_status = 'pending', fda_check_started_at = NULL
        WHERE org_id = $1 AND fda_check_status = 'checking' AND fda_check_started_at < now() - ${STALE_CLAIM}`,
      [orgId],
    );
    const due = await dataService.query<{ id: string }>(
      { orgId },
      'section_drafts',
      `SELECT id FROM section_drafts WHERE org_id = $1 AND status = 'ready' AND fda_check_status = 'pending' ORDER BY finished_at NULLS LAST LIMIT $2`,
      [orgId, perOrg],
    );
    for (const { id } of due) if (await checkDraft(orgId, id)) checked += 1;
  }
  return checked;
}

/** Put a draft's check back in the queue (a consultant asked to re-check). */
export async function requeueCheck(orgId: string, draftId: string): Promise<void> {
  await dataService.query(
    { orgId },
    'section_drafts',
    `UPDATE section_drafts SET fda_check_status = 'pending', fda_check_started_at = NULL, fda_check_error = NULL
      WHERE id = $1 AND org_id = $2 AND fda_check_status <> 'checking'`,
    [draftId, orgId],
  );
}

/** Development convenience, as for drafting: check right away so `npm run dev` works without the worker. */
export function checkSoonInDev(orgId: string, draftId: string): void {
  if (config.nodeEnv === 'production') return;
  setImmediate(() => {
    checkDraft(orgId, draftId).catch((err) => console.error(`[draft-check] dev check ${draftId} failed: ${(err as Error).message}`));
  });
}

/** The stored check of one draft. */
export async function draftFdaCheck(orgId: string, draftId: string): Promise<DraftFdaCheck> {
  const [d] = await dataService.query<{ fda_check_status: FdaCheckStatus; fda_checked_at: Date | null; fda_check_error: string | null }>(
    { orgId },
    'section_drafts',
    'SELECT fda_check_status, fda_checked_at, fda_check_error FROM section_drafts WHERE id = $1 AND org_id = $2',
    [draftId, orgId],
  );
  const rows = await dataService.query<{
    k_number: string;
    statement_ordinals: number[];
    status: ReferenceStatus;
    clearance: (NonNullable<ReferenceCheck['clearance']> & { notes?: string[] }) | { notes?: string[] } | null;
    flags: ReferenceCheck['flags'];
    data_as_of: string | null;
    checked_at: Date;
  }>(
    { orgId },
    'draft_fda_checks',
    `SELECT k_number, statement_ordinals, status, clearance, flags, data_as_of::text AS data_as_of, checked_at FROM draft_fda_checks
      WHERE org_id = $1 AND draft_id = $2 ORDER BY (SELECT min(o) FROM unnest(statement_ordinals) o), k_number`,
    [orgId, draftId],
  );
  const references: ReferenceCheck[] = rows.map((r) => {
    const { notes = [], ...clearance } = (r.clearance ?? {}) as { notes?: string[] } & Record<string, unknown>;
    return {
      kNumber: r.k_number,
      status: r.status,
      statementOrdinals: r.statement_ordinals,
      clearance: r.status === 'verified' ? (clearance as unknown as ReferenceCheck['clearance']) : null,
      flags: r.flags,
      notes,
      dataAsOf: r.data_as_of,
      checkedAt: r.checked_at.toISOString(),
    };
  });
  return {
    status: d?.fda_check_status ?? 'pending',
    checkedAt: d?.fda_checked_at ? d.fda_checked_at.toISOString() : null,
    error: d?.fda_check_error ?? null,
    references,
    counts: {
      references: references.length,
      verified: references.filter((r) => r.status === 'verified').length,
      notFound: references.filter((r) => r.status === 'not_found').length,
      unavailable: references.filter((r) => r.status === 'unavailable').length,
      withRecalls: references.filter((r) => (r.flags?.recalls.total ?? 0) > 0).length,
    },
  };
}
