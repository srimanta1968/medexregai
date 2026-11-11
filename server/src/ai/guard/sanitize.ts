/**
 * Text clean-up applied to untrusted client-document text before it is placed in a
 * prompt (F7.5, NFR-16). It removes characters a reader cannot see but a model can
 * (Unicode tag characters, zero-width and bidirectional controls) and breaks up
 * chat-template tokens and data-block markers, so document text can neither hide
 * instructions nor pretend to close its data block and open a new turn.
 *
 * Visible wording is never changed apart from those tokens; the stored passage
 * (and therefore every citation and quote check) keeps the original text.
 */

/** Unicode "tag" characters (U+E0000-U+E007F): invisible, and used to smuggle ASCII instructions. */
const TAG_CHARS = /[\u{E0000}-\u{E007F}]/gu;
/** Zero-width and word-joiner characters, the BOM, soft hyphen and invisible operators. */
const ZERO_WIDTH = /[\u00AD\u180E\u200B-\u200F\u2060-\u2064\uFEFF]/g;
/** Bidirectional embedding, override and isolate controls (can reorder what a reviewer sees). */
const BIDI = /[\u202A-\u202E\u2066-\u2069]/g;
/** C0/C1 control characters except tab and newline. */
// eslint-disable-next-line no-control-regex -- removing control characters is the point
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
/** Private-use characters can carry font-mapped hidden text. */
const PRIVATE_USE = /[\uE000-\uF8FF]/g;

/** Chat-template and role tokens of common open and hosted models. */
const TEMPLATE_TOKENS = [
  /<\|\s*([a-z_]{2,24})\s*\|>/gi, // <|im_start|>, <|system|>, <|eot_id|>, <|start_header_id|>
  /\[\s*\/?\s*INST\s*\]/gi, // [INST] [/INST]
  /<<\s*\/?\s*SYS\s*>>/gi, // <<SYS>>
  /<\s*\/?\s*(system|assistant|user|developer|tool|function_results?|instructions?)\s*>/gi,
];

/** Our own block markers: replaced outright, so no form of them is left to imitate a fence. */
const MARKER_WORDS = /\b(?:BEGIN|END)[_ -]?DATA\b/gi;

/** Full-width ASCII look-alikes (U+FF01-U+FF5E), used to slip tokens and keywords past filters. */
export function foldFullWidth(input: string): string {
  return input.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

export interface SanitizeResult {
  text: string;
  /** Number of invisible characters removed. */
  hiddenRemoved: number;
  /** Number of template or marker tokens neutralised. */
  tokensNeutralised: number;
}

function countAndStrip(text: string, re: RegExp): [string, number] {
  let n = 0;
  const out = text.replace(re, () => {
    n += 1;
    return '';
  });
  return [out, n];
}

export function sanitizeDocumentText(input: string): SanitizeResult {
  // No NFKC here: it would rewrite units the facts depend on (mm² -> mm2, µ -> μ).
  // Full-width look-alikes are folded only for detection (injectionSignals) and for tokens below.
  let text = foldFullWidth(input);
  let hidden = 0;
  for (const re of [TAG_CHARS, ZERO_WIDTH, BIDI, CONTROL, PRIVATE_USE]) {
    const [out, n] = countAndStrip(text, re);
    text = out;
    hidden += n;
  }
  let tokens = 0;
  text = text.replace(MARKER_WORDS, () => {
    tokens += 1;
    return '[data marker removed]';
  });
  for (const re of TEMPLATE_TOKENS) {
    text = text.replace(re, (m) => {
      tokens += 1;
      // Keep the word visible for the model, without the syntax that makes it a token.
      return `(${m
        .replace(/[<>|[\]/]/g, '')
        .replace(/[_ -]+/g, ' ')
        .trim()
        .toLowerCase()})`;
    });
  }
  return { text, hiddenRemoved: hidden, tokensNeutralised: tokens };
}

/** Whether a string carries invisible characters at all (for the ingest signal). */
export function countHiddenCharacters(input: string): number {
  let n = 0;
  for (const re of [TAG_CHARS, ZERO_WIDTH, BIDI, PRIVATE_USE]) {
    re.lastIndex = 0;
    n += (input.match(re) ?? []).length;
  }
  return n;
}

/** The text with every invisible character removed (no other change). */
export function stripHidden(input: string): string {
  let text = input;
  for (const re of [TAG_CHARS, ZERO_WIDTH, BIDI, PRIVATE_USE]) text = text.replace(re, '');
  return text;
}

/** A one-line, bounded label (file names and locations are untrusted too). */
export function sanitizeLabel(input: string, max = 120): string {
  const { text } = sanitizeDocumentText(input);
  return text
    .replace(/["\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
