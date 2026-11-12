/**
 * F2.3 rule-based fact extraction. Only topics where a device has ONE right answer
 * across its documents are extracted, so a difference between files is a real
 * contradiction and not two different tests: shelf life, sterilization method,
 * sterility assurance level, key dimensions, and which edition of a standard is cited.
 * Every fact keeps the exact words it came from.
 */

export type FactKind = 'quantity' | 'standard' | 'date' | 'identifier' | 'material' | 'method' | 'result';

export interface ExtractedFact {
  kind: FactKind;
  topicKey: string;
  label: string;
  value: string;
  unit: string | null;
  valueNum: number | null;
  baseUnit: string | null;
  quote: string;
}

const quoteAround = (text: string, index: number, length: number): string => {
  const start = Math.max(0, text.lastIndexOf('.', index) + 1, index - 140);
  const endDot = text.indexOf('.', index + length);
  const end = Math.min(text.length, endDot === -1 ? index + length + 140 : Math.min(endDot + 1, index + length + 160));
  return text.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, 300);
};

const num = (s: string): number => Number(s.replace(',', '.'));

/** Months, for shelf life. */
function toMonths(value: number, unit: string): number | null {
  const u = unit.toLowerCase();
  if (u.startsWith('y')) return value * 12;
  if (u.startsWith('mo')) return value;
  if (u.startsWith('w')) return Math.round((value * 12) / 52);
  if (u.startsWith('d')) return Math.round((value * 12) / 365);
  return null;
}

/** Millimetres, for dimensions. French size: 1 Fr = 1/3 mm (outer diameter). */
function toMm(value: number, unit: string): number | null {
  const u = unit.toLowerCase();
  if (u === 'mm') return value;
  if (u === 'cm') return value * 10;
  if (u === 'in' || u === 'inch' || u === 'inches' || u === '"') return Number((value * 25.4).toFixed(3));
  if (u === 'fr' || u === 'f') return Number((value / 3).toFixed(3));
  return null;
}

type Rule = (text: string) => ExtractedFact[];

const PARTS = ['tubing', 'tube', 'shaft', 'catheter', 'lumen', 'needle', 'cannula', 'sheath', 'hub', 'connector', 'wire', 'guidewire', 'balloon', 'stent', 'housing', 'port'];

/** The device part named just before a dimension ("Tubing OD", "shaft outer diameter"). */
function partBefore(text: string, index: number): string | null {
  const before = text.slice(Math.max(0, index - 30), index).toLowerCase();
  const words = before.split(/[^a-z]+/).filter(Boolean);
  const last = words[words.length - 1];
  return last && PARTS.includes(last) ? (last === 'tube' ? 'tubing' : last) : null;
}

const each = (re: RegExp, text: string, f: (m: RegExpExecArray) => ExtractedFact | null): ExtractedFact[] => {
  const out: ExtractedFact[] = [];
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = g.exec(text))) {
    const fact = f(m);
    if (fact) out.push(fact);
  }
  return out;
};

