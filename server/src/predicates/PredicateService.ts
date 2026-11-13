import { ClearanceSummary } from '@medexregai/fda-sdk';
import { fda } from '../fda/fdaService';
import { hybridSearch } from '../retrieval/search';
import { dataService } from '../services/DataService';
import { AppError, ErrorCodes } from '../utils/AppError';

/**
 * F5.2 predicate search (UI 2.0 §7.2): candidate predicates for a project's subject device by
 * product code, keyword (device name) or semantic query over indexed 510(k) summaries, each with
 * an IFU and a technology similarity to the subject device and its recall flags.
 *
 * Similarity is word overlap (Jaccard over content words) between the subject's text, found in
 * the client's own files, and the predicate's summary passages. It is an ESTIMATE to sort
 * candidates, never a determination of substantial equivalence, and is 'unknown' when either
 * side has no text. Recall flags come from FDA recall data (fda-data service): a predicate with
 * any linked recall is 'recall_linked'; one whose flags could not be checked is 'unknown'.
 * Only a checked predicate with no recalls is 'clean' (AC: never shown clean when recall-linked).
 */

export type SearchMode = 'product_code' | 'keyword' | 'semantic';
export type Level = 'high' | 'medium' | 'low' | 'unknown';
export type FlagStatus = 'clean' | 'recall_linked' | 'unknown';

export interface Candidate {
  kNumber: string;
  deviceName: string | null;
  applicant: string | null;
  productCode: string | null;
  decisionDate: string | null;
  clearanceType: string | null;
  /** The summary passage that matched a semantic query, with its [R:] ref. */
  matched: { ref: string; text: string } | null;
  similarity: { ifu: Level; ifuScore: number | null; tech: Level; techScore: number | null };
  flags: { status: FlagStatus; recalls: number | null; openRecalls: number | null; note: string | null };
}

export interface SearchResult {
  mode: SearchMode;
  query: string | null;
  productCode: string | null;
  subject: { deviceName: string; productCode: string | null; hasIfuText: boolean; hasTechText: boolean };
  items: Candidate[];
  nextCursor: string | null;
}

const STOP = new Set(
  'a an and are as at be by for from has have in is it its of on or that the this to was were which with device devices used use intended indicated indications patient patients system'.split(
    ' ',
  ),
);

/** Content words of a text, for overlap scoring (lower case, no stop words, 3+ letters). */
export function contentWords(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []).filter((w) => !STOP.has(w)));
}

/** Jaccard overlap of two texts' content words; null when either has too few words to compare. */
export function overlap(a: string, b: string): number | null {
  const x = contentWords(a);
  const y = contentWords(b);
  if (x.size < 3 || y.size < 3) return null;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return Math.round((both / (x.size + y.size - both)) * 1000) / 1000;
}

export function level(score: number | null): Level {
  if (score === null) return 'unknown';
  return score >= 0.2 ? 'high' : score >= 0.1 ? 'medium' : 'low';
}

const FLAG_RANK: Record<FlagStatus, number> = { clean: 0, unknown: 1, recall_linked: 2 };
const LEVEL_RANK: Record<Level, number> = { high: 0, medium: 1, low: 2, unknown: 3 };

interface Subject {
  deviceName: string;
  productCode: string | null;
  ifu: string;
  tech: string;
}

/** The subject device and its IFU and technology text from the project's own files. */
export async function subjectOf(orgId: string, projectId: string): Promise<Subject & { ifuHits: SubjectHit[]; techHits: SubjectHit[] }> {
  const [p] = await dataService.query<{ device_name: string; product_code: string | null }>(
    { orgId },
    'projects',
    `SELECT d.name AS device_name, d.product_code FROM projects p JOIN devices d ON d.id = p.device_id AND d.org_id = p.org_id WHERE p.id = $1 AND p.org_id = $2`,
    [projectId, orgId],
  );
  if (!p) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
  const find = async (query: string): Promise<SubjectHit[]> => {
    try {
      const r = await hybridSearch({ orgId, projectId, query, limit: 3 });
      return r.items.map((h) => ({ text: h.text, citation: h.citation, where: `${h.fileName} v${h.versionNo}, ${h.where}` }));
    } catch (err) {
      console.warn(`[predicates] subject search failed: ${(err as Error).message}`);
      return [];
    }
  };
  const [ifuHits, techHits] = await Promise.all([
    find('indications for use intended use'),
    find('device description principle of operation materials technological characteristics'),
  ]);
  return {
    deviceName: p.device_name,
    productCode: p.product_code,
    ifu: ifuHits.map((h) => h.text).join('\n'),
    tech: techHits.map((h) => h.text).join('\n'),
    ifuHits,
    techHits,
  };
}

export interface SubjectHit {
  text: string;
  citation: string;
  where: string;
}

/** Run up to `n` promises at a time. */
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

