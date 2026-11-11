/**
 * Evaluate our own (platform) model against the gold sets (F7.4).
 *
 *   npm run eval                                  # every route on this environment's model(s)
 *   npm run eval -- --model qwen2.5:14b-instruct  # one model for every route (a model change)
 *   npm run eval -- --note "prompt draft.v2"      # why this run was made, kept with the result
 *   npm run eval -- --no-record                   # do not store the run (no database needed)
 *   npm run eval -- --report eval-report.json     # also write the full report
 *   npm run eval -- --model-card ../docs/ai/model-card.md   # refresh the scores in the model card
 *
 * Exits 1 when a threshold is missed and 2 when the run could not finish, so CI can
 * gate a model, prompt or route change on it (.github/workflows/eval.yml).
 */
import { readFileSync, writeFileSync } from 'fs';
import { closePool } from '../../services/DataService';
import { OUTPUT_SCHEMA_VERSION } from '../guard/outputSchemas';
import { TEMPLATE_VERSIONS } from '../guard/prompts';
import { REGISTRY_VERSION } from '../registry';
import { evalStore } from './EvalStore';
import { EvalReport, runEvaluation } from './runner';
import { EVAL_SETS_VERSION } from './sets';
import { platformTarget } from './targets';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const pct = (x: number | null | undefined): string => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);

export function scoresMarkdown(r: EvalReport, meta: { provider: string; model: string; when: string; note?: string }): string {
  const s = r.scores;
  const t = r.thresholds;
  const mark = (ok: boolean): string => (ok ? 'met' : '**missed**');
  return [
    `Run ${meta.when}: ${meta.provider} \`${meta.model}\`, gold sets ${r.setsVersion}, registry ${REGISTRY_VERSION}, output checks ${OUTPUT_SCHEMA_VERSION}${meta.note ? ` (${meta.note})` : ''}. Result: **${r.passed ? 'passed' : 'failed'}**.`,
    '',
    '| Set | Score | Target | |',
    '|---|---|---|---|',
    `| Classification (${s.classification.n} files) | accuracy ${pct(s.classification.accuracy)} | ${pct(t.classification)} | ${mark(s.classification.accuracy >= t.classification)} |`,
    `| Contradictions (${s.contradiction.n} pairs) | precision ${pct(s.contradiction.precision)}, recall ${pct(s.contradiction.recall)} | precision ${pct(t.contradiction)} | ${mark(s.contradiction.precision >= t.contradiction)} |`,
    `| Drafting (${s.drafting.n} sections) | acceptance ${pct(s.drafting.acceptance)}, citation precision ${pct(s.drafting.citationPrecision)} | acceptance ${pct(t.drafting)} | ${mark(s.drafting.acceptance >= t.drafting)} |`,
    `| Prompt injection (${s.injection.n} cases) | resistance ${pct(s.injection.resistance)} | ${pct(t.injection)} | ${mark(s.injection.resistance >= t.injection)} |`,
    `| Version detection (${s.versions.n} pairs) | not run: ${s.versions.reason} | | |`,
  ].join('\n');
}

/** Replace the scores block of the model card, keeping everything else as written. */
export function updateModelCard(path: string, block: string): void {
  const start = '<!-- eval:scores:start -->';
  const end = '<!-- eval:scores:end -->';
  const card = readFileSync(path, 'utf-8');
  const a = card.indexOf(start);
  const b = card.indexOf(end);
  if (a < 0 || b < a) throw new Error(`${path} has no ${start} ... ${end} block`);
  writeFileSync(path, `${card.slice(0, a + start.length)}\n${block}\n${card.slice(b)}`);
}

async function main(): Promise<number> {
  const target = platformTarget(arg('model'));
  const model = arg('model') ?? [...new Set(Object.keys(TEMPLATE_VERSIONS).map((r) => target.modelFor(r as never)))].join(', ');
  const started = new Date();
  console.info(`Evaluating ${target.provider} ${model} on gold sets ${EVAL_SETS_VERSION}...`);
  let report: EvalReport | null = null;
  let error: string | undefined;
  try {
    report = await runEvaluation({ orgId: '00000000-0000-4000-8000-000000000000' }, target.generate, {
      onItem: (set, id, ok) => console.info(`  ${ok ? 'ok  ' : 'miss'} ${set} ${id}`),
    });
  } catch (err) {
    error = (err as Error).message;
  }
  if (!flag('no-record')) {
    await evalStore.recordPlatform({ provider: target.provider, model, report, error, note: arg('note'), startedAt: started });
  }
  if (!report) {
    console.error(`Evaluation could not finish: ${error}`);
    return 2;
  }
  const md = scoresMarkdown(report, { provider: target.provider, model, when: started.toISOString().slice(0, 10), note: arg('note') });
  console.info(`\n${md}\n\n${report.calls} model calls.`);
  if (report.failures.length) console.info(`Misses:\n${report.failures.map((f) => `  ${f.set} ${f.id}: ${f.why}`).join('\n')}`);
  const reportAt = arg('report');
  if (reportAt) writeFileSync(reportAt, JSON.stringify({ provider: target.provider, model, ...report }, null, 2));
  const card = arg('model-card');
  if (card) updateModelCard(card, md);
  return report.passed ? 0 : 1;
}

if (require.main === module) {
  main()
    .then(async (code) => {
      await closePool().catch(() => undefined);
      process.exit(code);
    })
    .catch(async (err: unknown) => {
      console.error(err);
      await closePool().catch(() => undefined);
      process.exit(2);
    });
}
