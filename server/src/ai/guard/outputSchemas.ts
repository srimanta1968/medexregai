import { z } from 'zod';
import type { AiRoute } from '../registry';
import { RenderedBlock } from './dataBlocks';
import { FACT_KINDS } from './prompts';
import { stripHidden } from './sanitize';

/**
 * Output checks for document routes (F7.5, NFR-16). A model that has been talked into
 * something by a document shows it in its output: an extra field, a section that is
 * not on the list, a quote that is not in the cited passage, a block it was never
 * given, a link, or our own prompt echoed back. Every output is checked here before
 * anything uses it; a failing output is discarded, never repaired.
 */

export const OUTPUT_SCHEMA_VERSION = '2026-11-11.1';

export type OutputProblemCode =
  | 'NOT_JSON'
  | 'SCHEMA'
  | 'UNKNOWN_BLOCK'
  | 'SECTION_NOT_ALLOWED'
  | 'QUOTE_NOT_IN_SOURCE'
  | 'VALUE_NOT_IN_QUOTE'
  | 'PROMPT_LEAK'
  | 'MARKER_ECHO'
  | 'LINK_OR_ADDRESS'
  | 'TOO_LONG'
  | 'EMPTY';

export interface OutputProblem {
  code: OutputProblemCode;
  message: string;
  path?: string;
}

export interface CheckContext {
  nonce: string;
  canary: string;
  blocks: Map<string, RenderedBlock>;
  /** classify: the allowed section ids. */
  allowedSections?: string[];
}

export type CheckResult<T> = { ok: true; value: T; problems: [] } | { ok: false; problems: OutputProblem[] };

const blockId = z.string().regex(/^B\d{1,3}$/, 'must be a block id like B1');
const reason = (max: number) => z.string().trim().min(1).max(max);

export const ROUTE_SCHEMAS = {
  triage: z.object({ inScope: z.boolean(), reason: reason(400), cites: z.array(blockId).max(20) }).strict(),
  classify: z
    .object({ section: z.string().min(1).max(64), confidence: z.number().min(0).max(1), reason: reason(400), cites: z.array(blockId).min(1).max(20) })
    .strict(),
  extract: z
    .object({
      facts: z
        .array(
          z
            .object({
              kind: z.enum(FACT_KINDS),
              label: z.string().trim().min(1).max(120),
              value: z.string().trim().min(1).max(200),
              unit: z.string().trim().max(32).nullish(),
              quote: z.string().trim().min(1).max(300),
              cite: blockId,
            })
            .strict(),
        )
        .max(200),
    })
    .strict(),
  contradiction: z
    .object({ verdict: z.enum(['consistent', 'contradiction', 'unclear']), explanation: reason(800), cites: z.array(blockId).min(1).max(10) })
    .strict(),
} as const;

export type JsonRoute = keyof typeof ROUTE_SCHEMAS;
export type RouteOutput = { [R in JsonRoute]: z.infer<(typeof ROUTE_SCHEMAS)[R]> } & { draft: { text: string }; request_wording: { text: string } };

export const PROSE_LIMITS: Record<'draft' | 'request_wording', number> = { draft: 20_000, request_wording: 1_500 };

/** Which schema each route's output is checked against, for the settings page. */
export const OUTPUT_CHECKS: Record<AiRoute, string> = {
  triage: 'triage JSON {inScope, reason, cites}',
  classify: 'classify JSON {section from the allowed list, confidence, reason, cites}',
  extract: 'extract JSON {facts[] with a quote found in the cited passage}',
  contradiction: 'contradiction JSON {verdict, explanation, cites}',
  draft: 'prose with [B#] citations to given passages, no links or images',
  request_wording: 'prose up to 1,500 characters, no links or addresses',
};

const LINK = /\bhttps?:\/\/|\bwww\.[a-z0-9-]+\.|!\[[^\]]*\]\(|\[[^\]]+\]\([^)]+\)|\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b|<\s*(?:img|a|script|iframe)\b/i;

