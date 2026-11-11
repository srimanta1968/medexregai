import { dataService } from '../../services/DataService';
import { AiError } from '../errors';
import { AiContext, AiRoute, aiGenerate, AiGenerateResult } from '../registry';
import { DataBlockInput, renderDataBlocks } from './dataBlocks';
import { findInjectionSignals, InjectionSignal } from './injectionSignals';
import { checkRouteOutput, OutputProblem, RouteOutput } from './outputSchemas';
import { buildDocumentPrompt, RouteTasks } from './prompts';
import { AppError, ErrorCodes } from '../../utils/AppError';
import { ProviderKind } from '../types';

/**
 * The one way product code runs a model over client documents (F7.5, NFR-16):
 *
 *   1. passages become delimited data blocks with a fresh nonce (dataBlocks.ts);
 *   2. instructions come only from our template (prompts.ts); the request carries no
 *      tools and aiGenerate refuses anything but system + prompt;
 *   3. the output is checked against the route's schema and the blocks it was given
 *      (outputSchemas.ts); a failing output is discarded, tried once more with a new
 *      nonce and canary, then refused with AI_OUTPUT_REJECTED;
 *   4. block ids in the output are mapped back to citations ([C:<version>#<ordinal>]),
 *      ready for the citation gate.
 *
 * Signals of planted instructions in the blocks are counted and recorded with the
 * call; they never change what happens.
 */

export const MAX_ATTEMPTS = 2;

export interface DocumentCallResult<R extends AiRoute> {
  route: R;
  value: RouteOutput[R];
  /** Block id -> the ref the caller supplied (a citation such as "C:<id>#<ordinal>"). */
  refs: Record<string, string>;
  /** For prose routes: the text with [B#] replaced by [<ref>]. */
  citedText?: string;
  inputSignals: InjectionSignal[];
  attempts: number;
  call: Pick<AiGenerateResult, 'callId' | 'provider' | 'model' | 'source' | 'promptVersion' | 'registryVersion' | 'usage' | 'costUsd'>;
}

/** Generates with the route, then checks; exported so the injection suite can drive it with a scripted model. */
export type Generator = (
  ctx: AiContext,
  route: AiRoute,
  req: { system: string; prompt: string },
) => Promise<Pick<AiGenerateResult, 'text'> & Partial<AiGenerateResult>>;

async function recordCheck(ctx: AiContext, callId: string | undefined, passed: boolean, problems: OutputProblem[], signals: number): Promise<void> {
  if (!callId) return;
  await dataService.query(
    { orgId: ctx.orgId },
    'ai_calls',
    `UPDATE ai_calls SET output_check = $3, output_problems = $4::jsonb, input_signals = $5
      WHERE id = $1 AND org_id = $2`,
    [callId, ctx.orgId, passed ? 'passed' : 'rejected', passed ? null : JSON.stringify(problems.slice(0, 20)), Math.min(signals, 32767)],
  );
}

export async function documentGenerate<R extends AiRoute>(
  ctx: AiContext,
  route: R,
  input: { task: RouteTasks[R]; blocks: DataBlockInput[]; allowedSections?: string[] },
  generate: Generator = aiGenerate,
): Promise<DocumentCallResult<R>> {
  if (!input.blocks.length) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'A document route needs at least one passage');
  const signals = input.blocks.flatMap((b) => findInjectionSignals(b.text, { where: b.where }));
  const allowedSections = route === 'classify' ? (input.task as RouteTasks['classify']).sections.map((s) => s.id) : input.allowedSections;

  let lastProblems: OutputProblem[] = [];
  let lastProvider: ProviderKind = 'ollama';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const rendered = renderDataBlocks(input.blocks);
    const built = buildDocumentPrompt(route, input.task, rendered);
    const result = await generate(ctx, route, { system: built.system, prompt: built.prompt });
    const check = checkRouteOutput(route, result.text, { nonce: rendered.nonce, canary: built.canary, blocks: rendered.blocks, allowedSections });
    await recordCheck(ctx, result.callId, check.ok, check.ok ? [] : check.problems, signals.length);
    if (!check.ok) {
      lastProblems = check.problems;
      lastProvider = result.provider ?? lastProvider;
      continue;
    }
    const refs: Record<string, string> = {};
    for (const [id, b] of rendered.blocks) refs[id] = b.ref;
    const citedText = 'text' in check.value ? (check.value.text as string).replace(/\[(B\d{1,3})\]/g, (_m, id: string) => `[${refs[id]}]`) : undefined;
    return {
      route,
      value: check.value,
      refs,
      citedText,
      inputSignals: signals,
      attempts: attempt,
      call: {
        callId: result.callId ?? '',
        provider: result.provider ?? 'ollama',
        model: result.model ?? '',
        source: result.source ?? 'platform',
        promptVersion: result.promptVersion ?? built.templateVersion,
        registryVersion: result.registryVersion ?? '',
        usage: result.usage ?? { inputTokens: 0, outputTokens: 0 },
        costUsd: result.costUsd ?? null,
      },
    };
  }
  throw new AiError(
    502,
    ErrorCodes.AI_OUTPUT_REJECTED,
    `The AI output did not pass the safety checks and was discarded (${lastProblems
      .slice(0, 3)
      .map((p) => p.code)
      .join(', ')}).`,
    false,
    lastProvider,
  );
}