async function predicateText(kNumber: string, query: string): Promise<string> {
  if (!query.trim()) return '';
  try {
    const r = await fda((c) => c.searchSummaries({ q: query.slice(0, 400), kNumber, limit: 3 }));
    return r.hits.map((h) => h.text).join('\n');
  } catch {
    return '';
  }
}

async function enrich(base: Omit<Candidate, 'similarity' | 'flags'>, subject: Subject): Promise<Candidate> {
  const [flags, ifuText, techText] = await Promise.all([
    fda((c) => c.getFlags(base.kNumber)).catch(() => null),
    predicateText(base.kNumber, subject.ifu || `${subject.deviceName} indications for use`),
    predicateText(base.kNumber, subject.tech || `${subject.deviceName} device description`),
  ]);
  const ifuScore = subject.ifu && ifuText ? overlap(subject.ifu, ifuText) : null;
  const techScore = subject.tech && techText ? overlap(subject.tech, techText) : null;
  const recalls = flags ? flags.recalls.total : null;
  return {
    ...base,
    similarity: { ifu: level(ifuScore), ifuScore, tech: level(techScore), techScore },
    flags: {
      status: !flags ? 'unknown' : recalls && recalls > 0 ? 'recall_linked' : 'clean',
      recalls,
      openRecalls: flags ? flags.recalls.open : null,
      note: !flags ? 'Recall data could not be checked; not shown as clean.' : null,
    },
  };
}

const fromSummary = (c: ClearanceSummary): Omit<Candidate, 'similarity' | 'flags'> => ({
  kNumber: c.kNumber,
  deviceName: c.deviceName,
  applicant: c.applicant,
  productCode: c.productCode,
  decisionDate: c.decisionDate,
  clearanceType: c.clearanceType,
  matched: null,
});

export const predicateService = {
  async search(
    orgId: string,
    projectId: string,
    opts: { mode: SearchMode; q?: string; productCode?: string; limit: number; cursor?: string },
  ): Promise<SearchResult> {
    const subject = await subjectOf(orgId, projectId);
    let bases: Omit<Candidate, 'similarity' | 'flags'>[];
    let nextCursor: string | null = null;
    const code = opts.productCode ?? (opts.mode === 'product_code' ? subject.productCode : null) ?? undefined;
    if (opts.mode === 'product_code') {
      if (!code) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Give a productCode, or set the product code on the subject device', [{ field: 'productCode', message: 'Required' }]);
      }
      const page = await fda((c) => c.search510k({ productCode: code, limit: opts.limit, cursor: opts.cursor }));
      bases = page.items.map(fromSummary);
      nextCursor = page.nextCursor;
    } else if (opts.mode === 'keyword') {
      if (!opts.q) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'q is required for a keyword search', [{ field: 'q', message: 'Required' }]);
      const page = await fda((c) => c.search510k({ q: opts.q, productCode: code, limit: opts.limit, cursor: opts.cursor }));
      bases = page.items.map(fromSummary);
      nextCursor = page.nextCursor;
    } else {
      if (!opts.q) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'q is required for a semantic search', [{ field: 'q', message: 'Required' }]);
      const r = await fda((c) => c.searchSummaries({ q: opts.q!, productCode: code, limit: 50 }));
      const seen = new Map<string, Omit<Candidate, 'similarity' | 'flags'>>();
      for (const h of r.hits) {
        if (seen.has(h.kNumber) || seen.size >= opts.limit) continue;
        seen.set(h.kNumber, {
          kNumber: h.kNumber,
          deviceName: h.deviceName,
          applicant: h.applicant,
          productCode: h.productCode,
          decisionDate: h.decisionDate,
          clearanceType: null,
          matched: { ref: h.ref, text: h.text.slice(0, 600) },
        });
      }
      bases = [...seen.values()];
    }
    const enriched = await pool(bases, 4, (b) => enrich(b, subject));
    // Flag ranking: clean first, unknown next, recall-linked last; then IFU, then technology similarity.
    const order = new Map(bases.map((b, i) => [b.kNumber, i]));
    enriched.sort(
      (a, b) =>
        FLAG_RANK[a.flags.status] - FLAG_RANK[b.flags.status] ||
        LEVEL_RANK[a.similarity.ifu] - LEVEL_RANK[b.similarity.ifu] ||
        LEVEL_RANK[a.similarity.tech] - LEVEL_RANK[b.similarity.tech] ||
        (order.get(a.kNumber) ?? 0) - (order.get(b.kNumber) ?? 0),
    );
    return {
      mode: opts.mode,
      query: opts.q ?? null,
      productCode: code ?? null,
      subject: { deviceName: subject.deviceName, productCode: subject.productCode, hasIfuText: !!subject.ifu, hasTechText: !!subject.tech },
      items: enriched,
      nextCursor,
    };
  },
};
