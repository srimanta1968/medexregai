/**
 * Structure-aware chunker (F7.2): turns a version's source locations into retrieval
 * chunks that can always be cited back to one place.
 *
 * - Consecutive passages merge up to TARGET_TOKENS (never past MAX_TOKENS).
 * - A chunk never crosses a "unit": a different page, slide, sheet or heading
 *   section starts a new chunk, so a citation names one page / slide / sheet.
 * - A passage longer than MAX_TOKENS is split at sentence or line breaks; each
 *   piece cites the same location.
 * - Each chunk records the first and last location it covers (start/end_location_id).
 *
 * Token counts are estimated (about 4 characters per token for English text and
 * numbers), which is close enough for packing and stays well inside the embedding
 * model's window (bge-m3: 8192 tokens).
 */

export const TARGET_TOKENS = 350;
export const MAX_TOKENS = 512;

export interface ChunkInput {
  id: string;
  ordinal: number;
  kind: string;
  page: number | null;
  sheet: string | null;
  slide: number | null;
  sectionPath: string | null;
  text: string;
}

export interface Chunk {
  ordinal: number;
  startLocationId: string;
  endLocationId: string;
  sectionPath: string | null;
  text: string;
  tokenCount: number;
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Locations in the same unit may share a chunk. */
function unitKey(l: ChunkInput): string {
  return [l.page ?? '', l.slide ?? '', l.sheet ?? '', l.sectionPath ?? ''].join('\u0000');
}

/** Split text that is too long for one chunk, preferring sentence, then line, then hard breaks. */
export function splitLong(text: string, maxTokens = MAX_TOKENS): string[] {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return [text];
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    // Last sentence end or line break in the second half of the window; else a space; else hard cut.
    const candidates = [window.lastIndexOf('\n'), ...['. ', '; ', '? ', '! '].map((s) => window.lastIndexOf(s) + 1)];
    let cut = Math.max(...candidates.filter((i) => i > maxChars / 2));
    if (!Number.isFinite(cut) || cut <= 0) cut = window.lastIndexOf(' ') > maxChars / 2 ? window.lastIndexOf(' ') : maxChars;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces.filter(Boolean);
}

/** A chunk this small (typically a bare heading) leads into what follows instead of standing alone. */
export const LEAD_IN_TOKENS = 32;

/** Same page, slide and sheet (the section may differ). */
function sameContainer(a: ChunkInput, b: ChunkInput): boolean {
  return a.page === b.page && a.slide === b.slide && a.sheet === b.sheet;
}

/** "5 Results" -> "5 Results > 5.2 Tensile" is a child; "5 Results summary" is not. */
function isSameOrChild(parent: string | null, path: string | null): boolean {
  const p = parent ?? '';
  const c = path ?? '';
  return c === p || p === '' || c.startsWith(`${p} > `);
}

type Open = { start: ChunkInput; end: ChunkInput; parts: string[]; tokens: number; unit: string };

/** "5 Results" may lead into "5 Results > 5.2 Tensile", but not into "6 Conclusion". */
function leadsInto(open: Open, loc: ChunkInput): boolean {
  if (open.tokens >= LEAD_IN_TOKENS || !sameContainer(open.end, loc)) return false;
  return isSameOrChild(open.end.sectionPath, loc.sectionPath);
}

export function chunkLocations(locations: ChunkInput[], target = TARGET_TOKENS, max = MAX_TOKENS): Chunk[] {
  const sorted = [...locations].sort((a, b) => a.ordinal - b.ordinal);
  const chunks: Chunk[] = [];
  let open: Open | null = null;

  const close = (): void => {
    if (!open) return;
    const text = open.parts.join('\n\n');
    // A heading that led into its subsection: the chunk belongs to the deeper section.
    const deeper = isSameOrChild(open.start.sectionPath, open.end.sectionPath);
    chunks.push({
      ordinal: chunks.length,
      startLocationId: open.start.id,
      endLocationId: open.end.id,
      sectionPath: deeper ? open.end.sectionPath : open.start.sectionPath,
      text,
      tokenCount: estimateTokens(text),
    });
    open = null;
  };

  for (const loc of sorted) {
    const text = loc.text.trim();
    if (!text) continue;
    const tokens = estimateTokens(text);
    const unit = unitKey(loc);

    if (tokens > max) {
      // Oversize passage: split it; a short lead-in (its heading) joins the first piece.
      const lead: Open | null = open && leadsInto(open, loc) ? open : null;
      if (!lead) close();
      const pieces = splitLong(text, lead ? max - lead.tokens - 1 : max);
      pieces.forEach((piece, i) => {
        if (i === 0 && lead) {
          open = { ...lead, end: loc, parts: [...lead.parts, piece], tokens: lead.tokens + estimateTokens(piece), unit };
        } else {
          open = { start: loc, end: loc, parts: [piece], tokens: estimateTokens(piece), unit };
        }
        close();
      });
      continue;
    }
    if (open && open.unit !== unit && leadsInto(open, loc)) {
      open.unit = unit;
    } else if (open && (open.unit !== unit || open.tokens + tokens > max || open.tokens >= target)) {
      close();
    }
    if (!open) open = { start: loc, end: loc, parts: [], tokens: 0, unit };
    open.parts.push(text);
    open.end = loc;
    open.tokens += tokens;
  }
  close();
  return chunks;
}
