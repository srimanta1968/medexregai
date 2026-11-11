/**
 * Page-bounded chunker for 510(k) summaries (F1.2). Same rules as the app's
 * structure-aware chunker (server/src/ingest/chunker.ts) so FDA passages and client
 * passages cite the same way:
 *
 * - consecutive passages merge up to TARGET_TOKENS (never past MAX_TOKENS);
 * - a chunk never crosses a page or heading section, so a citation names one page;
 * - a passage longer than MAX_TOKENS is split at sentence, then line, then word breaks.
 *
 * Tokens are estimated at about 4 characters each, well inside bge-m3's 8192-token window.
 */

import { DocLocation } from './docproc';

export const TARGET_TOKENS = 350;
export const MAX_TOKENS = 512;

export interface Passage {
  ordinal: number;
  page: number | null;
  sectionPath: string | null;
  text: string;
  tokenCount: number;
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Split text that is too long for one chunk, preferring sentence, then line, then word breaks. */
export function splitLong(text: string, maxTokens = MAX_TOKENS): string[] {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return [text];
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const candidates = [window.lastIndexOf('\n'), ...['. ', '; ', '? ', '! '].map((s) => window.lastIndexOf(s) + 1)].filter(
      (i) => i > maxChars / 2,
    );
    let cut = candidates.length ? Math.max(...candidates) : -1;
    if (cut <= 0) cut = window.lastIndexOf(' ') > maxChars / 2 ? window.lastIndexOf(' ') : maxChars;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces.filter(Boolean);
}

/** Turn docproc locations into retrieval passages, in document order. */
export function chunkLocations(locations: DocLocation[]): Passage[] {
  const out: Passage[] = [];
  let buf: string[] = [];
  let bufTokens = 0;
  let unit: { page: number | null; sectionPath: string | null } | null = null;

  const flush = (): void => {
    if (!buf.length || !unit) return;
    const text = buf.join('\n').trim();
    if (text) out.push({ ordinal: out.length, page: unit.page, sectionPath: unit.sectionPath, text, tokenCount: estimateTokens(text) });
    buf = [];
    bufTokens = 0;
  };

  for (const loc of [...locations].sort((a, b) => a.ordinal - b.ordinal)) {
    const text = (loc.text || '').trim();
    if (!text) continue;
    const next = { page: loc.page ?? null, sectionPath: loc.sectionPath ?? null };
    if (!unit || unit.page !== next.page || unit.sectionPath !== next.sectionPath) {
      flush();
      unit = next;
    }
    for (const piece of splitLong(text)) {
      const t = estimateTokens(piece);
      if (bufTokens && bufTokens + t > TARGET_TOKENS) flush();
      buf.push(piece);
      bufTokens += t;
      if (bufTokens >= MAX_TOKENS) flush();
    }
  }
  flush();
  return out;
}
