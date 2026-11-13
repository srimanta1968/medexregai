import type { ProductCode, ProductCodeStats } from '@medexregai/fda-sdk';
import { config } from '../config/env';
import { fda } from '../fda/fdaService';
import { contentWords } from '../predicates/PredicateService';
import { hashIp } from '../services/PilotRequestService';
import { dataService } from '../services/DataService';
import { AppError, ErrorCodes } from '../utils/AppError';

/**
 * F6.1 public product-code pages and the free device check (UI 2.0 §8.1). FDA data only: the
 * classification database, 510(k) decisions and recalls from the fda-data service. Nothing from
 * any firm or client is read or shown, and no AI is used. Value meanings follow openFDA's field
 * reference for device classification (device_class, submission_type_id).
 */

export const YEARS = 5;

/** openFDA device classification `device_class`. */
const CLASS_LABEL: Record<string, string> = {
  '1': 'Class I',
  '2': 'Class II',
  '3': 'Class III',
  U: 'Unclassified',
  N: 'Not classified',
  F: 'HDE',
};

/** openFDA device classification `submission_type_id`: the submission type the product code is limited to. */
const PATHWAY: Record<string, { label: string; note: string }> = {
  '1': { label: '510(k)', note: 'Devices with this product code are cleared through a premarket notification, 510(k).' },
  '2': { label: 'PMA', note: 'Devices with this product code need premarket approval (PMA).' },
  '3': {
    label: 'Contact FDA',
    note: "FDA's classification database lists this code as \"Contact ODE\": the submission type is not settled, so ask FDA (for example with a Pre-Submission) before choosing a pathway.",
  },
  '4': {
    label: '510(k) exempt',
    note: 'This product code is listed as 510(k) exempt. Exemptions have limits (see the regulation), so confirm that your device is within them.',
  },
};

export interface PublicCodePage {
  productCode: string;
  deviceName: string | null;
  deviceClass: string | null;
  classLabel: string | null;
  regulationNumber: string | null;
  medicalSpecialty: string | null;
  pathway: { label: string; note: string } | null;
  implant: boolean;
  lifeSustainSupport: boolean;
  definition: string | null;
  clearancesAllTime: number;
  stats: ProductCodeStats;
}

export interface CheckInput {
  productCode: string;
  description: string;
  contactConsent: boolean;
  email?: string;
}

export interface CheckResult {
  checkId: string;
  productCode: string;
  deviceName: string | null;
  classLabel: string | null;
  regulationNumber: string | null;
  pathway: { label: string; note: string } | null;
  similarClearances: { kNumber: string; deviceName: string | null; applicant: string | null; decisionDate: string | null; match: 'high' | 'medium' | 'low'; fdaUrl: string }[];
  recalls: { total: number; open: number; topRootCauses: { cause: string; count: number }[] };
  receiptToDecisionDays: ProductCodeStats['clearances']['receiptToDecisionDays'];
  window: ProductCodeStats['window'];
  sources: ProductCodeStats['sources'];
  contacted: boolean;
}

const PMN_URL = 'https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfpmn/pmn.cfm?ID=';

/**
 * Share of a cleared device's name words that appear in the visitor's description (0-1), or null
 * when they share none. Device names are short ("Set, Administration, Intravascular"), so this
 * measures containment rather than symmetric overlap. An estimate to start predicate research.
 */
export function nameMatch(description: Set<string>, deviceName: string | null): number | null {
  const name = contentWords(deviceName ?? '');
  if (!name.size) return null;
  let hits = 0;
  for (const w of name) if (description.has(w)) hits++;
  return hits ? Math.round((hits / name.size) * 100) / 100 : null;
}

const matchLevel = (score: number): 'high' | 'medium' | 'low' => (score >= 0.67 ? 'high' : score >= 0.34 ? 'medium' : 'low');

function toPage(pc: ProductCode, stats: ProductCodeStats): PublicCodePage {
  return {
    productCode: pc.productCode,
    deviceName: pc.deviceName,
    deviceClass: pc.deviceClass,
    classLabel: pc.deviceClass ? (CLASS_LABEL[pc.deviceClass] ?? null) : null,
    regulationNumber: pc.regulationNumber,
    medicalSpecialty: pc.medicalSpecialtyDescription,
    pathway: pc.submissionTypeId ? (PATHWAY[pc.submissionTypeId] ?? null) : null,
    implant: pc.implant,
    lifeSustainSupport: pc.lifeSustainSupport,
    definition: pc.definition,
    clearancesAllTime: pc.clearances.total,
    stats,
  };
}

export const publicCodeService = {
  async page(code: string): Promise<PublicCodePage> {
    const [pc, stats] = await fda((c) => Promise.all([c.getProductCode(code), c.getProductCodeStats(code, YEARS)]));
    return toPage(pc, stats);
  },

  /**
   * The free device check: what FDA's data says about this product code, and which recent
   * clearances under it have device names closest to the visitor's description (word overlap,
   * an estimate to start predicate research, not a determination). Stores the email and the
   * description only with consent.
   */
  async check(input: CheckInput, ip: string): Promise<CheckResult> {
    const ipHash = hashIp(ip);
    const [recent] = await dataService.query<{ n: number }>(
      {},
      'device_checks',
      `SELECT count(*)::int AS n FROM device_checks WHERE source_ip_hash = $1 AND created_at > now() - interval '1 hour'`,
      [ipHash],
    );
    if ((recent?.n ?? 0) >= config.deviceChecks.perIpPerHour) {
      throw new AppError(429, ErrorCodes.RATE_LIMITED, 'Too many checks. Please try again in an hour.');
    }

    const [pc, stats, cleared] = await fda((c) =>
      Promise.all([c.getProductCode(input.productCode), c.getProductCodeStats(input.productCode, YEARS), c.search510k({ productCode: input.productCode, limit: 100 })]),
    );
    const page = toPage(pc, stats);
    const words = contentWords(input.description);
    const similar = cleared.items
      .map((k) => ({ k, score: nameMatch(words, k.deviceName) }))
      .filter((x): x is { k: (typeof cleared.items)[number]; score: number } => x.score !== null)
      .sort((a, b) => b.score - a.score || (b.k.decisionDate ?? '').localeCompare(a.k.decisionDate ?? ''))
      .slice(0, 5)
      .map(({ k, score }) => ({
        kNumber: k.kNumber,
        deviceName: k.deviceName,
        applicant: k.applicant,
        decisionDate: k.decisionDate,
        match: matchLevel(score),
        fdaUrl: PMN_URL + encodeURIComponent(k.kNumber),
      }));

    const [row] = await dataService.query<{ id: string }>(
      {},
      'device_checks',
      `INSERT INTO device_checks (product_code, contact_consent, email, description, source_ip_hash)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        input.productCode,
        input.contactConsent,
        input.contactConsent ? (input.email ?? '').toLowerCase() : null,
        input.contactConsent ? input.description : null,
        ipHash,
      ],
    );
    return {
      checkId: row.id,
      productCode: page.productCode,
      deviceName: page.deviceName,
      classLabel: page.classLabel,
      regulationNumber: page.regulationNumber,
      pathway: page.pathway,
      similarClearances: similar,
      recalls: { total: stats.recalls.total, open: stats.recalls.open, topRootCauses: stats.recalls.topRootCauses },
      receiptToDecisionDays: stats.clearances.receiptToDecisionDays,
      window: stats.window,
      sources: stats.sources,
      contacted: input.contactConsent,
    };
  },
};
