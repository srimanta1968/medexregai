import { randomBytes } from 'crypto';
import { sanitizeDocumentText, sanitizeLabel } from './sanitize';

/**
 * Delimited data blocks (F7.5, NFR-16, ADR-016). Client-document text reaches a model
 * only inside blocks fenced by a marker that carries a random per-call nonce:
 *
 *   BEGIN_DATA 3f9c0a1b7e2d id=B1 source="bench-report.docx v2" where="Section 4 > Results"
 *   ...passage text...
 *   END_DATA 3f9c0a1b7e2d id=B1
 *
 * The nonce is chosen after the document was written, so the document cannot close
 * its own block; marker words and chat-template tokens inside the text are broken up
 * (sanitize.ts) as a second line. The model refers to passages by block id (B1, B2);
 * the caller maps ids back to citations, so a model never has to copy a UUID and a
 * block id it was not given is detectable.
 */

export interface DataBlockInput {
  /** What the block id maps back to, e.g. "C:<file_version_id>#<ordinal>". */
  ref: string;
  /** File name and version, shown to the model as a label. Untrusted: sanitised. */
  source: string;
  /** Location in the file (page, sheet + cells, slide or heading). Untrusted: sanitised. */
  where: string;
  text: string;
}

export interface RenderedBlock extends DataBlockInput {
  id: string;
  /** The text as placed in the prompt (sanitised, possibly cut). */
  promptText: string;
  truncated: boolean;
}

export interface RenderedBlocks {
  nonce: string;
  text: string;
  blocks: Map<string, RenderedBlock>;
  hiddenRemoved: number;
  tokensNeutralised: number;
  /** Blocks left out because the total budget was used up. */
  omitted: number;
}

/** One passage is a chunk of a few hundred tokens; this leaves room for long table rows. */
export const MAX_BLOCK_CHARS = 8_000;
/** Roughly 16k tokens of evidence per call. */
export const MAX_TOTAL_CHARS = 64_000;
export const MAX_BLOCKS = 200;

export const newNonce = (): string => randomBytes(6).toString('hex');

export function renderDataBlocks(inputs: DataBlockInput[], nonce: string = newNonce()): RenderedBlocks {
  const blocks = new Map<string, RenderedBlock>();
  const parts: string[] = [];
  let used = 0;
  let hidden = 0;
  let tokens = 0;
  let omitted = 0;
  inputs.forEach((input, i) => {
    if (blocks.size >= MAX_BLOCKS || used >= MAX_TOTAL_CHARS) {
      omitted += 1;
      return;
    }
    const id = `B${i + 1}`;
    const clean = sanitizeDocumentText(input.text);
    hidden += clean.hiddenRemoved;
    tokens += clean.tokensNeutralised;
    const room = Math.min(MAX_BLOCK_CHARS, MAX_TOTAL_CHARS - used);
    const truncated = clean.text.length > room;
    const promptText = truncated ? `${clean.text.slice(0, room)} [cut]` : clean.text;
    used += promptText.length;
    blocks.set(id, { ...input, id, promptText, truncated });
    parts.push(
      `BEGIN_DATA ${nonce} id=${id} source="${sanitizeLabel(input.source)}" where="${sanitizeLabel(input.where)}"\n${promptText}\nEND_DATA ${nonce} id=${id}`,
    );
  });
  return { nonce, text: parts.join('\n\n'), blocks, hiddenRemoved: hidden, tokensNeutralised: tokens, omitted };
}