/** Lower-case, invisible characters gone, quotes and dashes unified, whitespace collapsed. */
export function normaliseForMatch(s: string): string {
  return stripHidden(s)
    .toLowerCase()
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function leaks(raw: string, ctx: CheckContext): OutputProblem[] {
  const out: OutputProblem[] = [];
  if (raw.includes(ctx.canary) || raw.includes(ctx.nonce)) out.push({ code: 'PROMPT_LEAK', message: 'The output repeats part of the system prompt' });
  if (/\b(?:BEGIN|END)[_ -]?DATA\b/i.test(raw)) out.push({ code: 'MARKER_ECHO', message: 'The output contains data-block markers' });
  return out;
}

function parseJson(raw: string): unknown {
  // Tolerate one surrounding code fence, nothing else.
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(raw);
  return JSON.parse(fenced ? fenced[1] : raw.trim());
}

function citesKnown(ids: string[], ctx: CheckContext, path: string): OutputProblem[] {
  return ids.filter((id) => !ctx.blocks.has(id)).map((id) => ({ code: 'UNKNOWN_BLOCK' as const, message: `${id} was not one of the blocks given`, path }));
}

/** Check one model output for a route. Returns the parsed value only when every check passes. */
export function checkRouteOutput<R extends AiRoute>(route: R, raw: string, ctx: CheckContext): CheckResult<RouteOutput[R]> {
  const problems: OutputProblem[] = leaks(raw, ctx);
  if (!raw.trim()) return { ok: false, problems: [{ code: 'EMPTY', message: 'The model returned nothing' }] };

  if (route === 'draft' || route === 'request_wording') {
    const text = raw.trim();
    const limit = PROSE_LIMITS[route as 'draft' | 'request_wording'];
    if (text.length > limit) problems.push({ code: 'TOO_LONG', message: `Longer than ${limit} characters` });
    if (LINK.test(text)) problems.push({ code: 'LINK_OR_ADDRESS', message: 'The output contains a link, image or address' });
    const cited = [...text.matchAll(/\[(B\d{1,3})\]/g)].map((m) => m[1]);
    problems.push(...citesKnown(cited, ctx, 'text'));
    if (/^\s*[{[]/.test(text) && /"(?:tool|function|name|arguments)"\s*:/.test(text)) {
      problems.push({ code: 'SCHEMA', message: 'Prose was expected; the output looks like a tool call' });
    }
    return problems.length ? { ok: false, problems } : { ok: true, value: { text } as RouteOutput[R], problems: [] };
  }

  let parsed: unknown;
  try {
    parsed = parseJson(raw);
  } catch {
    return { ok: false, problems: [...problems, { code: 'NOT_JSON', message: 'The output is not a JSON object' }] };
  }
  const schema = ROUTE_SCHEMAS[route as JsonRoute];
  const r = schema.safeParse(parsed);
  if (!r.success) {
    return {
      ok: false,
      problems: [
        ...problems,
        ...r.error.issues.slice(0, 10).map((i) => ({ code: 'SCHEMA' as const, message: i.message, path: i.path.join('.') || undefined })),
      ],
    };
  }
  const value = r.data as RouteOutput[JsonRoute];
  // Free-text fields must not carry links either (a planted "see https://..." is exfiltration).
  const freeText = JSON.stringify(value);
  if (LINK.test(freeText)) problems.push({ code: 'LINK_OR_ADDRESS', message: 'The output contains a link, image or address' });

  if ('cites' in value) problems.push(...citesKnown(value.cites, ctx, 'cites'));
  if (route === 'classify') {
    const v = value as RouteOutput['classify'];
    if (!ctx.allowedSections?.includes(v.section))
      problems.push({ code: 'SECTION_NOT_ALLOWED', message: `"${v.section}" is not an allowed section`, path: 'section' });
  }
  if (route === 'extract') {
    (value as RouteOutput['extract']).facts.forEach((f, i) => {
      const block = ctx.blocks.get(f.cite);
      if (!block) {
        problems.push({ code: 'UNKNOWN_BLOCK', message: `${f.cite} was not one of the blocks given`, path: `facts.${i}.cite` });
        return;
      }
      const quote = normaliseForMatch(f.quote);
      if (!normaliseForMatch(block.text).includes(quote)) {
        problems.push({ code: 'QUOTE_NOT_IN_SOURCE', message: `The quote for "${f.label.slice(0, 40)}" is not in ${f.cite}`, path: `facts.${i}.quote` });
      } else if (['quantity', 'standard', 'date', 'identifier'].includes(f.kind) && !quote.includes(normaliseForMatch(f.value))) {
        problems.push({ code: 'VALUE_NOT_IN_QUOTE', message: `The value of "${f.label.slice(0, 40)}" is not in its quote`, path: `facts.${i}.value` });
      }
    });
  }
  return problems.length ? { ok: false, problems } : { ok: true, value: value as RouteOutput[R], problems: [] };
}
