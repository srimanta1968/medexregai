/**
 * Deterministic fact extraction (Architecture v2.0 §9, "Match"; §10 normalisation).
 *
 * The citation gate never trusts the model with values: every number, unit, standard
 * edition, date and K-number in a drafted sentence must equal a fact extracted the
 * same way from the cited source text. Extraction is code, not a model, so the same
 * text always yields the same facts.
 *
 * Order matters: K-numbers, standards and dates are taken out first so their digits
 * are not read again as bare quantities ("ISO 10993-5:2009" is one standard, not 10993, 5 and 2009).
 */

export type Fact =
  | { kind: 'k_number'; value: string }
  | { kind: 'standard'; body: string; number: string; edition: string | null }
  | { kind: 'date'; value: string }
  | { kind: 'quantity'; value: number; unit: string | null };

export interface FoundFact {
  fact: Fact;
  /** The text it came from, for messages. */
  raw: string;
}

const K_NUMBER = /\b([KP]\d{6}|DEN\d{6})\b/gi;
// ISO 10993-5:2009, IEC 60601-1:2005+A1:2012, ASTM F1980-21, AAMI TIR28:2016, ANSI/AAMI ST72:2019, USP <87>
const STANDARD =
  /\b((?:ANSI\/)?(?:ISO|IEC|ASTM|AAMI|EN|BS|DIN|UL|CLSI|ISTA|ANSI)(?:\/(?:IEC|ISO|ASTM|AAMI|EN))?)\s*(TIR\s*\d+|[A-Z]?\d+(?:[-.]\d+)*)(?:\s*[:-]\s*((?:19|20)\d{2})(?:\s*\+\s*A\d+(?::(?:19|20)\d{2})?)?)?(?![\w-])/g;
