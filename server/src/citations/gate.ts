import { describeFact, extractFacts, Fact, factMatches } from './facts';

/**
 * Citation gate v2 (Architecture v2.0 §9). Applied to every generated text before a
 * person sees it; there is no option to turn it off.
 *
 *  Cite     client sources as [C:<file_version_id>#<location>], FDA passages as [R:<record>#<passage>]
 *  Resolve  every cited id must exist in this project (or the public FDA corpus); a citation to a
 *           superseded file version is kept with a warning
 *  Match    a quoted span must appear in the cited text; every number, unit, standard edition, date
 *           and K-number in the sentence must equal a fact extracted from a cited location
 *  Cover    a sentence with a factual entity (number, standard, material, method, date, K-number)
 *           must carry a citation
 *  Remove   failing sentences are removed and returned as open items for the consultant
 */

export type CitationKind = 'C' | 'R';

export interface CitationRef {
  kind: CitationKind;
  /** C: file_version id; R: FDA record id (e.g. a K-number). */
  source: string;
  /** C: location ordinal within the version; R: passage id. */
  locator: string;
  /** The marker as written, e.g. "[C:4f…#3]". */
  marker: string;
}

export interface ResolvedSource {
  text: string;
  /** Human label for messages and chips: "bench-report.docx v2, page 3". */
  label: string;
  /** The cited file version is no longer the file's current version. */
  superseded: boolean;
}

export type Resolution = ResolvedSource | { error: string };

export interface SourceResolver {
  /** Look up every distinct reference at once; unknown or foreign ones come back as { error }. */
  resolve(refs: CitationRef[]): Promise<Map<string, Resolution>>;
}

export type RemovalCode = 'UNCITED' | 'UNRESOLVED' | 'QUOTE_MISMATCH' | 'VALUE_MISMATCH';

export interface KeptSentence {
  text: string;
  citations: string[];
  warnings: string[];
}

export interface RemovedSentence {
  text: string;
  code: RemovalCode;
  reason: string;
}

export interface GateResult {
  /** The text with failing sentences removed (citation markers kept for the UI to render). */
  text: string;
  /** True when no supported statement is left: the answer is refused. */
  refused: boolean;
  kept: KeptSentence[];
  removed: RemovedSentence[];
  warnings: string[];
  stats: { sentences: number; kept: number; removed: number };
}

const CITATION = /\[(C|R):([^\]#\s]+)#([^\]\s]+)\]/g;
const QUOTE = /["“]([^"”]{3,})["”]/g;
// Abbreviations that end with a period but do not end a sentence.
// Abbreviations that never end a sentence ("e.g. ISO", "et al. Smith"), and "No." / "Fig." / "Ref." before a number.
const ABBREV = /\b(?:e\.g|i\.e|vs|approx|al|cf)\.$/i;
const ABBREV_BEFORE_NUMBER = /\b(?:no|nos|fig|figs|ref|refs|vol|sec|eq)\.$/i;

/**
 * Materials and methods that make a sentence a factual claim about the device or its testing.
 * A starting list; the evaluation harness (F7.4) measures what it misses.
 */
const FACT_WORDS =
  /\b(ethylene oxide|EtO|gamma[- ]irradiat\w*|electron beam|e-beam|steam steriliz\w*|autoclav\w*|polycarbonate|polyurethane|polypropylene|polyethylene|polyamide|PEEK|PTFE|PVC|silicone|nitinol|titanium|stainless steel|latex|cytotoxicity|sensiti[sz]ation|irritation|hemolysis|haemolysis|pyrogenicity|bioburden|sterility assurance|shelf[- ]life|tensile|burst|leak test\w*|biocompatib\w*)\b/i;

export function parseCitations(sentence: string): CitationRef[] {
  const refs: CitationRef[] = [];
  CITATION.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CITATION.exec(sentence)) !== null) {
    refs.push({ kind: m[1] as CitationKind, source: m[2], locator: m[3], marker: m[0] });
  }
  return refs;
}

export const refKey = (r: CitationRef): string => `${r.kind}:${r.source}#${r.locator}`;

const stripCitations = (s: string): string =>
  s
    .replace(CITATION, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
const normalise = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

/** Split a paragraph into sentences; citation markers written after the full stop stay with their sentence. */
export function splitSentences(paragraph: string): string[] {
  const parts: string[] = [];
  let start = 0;
  const re = /[.!?](?=\s+|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(paragraph)) !== null) {
    const end = m.index + 1;
    const candidate = paragraph.slice(start, end).trimEnd();
    const next = paragraph.slice(end).trimStart();
    // A sentence ends only before a capital, a digit, a quote, a bracket or the end of the text.
    if (next && !/^[A-Z0-9"“([]/.test(next)) continue;
    if (ABBREV.test(candidate) || (ABBREV_BEFORE_NUMBER.test(candidate) && /^\d/.test(next))) continue;
    parts.push(candidate);
    start = end;
  }
  if (start < paragraph.length) parts.push(paragraph.slice(start));
  // "… 42.0 N. [C:x#3] Next sentence." -> the marker belongs to the sentence before it.
  const out: string[] = [];
  for (const raw of parts) {
    const lead = /^\s*((?:\[(?:C|R):[^\]]+\]\s*)+)/.exec(raw);
    if (lead && out.length) {
      out[out.length - 1] = `${out[out.length - 1]} ${lead[1].trim()}`;
      const rest = raw.slice(lead[0].length);
      if (rest.trim()) out.push(rest.trim());
    } else if (raw.trim()) {
      out.push(raw.trim());
    }
  }
  return out;
}

/** Headings, list markers and similar structure are not statements. */
function isStructure(sentence: string): boolean {
  return /^#{1,6}\s/.test(sentence) || /^[-*•]\s*$/.test(sentence);
}

export function isFactual(sentence: string): boolean {
  const body = stripCitations(sentence).replace(/^\s*(?:\d+[.)]|\(\w\)|[-*•])\s+/, '');
  return extractFacts(body).length > 0 || FACT_WORDS.test(body);
}

