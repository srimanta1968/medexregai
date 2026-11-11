import type { DocLocation } from './docproc';

/**
 * Likely-PHI scan of parsed client files (NFR-9, F7.2).
 *
 * 510(k) evidence should not carry patient identity, but clinical data, complaint
 * files and case reports sometimes do. We warn and prompt the consultant to redact;
 * we never block. Patterns follow the HIPAA Safe Harbor identifier list and favour
 * labelled values ("Patient: ...", "MRN: ...") because device test reports are full
 * of numbers that look like identifiers but are not.
 *
 *  high: a labelled identifier or an SSN; one is enough to flag the file
 *  low:  emails and phone numbers; usually a lab or supplier contact, listed for review only
 *
 * Findings store a masked excerpt and the location, never the identifier itself.
 */

export type PhiType = 'ssn' | 'mrn' | 'date_of_birth' | 'patient_name' | 'health_plan_id' | 'medicare_id' | 'email' | 'phone';
export type PhiConfidence = 'high' | 'low';

export interface PhiFinding {
  type: PhiType;
  confidence: PhiConfidence;
  /** source_locations.ordinal of the passage. */
  ordinal: number;
  /** Where in the file, for the redaction prompt (page, sheet + cells, slide or heading). */
  where: string;
  /** The label kept, the value masked: "MRN: 4•••••". */
  excerpt: string;
}

export interface PhiScanResult {
  status: 'clean' | 'flagged';
  findings: PhiFinding[];
  /** Findings beyond the stored cap. */
  truncated: number;
}

interface Rule {
  type: PhiType;
  confidence: PhiConfidence;
  re: RegExp;
  /** Capture group holding the identifying value (masked in the excerpt); 0 = whole match. */
  value: number;
  /** Optional extra check on the value, to cut false positives. */
  accept?: (value: string) => boolean;
}

const NOT_A_VALUE = /^(n\/?a|none|unknown|not applicable|tbd|redacted|x+|\*+|-+)$/i;
const LABEL_SEP = String.raw`\s*(?:[:#=]|no\.?|number)?\s*[:#]?\s*`;

const RULES: Rule[] = [
  {
    type: 'ssn',
    confidence: 'high',
    // Area 000/666/9xx, group 00 and serial 0000 are never issued.
    re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
    value: 0,
  },
  {
    type: 'mrn',
    confidence: 'high',
    re: new RegExp(
      String.raw`\b(MRN|medical record(?: number| no\.?| #)?|patient id|patient number|chart (?:number|no\.?))${LABEL_SEP}([A-Z0-9][A-Z0-9-]{3,19})\b`,
      'gi',
    ),
    value: 2,
    accept: (v) => /\d/.test(v),
  },
  {
    type: 'date_of_birth',
    confidence: 'high',
    re: /\b(DOB|D\.O\.B\.?|date of birth|birth ?date|born(?: on)?)\s*[:-]?\s*(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.? \d{1,2},? \d{4}|\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]* \d{4})/gi,
    value: 2,
  },
  {
    type: 'patient_name',
    confidence: 'high',
    // "Patient: Jane Doe", "Patient name - DOE, Jane". Case-sensitive names: capitalised words.
    re: /\b(?:[Pp]atient(?:'s)?(?: [Nn]ame)?|[Pp]t\.? [Nn]ame|[Nn]ame of [Pp]atient)\s*[:-]\s*([A-Z][a-zA-Z'-]+(?:,? [A-Z][a-zA-Z'-]+){1,2})\b/g,
    value: 1,
    accept: (v) => !NOT_A_VALUE.test(v) && !/^(Subject|Patient|Unknown|Male|Female|Anonymous|Redacted)\b/i.test(v),
  },
  {
    type: 'health_plan_id',
    confidence: 'high',
    re: new RegExp(
      String.raw`\b(member id|subscriber id|insurance id|policy (?:number|no\.?)|health plan (?:id|number)|group (?:number|no\.?))${LABEL_SEP}([A-Z0-9][A-Z0-9-]{4,19})\b`,
      'gi',
    ),
    value: 2,
    accept: (v) => /\d/.test(v),
  },
  {
    type: 'medicare_id',
    confidence: 'high',
    // Medicare Beneficiary Identifier (11 characters, no S L O I B Z), only when labelled.
    re: /\b(MBI|medicare(?: beneficiary)?(?: id| number| no\.?)?)\s*[:#]?\s*([1-9][AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9]\d-?[AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9]\d-?[AC-HJKMNP-RT-Y]{2}\d{2})\b/gi,
    value: 2,
  },
  {
    type: 'email',
    confidence: 'low',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    value: 0,
  },
  {
    type: 'phone',
    confidence: 'low',
    re: /(?<![\w.-])(?:\+?1[ .-]?)?\(?[2-9]\d{2}\)?[ .-]\d{3}[ .-]\d{4}(?![\w.-])/g,
    value: 0,
  },
];

export const MAX_STORED_FINDINGS = 100;

function mask(value: string): string {
  // Keep the first character so a reviewer can find it; mask the rest, keep separators.
  let kept = false;
  return [...value]
    .map((c) => {
      if (/[\s,/.@()+-]/.test(c)) return c;
      if (kept) return '•';
      kept = true;
      return c;
    })
    .join('');
}

function excerpt(match: RegExpExecArray, valueGroup: number): string {
  const whole = match[0];
  const value = match[valueGroup] ?? whole;
  const at = whole.lastIndexOf(value);
  return (whole.slice(0, at) + mask(value) + whole.slice(at + value.length)).replace(/\s+/g, ' ').slice(0, 120);
}

export function describeLocation(l: Pick<DocLocation, 'page' | 'sheet' | 'cellRange' | 'slide' | 'sectionPath'>): string {
  if (l.sheet && l.cellRange) return `sheet ${l.sheet}, ${l.cellRange}`;
  if (l.slide) return `slide ${l.slide}`;
  if (l.page) return `page ${l.page}`;
  return l.sectionPath ?? 'document';
}

/** Scan parsed passages. Pure: no I/O, so it runs inside the ingest step before any copy is discarded. */
export function scanForPhi(locations: DocLocation[]): PhiScanResult {
  const findings: PhiFinding[] = [];
  const seen = new Set<string>();
  for (const loc of locations) {
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = rule.re.exec(loc.text)) !== null) {
        const value = (m[rule.value] ?? m[0]).trim();
        if (rule.accept && !rule.accept(value)) continue;
        // The same identifier repeated on one passage is one finding.
        const key = `${rule.type}|${loc.ordinal}|${value.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({ type: rule.type, confidence: rule.confidence, ordinal: loc.ordinal, where: describeLocation(loc), excerpt: excerpt(m, rule.value) });
      }
    }
  }
  // High-confidence findings first, then in reading order, so the capped list keeps what matters.
  findings.sort((a, b) => (a.confidence === b.confidence ? a.ordinal - b.ordinal : a.confidence === 'high' ? -1 : 1));
  const flagged = findings.some((f) => f.confidence === 'high');
  return {
    status: flagged ? 'flagged' : 'clean',
    findings: findings.slice(0, MAX_STORED_FINDINGS),
    truncated: Math.max(0, findings.length - MAX_STORED_FINDINGS),
  };
}