const RULES: Rule[] = [
  // "Shelf life: 3 years", "shelf-life of 24 months", "expiry of 2 years"
  (t) =>
    each(/\b(?:shelf[\s-]*life|expiry|expiration)(?:\s+(?:of|is|:|=|claim(?:ed)?|period))*\s*:?\s*(\d+(?:[.,]\d+)?)\s*(years?|yrs?|months?|mos?|weeks?|days?)\b/i, t, (m) => {
      const months = toMonths(num(m[1]), m[2]);
      return months === null
        ? null
        : { kind: 'quantity', topicKey: 'shelf life', label: 'Shelf life', value: `${m[1]} ${m[2]}`, unit: m[2], valueNum: months, baseUnit: 'months', quote: quoteAround(t, m.index, m[0].length) };
    }),
  // "accelerated ageing equivalent to 24 months real time", "simulate 2 years of real-time shelf life"
  (t) =>
    each(/\b(?:equivalent to|simulat(?:e|es|ing)|support(?:s|ing)?)\s+(\d+(?:[.,]\d+)?)\s*(years?|months?)\s+(?:of\s+)?real[\s-]*time/i, t, (m) => {
      const months = toMonths(num(m[1]), m[2]);
      return months === null
        ? null
        : { kind: 'result', topicKey: 'shelf life', label: 'Shelf life supported by ageing', value: `${m[1]} ${m[2]}`, unit: m[2], valueNum: months, baseUnit: 'months', quote: quoteAround(t, m.index, m[0].length) };
    }),
  // Sterilization method
  (t) => {
    const methods: [RegExp, string][] = [
      [/\b(?:sterili[sz]ed|sterili[sz]ation)\b[^.]{0,60}\b(?:ethylene oxide|EO|EtO)\b|\b(?:ethylene oxide|EtO)\s+sterili[sz]/i, 'ethylene oxide'],
      [/\b(?:sterili[sz]ed|sterili[sz]ation)\b[^.]{0,60}\b(?:gamma|cobalt-?60)\b|\bgamma\s+(?:irradiation|sterili[sz])/i, 'gamma irradiation'],
      [/\b(?:sterili[sz]ed|sterili[sz]ation)\b[^.]{0,60}\b(?:e-?beam|electron beam)\b|\b(?:e-?beam|electron beam)\s+sterili[sz]/i, 'electron beam'],
      [/\b(?:sterili[sz]ed|sterili[sz]ation)\b[^.]{0,60}\b(?:steam|moist heat|autoclav)\w*|\bsteam\s+sterili[sz]/i, 'moist heat (steam)'],
    ];
    return methods.flatMap(([re, value]) =>
      each(re, t, (m) => ({ kind: 'method', topicKey: 'sterilization method', label: 'Sterilization method', value, unit: null, valueNum: null, baseUnit: null, quote: quoteAround(t, m.index, m[0].length) })),
    );
  },
  // Sterility assurance level: "SAL of 10^-6", "SAL 10-6", "sterility assurance level of 10⁻⁶"
  (t) =>
    each(/\b(?:SAL|sterility assurance level)\b[^0-9]{0,15}10\s*(?:\^|\*\*)?\s*[-−⁻]\s*([0-9⁰-⁹]{1,2})/i, t, (m) => {
      const exp = Number(m[1].replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (c) => String('⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(c))));
      return { kind: 'quantity', topicKey: 'sterility assurance level', label: 'Sterility assurance level', value: `10^-${exp}`, unit: null, valueNum: exp, baseUnit: 'exponent', quote: quoteAround(t, m.index, m[0].length) };
    }),
  // Dimensions: outer / inner diameter, French size
  (t) =>
    each(/\b(outer diameter|outside diameter|\bOD\b|inner diameter|inside diameter|\bID\b)\b[^0-9.\n]{0,20}(\d+(?:[.,]\d+)?)\s*(mm|cm|in(?:ch(?:es)?)?|Fr|")(?![a-z])/i, t, (m) => {
      const inner = /inner|inside|\bID\b/i.test(m[1]);
      const mm = toMm(num(m[2]), m[3]);
      // Which part it measures (the word before "OD"/"diameter"): tubing, shaft, catheter...
      // Different parts are different topics, so their sizes are never compared.
      const part = partBefore(t, m.index);
      const what = inner ? 'inner diameter' : 'outer diameter';
      return mm === null
        ? null
        : {
            kind: 'quantity',
            topicKey: part ? `${part} ${what}` : what,
            label: `${part ? `${part[0].toUpperCase()}${part.slice(1)} ` : ''}${what}`,
            value: `${m[2]} ${m[3]}`,
            unit: m[3],
            valueNum: mm,
            baseUnit: 'mm',
            quote: quoteAround(t, m.index, m[0].length),
          };
    }),
  (t) =>
    each(/\b(\d{1,2}(?:[.,]5)?)\s*(?:Fr|French)\b/, t, (m) => ({
      kind: 'quantity',
      topicKey: 'french size',
      label: 'French size',
      value: `${m[1]} Fr`,
      unit: 'Fr',
      valueNum: toMm(num(m[1]), 'fr'),
      baseUnit: 'mm',
      quote: quoteAround(t, m.index, m[0].length),
    })),
  // Standard editions: "ISO 10993-1:2018", "IEC 60601-1:2005+A1:2012", "ASTM F1980-21"
  (t) =>
    each(/\b(ISO|IEC|ASTM|AAMI|ANSI)\s*\/?\s*([A-Z]?\d{2,5}(?:-\d{1,3})*)\s*(?::|-)\s*((?:19|20)\d{2}|\d{2})\b/, t, (m) => {
      if (m[1] === 'ASTM' && m[3].length !== 2 && m[3].length !== 4) return null;
      const year = m[3].length === 2 ? `20${m[3]}` : m[3];
      const std = `${m[1]} ${m[2]}`;
      return { kind: 'standard', topicKey: `edition of ${std}`.toLowerCase(), label: `Edition of ${std}`, value: year, unit: null, valueNum: Number(year), baseUnit: 'year', quote: quoteAround(t, m.index, m[0].length) };
    }),
];

/** Facts stated in one passage, de-duplicated by topic and value. */
export function extractFacts(text: string): ExtractedFact[] {
  const seen = new Set<string>();
  const out: ExtractedFact[] = [];
  for (const rule of RULES) {
    for (const f of rule(text)) {
      const key = `${f.topicKey}|${f.valueNum ?? f.value.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
  }
  return out;
}

/** Two values of a topic disagree (numbers within 1% are the same). */
export function disagree(a: { valueNum: number | null; value: string }, b: { valueNum: number | null; value: string }): boolean {
  if (a.valueNum !== null && b.valueNum !== null) {
    const hi = Math.max(Math.abs(a.valueNum), Math.abs(b.valueNum));
    return hi === 0 ? false : Math.abs(a.valueNum - b.valueNum) / hi > 0.01;
  }
  return a.value.trim().toLowerCase() !== b.value.trim().toLowerCase();
}
