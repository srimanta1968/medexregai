/**
 * F3.4 eSTAR attachment rules, versioned per eSTAR template.
 *
 * Every limit is quoted from FDA's eSTAR Program page
 * (https://www.fda.gov/medical-devices/how-study-and-market-your-device/estar-program,
 * "Content current as of 09/21/2026"), read 2026-11-12:
 *   - "there is a 124-character limit for attachment names; eSTAR will not accept names that
 *     exceed this limit."
 *   - "to submit your eSTAR via the CDRH Portal, the attachment size limit is 1GB and the
 *     entire eSTAR size limit is 4GB."
 *   - "Unacceptable attachment types (e.g., zip files) are automatically rejected in eSTAR"
 * Templates current on that page: nIVD eSTAR 7.1, IVD eSTAR 7.1 (PreSTAR 3.1 is for
 * pre-submissions and has no attachment rules here).
 *
 * Interpretation (ours, labelled as such in the UI):
 *   - FDA does not say whether "GB" is 10^9 or 2^30 bytes; we use 10^9, the stricter reading,
 *     so a file we pass is never over FDA's limit under either reading.
 *   - FDA names zip as an example of an unacceptable type; other archive formats are flagged
 *     as "likely rejected" with that reason, not as an FDA rule.
 *   - A name of exactly 124 characters is allowed by FDA; we warn that it is at the limit.
 * When FDA changes a limit, add a new version here; never edit a published one, so a check
 * run against an older template stays reproducible.
 */

export interface EstarRules {
  /** Stable key stored on the project. */
  key: string;
  label: string;
  maxNameChars: number;
  maxAttachmentBytes: number;
  maxTotalBytes: number;
  /** Extensions FDA names as unacceptable. */
  rejectedExtensions: string[];
  /** Archive extensions we flag as likely rejected (our reading of "e.g., zip files"). */
  likelyRejectedExtensions: string[];
  source: { url: string; contentAsOf: string; readOn: string };
}

const SOURCE = {
  url: 'https://www.fda.gov/medical-devices/how-study-and-market-your-device/estar-program',
  contentAsOf: '2026-09-21',
  readOn: '2026-11-12',
};

const COMMON = {
  maxNameChars: 124,
  maxAttachmentBytes: 1_000_000_000,
  maxTotalBytes: 4_000_000_000,
  rejectedExtensions: ['zip'],
  likelyRejectedExtensions: ['7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz'],
  source: SOURCE,
};

export const ESTAR_RULES: readonly EstarRules[] = [
  { key: 'nIVD-7.1', label: 'Non-IVD eSTAR 7.1', ...COMMON },
  { key: 'IVD-7.1', label: 'IVD eSTAR 7.1', ...COMMON },
];

export const DEFAULT_ESTAR_TEMPLATE = 'nIVD-7.1';

export function rulesFor(key: string | null | undefined): EstarRules {
  return ESTAR_RULES.find((r) => r.key === key) ?? ESTAR_RULES.find((r) => r.key === DEFAULT_ESTAR_TEMPLATE)!;
}

export const ESTAR_TEMPLATE_KEYS = ESTAR_RULES.map((r) => r.key);