export interface GateOptions {
  /**
   * Drafts (F3.2): every statement must carry a citation, not only factual ones. Connective
   * prose that cites nothing is removed and listed like any other unsupported statement.
   */
  everyStatement?: boolean;
}

export async function applyCitationGate(text: string, resolver: SourceResolver, options: GateOptions = {}): Promise<GateResult> {
  const paragraphs = text.replace(/\r\n/g, '\n').split(/\n{2,}/);
  const sentencesByParagraph = paragraphs.map((p) =>
    p.trim() ? (p.trim().startsWith('#') ? [p.trim()] : splitSentences(p.replace(/\n/g, ' ')).filter(Boolean)) : [],
  );
  const all = sentencesByParagraph.flat();

  const refs = new Map<string, CitationRef>();
  for (const s of all) for (const r of parseCitations(s)) refs.set(refKey(r), r);
  const resolved = refs.size ? await resolver.resolve([...refs.values()]) : new Map<string, Resolution>();

  const kept: KeptSentence[] = [];
  const removed: RemovedSentence[] = [];
  const warnings = new Set<string>();
  const keptByParagraph: string[][] = [];

  for (const sentences of sentencesByParagraph) {
    const keep: string[] = [];
    for (const sentence of sentences) {
      if (isStructure(sentence)) {
        keep.push(sentence);
        continue;
      }
      const cites = parseCitations(sentence);
      if (options.everyStatement && cites.length === 0) {
        removed.push({ text: stripCitations(sentence), code: 'UNCITED', reason: 'Every statement in a draft must cite a source; this one cites none' });
        continue;
      }
      const verdict = check(sentence, cites, resolved);
      if ('code' in verdict) {
        removed.push({ text: stripCitations(sentence), ...verdict });
        continue;
      }
      verdict.warnings.forEach((w) => warnings.add(w));
      if (cites.length) kept.push({ text: stripCitations(sentence), citations: cites.map((c) => c.marker), warnings: verdict.warnings });
      keep.push(sentence);
    }
    if (keep.length) keptByParagraph.push(keep);
  }

  const statements = all.filter((s) => !isStructure(s)).length;
  return {
    text: keptByParagraph.map((p) => p.join(' ')).join('\n\n'),
    // Refused when nothing supported by a citation survives (connective prose alone is not an answer).
    refused: kept.length === 0,
    kept,
    removed,
    warnings: [...warnings],
    stats: { sentences: statements, kept: statements - removed.length, removed: removed.length },
  };
}

function check(sentence: string, cites: CitationRef[], resolved: Map<string, Resolution>): Omit<RemovedSentence, 'text'> | { warnings: string[] } {
  const body = stripCitations(sentence);
  if (!cites.length) {
    return isFactual(sentence)
      ? { code: 'UNCITED', reason: 'States a fact (a value, standard, date, material or method) without citing a source' }
      : { warnings: [] };
  }

  const sources: ResolvedSource[] = [];
  const warnings: string[] = [];
  for (const c of cites) {
    const r = resolved.get(refKey(c));
    if (!r || 'error' in r) {
      return {
        code: 'UNRESOLVED',
        reason: `Citation ${c.marker} does not point at a source in this project${r && 'error' in r ? `: ${r.error}` : ''}`,
      };
    }
    sources.push(r);
    if (r.superseded) warnings.push(`${r.label} is not the latest version of that file`);
  }

  const cited = normalise(sources.map((s) => s.text).join('\n'));
  QUOTE.lastIndex = 0;
  let q: RegExpExecArray | null;
  while ((q = QUOTE.exec(body)) !== null) {
    if (!cited.includes(normalise(q[1]))) {
      return { code: 'QUOTE_MISMATCH', reason: `The quoted words “${q[1]}” are not in the cited source` };
    }
  }

  const available: Fact[] = sources.flatMap((s) => extractFacts(s.text).map((f) => f.fact));
  for (const f of extractFacts(body)) {
    if (!factMatches(f.fact, available)) {
      return {
        code: 'VALUE_MISMATCH',
        reason: `“${describeFact(f)}” does not match any value at the cited location (${sources.map((s) => s.label).join('; ')})`,
      };
    }
  }
  return { warnings };
}