const USP = /\bUSP\s*<\s*(\d+)\s*>/g;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const ISO_DATE = /\b((?:19|20)\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g;
const US_DATE = /\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/((?:19|20)\d{2})\b/g;
const TEXT_DATE = new RegExp(
  String.raw`\b(?:(\d{1,2})\s+(${MONTHS.join('|')})[a-z]*\.?,?\s+((?:19|20)\d{2})|(${MONTHS.join('|')})[a-z]*\.?\s+(\d{1,2}),?\s+((?:19|20)\d{2}))\b`,
  'gi',
);

/** Units a value may carry, with their canonical spelling. Longest first so "mmHg" wins over "mm". */
const UNIT_ALIASES: [string, string][] = [
  ['mmhg', 'mmHg'],
  ['kgf', 'kgf'],
  ['lbf', 'lbf'],
  ['kpa', 'kPa'],
  ['mpa', 'MPa'],
  ['psi', 'psi'],
  ['kn', 'kN'],
  ['n', 'N'],
  ['nm', 'nm'],
  ['µm', 'µm'],
  ['um', 'µm'],
  ['mm', 'mm'],
  ['cm', 'cm'],
  ['m', 'm'],
  ['in', 'in'],
  ['ml', 'mL'],
  ['µl', 'µL'],
  ['ul', 'µL'],
  ['l', 'L'],
  ['mg', 'mg'],
  ['µg', 'µg'],
  ['kg', 'kg'],
  ['g', 'g'],
  ['°c', '°C'],
  ['degc', '°C'],
  ['°f', '°F'],
  ['%', '%'],
  ['ms', 'ms'],
  ['s', 's'],
  ['sec', 's'],
  ['seconds', 's'],
  ['min', 'min'],
  ['minutes', 'min'],
  ['h', 'h'],
  ['hr', 'h'],
  ['hours', 'h'],
  ['days', 'days'],
  ['day', 'days'],
  ['weeks', 'weeks'],
  ['months', 'months'],
  ['month', 'months'],
  ['years', 'years'],
  ['year', 'years'],
  ['kgy', 'kGy'],
  ['ma', 'mA'],
  ['a', 'A'],
  ['mv', 'mV'],
  ['v', 'V'],
  ['hz', 'Hz'],
  ['khz', 'kHz'],
  ['w', 'W'],
  ['j', 'J'],
  ['cfu', 'CFU'],
  ['eu/ml', 'EU/mL'],
  ['eu', 'EU'],
];
const UNIT_PATTERN = UNIT_ALIASES.map(([a]) => a.replace(/[/%°µ]/g, (c) => `\\${c}`)).join('|');
// 42, 42.0, 1,250, -3.5, 0.5 followed by an optional unit; "n = 30" and "30 samples" give 30 with no unit.
const QUANTITY = new RegExp(String.raw`(?<![\w.,])([-−]?\d{1,3}(?:,\d{3})+(?:\.\d+)?|[-−]?\d+(?:\.\d+)?)(?:\s*(${UNIT_PATTERN}))?(?![\w])`, 'gi');

function canonicalUnit(raw: string | undefined): string | null {
  if (!raw) return null;
  const found = UNIT_ALIASES.find(([a]) => a === raw.toLowerCase());
  return found ? found[1] : raw;
}

function pad(n: number | string): string {
  return String(n).padStart(2, '0');
}

/** Replace a matched span with spaces so later patterns do not read it again (keeps offsets). */
function blank(text: string, start: number, end: number): string {
  return text.slice(0, start) + ' '.repeat(end - start) + text.slice(end);
}

export function extractFacts(input: string): FoundFact[] {
  let text = input;
  const out: FoundFact[] = [];
  const take = (re: RegExp, toFact: (m: RegExpExecArray) => Fact | null): void => {
    re.lastIndex = 0;
    const found: RegExpExecArray[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) found.push(m);
    for (const match of found) {
      const fact = toFact(match);
      if (fact) out.push({ fact, raw: match[0].trim() });
      text = blank(text, match.index, match.index + match[0].length);
    }
  };

  take(K_NUMBER, (m) => ({ kind: 'k_number', value: m[1].toUpperCase() }));
  take(STANDARD, (m) => ({
    kind: 'standard',
    body: m[1].toUpperCase().replace(/^ANSI\//, ''),
    number: m[2].toUpperCase().replace(/\s+/g, ''),
    edition: m[3] ?? null,
  }));
  take(USP, (m) => ({ kind: 'standard', body: 'USP', number: `<${m[1]}>`, edition: null }));
  take(ISO_DATE, (m) => ({ kind: 'date', value: `${m[1]}-${m[2]}-${m[3]}` }));
  take(US_DATE, (m) => ({ kind: 'date', value: `${m[3]}-${pad(m[1])}-${pad(m[2])}` }));
  take(TEXT_DATE, (m) => {
    const day = m[1] ?? m[5];
    const month = MONTHS.indexOf((m[2] ?? m[4]).slice(0, 3).toLowerCase()) + 1;
    const year = m[3] ?? m[6];
    return month > 0 ? { kind: 'date', value: `${year}-${pad(month)}-${pad(day)}` } : null;
  });
  take(QUANTITY, (m) => {
    const value = Number(m[1].replace(/,/g, '').replace('−', '-'));
    return Number.isFinite(value) ? { kind: 'quantity', value, unit: canonicalUnit(m[2]) } : null;
  });
  return out;
}

/** Does `wanted` (from a drafted sentence) equal some fact in `available` (from the cited sources)? */
export function factMatches(wanted: Fact, available: Fact[]): boolean {
  return available.some((have) => {
    if (have.kind !== wanted.kind) return false;
    switch (wanted.kind) {
      case 'k_number':
      case 'date':
        return (have as typeof wanted).value === wanted.value;
      case 'standard': {
        const h = have as typeof wanted;
        // "ISO 10993-5" matches any edition of it; "ISO 10993-5:2009" needs that edition.
        return h.body === wanted.body && h.number === wanted.number && (wanted.edition === null || h.edition === wanted.edition);
      }
      case 'quantity': {
        const h = have as typeof wanted;
        // A unit in the sentence must be the source's unit; a bare number matches any unit.
        return Math.abs(h.value - wanted.value) < 1e-9 && (wanted.unit === null || h.unit === wanted.unit);
      }
    }
    return false;
  });
}

export function describeFact(f: FoundFact): string {
  return f.raw;
}
