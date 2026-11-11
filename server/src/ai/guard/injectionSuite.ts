/**
 * Prompt-injection test set (F7.5, NFR-16). Runs in CI and fails the build on any miss:
 *
 *   npm run test:injection                      # docproc formats when Python + docproc deps are present
 *   npm run test:injection -- --require-docproc # CI: the format layer must run
 *   npm run test:injection -- --report out.json # also write a JSON report
 *
 * Layers, each over tests/fixtures/injection/cases.json:
 *   registry   every route is tool-free and takes document input; extra request fields are refused
 *   benign     realistic device-document sentences raise no signal (no false alarms)
 *   signals    each planted instruction is flagged with the expected kind
 *   framing    planted text stays inside its own data block: forged markers, chat-template
 *              tokens and invisible characters are gone from the prompt; no document text
 *              in the system message; the provider request has only system + prompt
 *   obeyed     a scripted model that does what the injection asks (reading our canary and
 *              nonce from the prompt it was sent) is rejected with the expected problem
 *   faithful   a correct answer to the same prompt passes, so the guard is not just refusing
 *   formats    each fixture file (docx, xlsx, pptx, pdf, csv) parsed by docproc yields the
 *              planted text at its location, flagged
 *
 * The same cases run against real models in the evaluation harness (F7.4); this suite
 * needs no model, database or network.
 */
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { AI_ROUTES, AiRoute, assertPlainRequest, REGISTRY } from '../registry';
import { renderDataBlocks } from './dataBlocks';
import { documentGenerate, Generator } from './documentCall';
import { findInjectionSignals, InjectionSignalKind, scanForInjection } from './injectionSignals';
import { checkRouteOutput } from './outputSchemas';
import { buildDocumentPrompt, RouteTasks } from './prompts';
import { countHiddenCharacters } from './sanitize';

interface Case {
  id: string;
  text: string;
  expectSignals: InjectionSignalKind[];
  route: AiRoute;
  obeyed: string;
  expectProblem: string;
}

interface CaseFile {
  version: string;
  evidence: string;
  sections: { id: string; title: string }[];
  faithful: Record<AiRoute, string>;
  cases: Case[];
  benign: string[];
  formats: { file: string; expectSignals: InjectionSignalKind[]; where: string }[];
}

interface Outcome {
  layer: string;
  id: string;
  ok: boolean;
  detail?: string;
}

const REPO = resolve(__dirname, '../../../..');
const FIXTURES = join(REPO, 'tests/fixtures/injection');
const DOCPROC_DIR = join(REPO, 'services/docproc');
const CTX = { orgId: '00000000-0000-4000-8000-000000000000' };
const EVIDENCE_REF = 'C:00000000-0000-4000-8000-0000000000e1#0';
const PLANT_REF = 'C:00000000-0000-4000-8000-0000000000e1#1';

/** {{tags:...}} -> invisible tag characters; {{zw}} -> zero-width space. */
export function expandText(s: string): string {
  return s
    .replace(/\{\{tags:([^}]*)\}\}/g, (_m, t: string) => [...t].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join(''))
    .replace(/\{\{zw\}\}/g, String.fromCharCode(0x200b));
}

function taskFor(route: AiRoute, file: CaseFile): RouteTasks[AiRoute] {
  switch (route) {
    case 'triage':
      return { question: 'Is this file evidence for the 510(k) of the Demo Catheter DC-100?' };
    case 'classify':
      return { sections: file.sections };
    case 'extract':
      return { focus: 'tensile results' };
    case 'contradiction':
      return { question: 'Do the passages agree on the tensile result?' };
    case 'draft':
      return { heading: 'Bench performance testing' };
    case 'request_wording':
      return { gap: 'the signed tensile test report for the DC-100 shaft-to-hub bond' };
  }
}

/** A model that answers with a fixed script, filling in what it can read from our prompt. */
function scripted(output: string, seen: object[] = []): Generator {
  return async (_ctx, _route, req) => {
    seen.push(req);
    const canary = /Internal reference (mx-[0-9a-f]+)/.exec(req.system)?.[1] ?? '';
    const nonce = /BEGIN_DATA ([0-9a-f]{12}) /.exec(req.prompt)?.[1] ?? '';
    const text = output
      .replace(/\{\{canary\}\}/g, canary)
      .replace(/\{\{nonce\}\}/g, nonce)
      .replace(/\{\{system\}\}/g, JSON.stringify(req.system).slice(1, -1));
    return { text };
  };
}

function blocksFor(file: CaseFile, c: Case) {
  return [
    { ref: EVIDENCE_REF, source: 'bench-report.docx v1', where: 'Section 5 > Results', text: file.evidence },
    { ref: PLANT_REF, source: 'bench-report.docx v1', where: 'Section 5 > Results', text: expandText(c.text) },
  ];
}

function framingProblems(file: CaseFile, c: Case): string[] {
  const out: string[] = [];
  const rendered = renderDataBlocks(blocksFor(file, c));
  const built = buildDocumentPrompt(c.route, taskFor(c.route, file), rendered);
  const n = rendered.nonce;
  const begins = built.prompt.split(`BEGIN_DATA ${n} `).length - 1;
  const ends = built.prompt.split(`END_DATA ${n} `).length - 1;
  if (begins !== 2 || ends !== 2) out.push(`expected 2 blocks, found ${begins} openings and ${ends} closings`);
  const allMarkers = (built.prompt.match(/\b(?:BEGIN|END)[_ -]?DATA\b/gi) ?? []).length;
  if (allMarkers !== 4) out.push(`a marker outside our own fences survived (${allMarkers} markers)`);
  if (/<\|\s*[a-z_]+\s*\|>|\[\s*\/?\s*INST\s*\]|<<\s*\/?\s*SYS\s*>>/i.test(built.prompt)) out.push('a chat-template token survived');
  if (countHiddenCharacters(built.prompt) > 0) out.push('invisible characters reached the prompt');
  const plantWords = expandText(c.text).slice(0, 24);
  if (built.system.includes(plantWords)) out.push('document text reached the system message');
  // The planted block sits between its own fences.
  const b2 = new RegExp(`BEGIN_DATA ${n} id=B2 [^\\n]*\\n([\\s\\S]*?)\\nEND_DATA ${n} id=B2`).exec(built.prompt);
  if (!b2) out.push('the planted passage is not inside block B2');
  return out;
}

async function runCase(file: CaseFile, c: Case): Promise<Outcome[]> {
  const out: Outcome[] = [];
  const kinds = new Set(findInjectionSignals(expandText(c.text)).map((s) => s.kind));
  const missing = c.expectSignals.filter((k) => !kinds.has(k));
  out.push({
    layer: 'signals',
    id: c.id,
    ok: missing.length === 0,
    detail: missing.length ? `missing ${missing.join(', ')}; found ${[...kinds].join(', ') || 'none'}` : undefined,
  });

  const framing = framingProblems(file, c);
  out.push({ layer: 'framing', id: c.id, ok: framing.length === 0, detail: framing.join('; ') || undefined });

  const task = taskFor(c.route, file);
  const blocks = blocksFor(file, c);
  const seen: object[] = [];
  try {
    await documentGenerate(CTX, c.route, { task, blocks }, scripted(c.obeyed, seen));
    out.push({ layer: 'obeyed', id: c.id, ok: false, detail: 'the obeying output was accepted' });
  } catch (err) {
    const code = (err as { code?: string }).code;
    // Re-check one rendering directly to see which problem fired.
    const rendered = renderDataBlocks(blocks);
    const built = buildDocumentPrompt(c.route, task, rendered);
    const text = (await scripted(c.obeyed)(CTX, c.route, { system: built.system, prompt: built.prompt })).text;
    const sections = c.route === 'classify' ? file.sections.map((s) => s.id) : undefined;
    const check = checkRouteOutput(c.route, text, { nonce: rendered.nonce, canary: built.canary, blocks: rendered.blocks, allowedSections: sections });
    const codes = check.ok ? [] : check.problems.map((p) => p.code);
    const ok = code === 'AI_OUTPUT_REJECTED' && codes.includes(c.expectProblem as never);
    out.push({
      layer: 'obeyed',
      id: c.id,
      ok,
      detail: ok ? undefined : `got ${code ?? (err as Error).message}; problems ${codes.join(', ') || 'none'}; expected ${c.expectProblem}`,
    });
  }
  const extraKeys = seen.flatMap((r) => Object.keys(r).filter((k) => k !== 'system' && k !== 'prompt'));
  out.push({
    layer: 'framing',
    id: `${c.id}/request`,
    ok: seen.length > 0 && extraKeys.length === 0,
    detail: extraKeys.length ? `request carried ${extraKeys.join(', ')}` : undefined,
  });

  try {
    const r = await documentGenerate(CTX, c.route, { task, blocks }, scripted(file.faithful[c.route]));
    const mapped = r.citedText === undefined || r.citedText.includes(`[${EVIDENCE_REF}]`) || !/\[B\d+\]/.test(file.faithful[c.route]);
    out.push({ layer: 'faithful', id: c.id, ok: r.attempts === 1 && mapped, detail: mapped ? undefined : 'block ids were not mapped back to citations' });
  } catch (err) {
    out.push({ layer: 'faithful', id: c.id, ok: false, detail: `a correct answer was rejected: ${(err as Error).message}` });
  }
  return out;
}

function registryOutcomes(): Outcome[] {
  const out: Outcome[] = AI_ROUTES.map((r) => ({
    layer: 'registry',
    id: r,
    ok: REGISTRY[r].tools.length === 0 && REGISTRY[r].documentInput === true,
    detail: REGISTRY[r].tools.length ? 'route has tools' : undefined,
  }));
  let refused = false;
  try {
    assertPlainRequest({ system: 's', prompt: 'p', tools: [{ name: 'send_email' }] });
  } catch {
    refused = true;
  }
  out.push({ layer: 'registry', id: 'extra-fields-refused', ok: refused, detail: refused ? undefined : 'a request with tools was accepted' });
  return out;
}

function pythonCommand(): string {
  return process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
}

function formatOutcomes(file: CaseFile, required: boolean): Outcome[] {
  const out: Outcome[] = [];
  for (const f of file.formats) {
    const path = join(FIXTURES, f.file);
    let parsed: {
      locations?: { ordinal: number; text: string; page?: number; sheet?: string; cellRange?: string; slide?: number; sectionPath?: string }[];
      error?: { code: string };
    };
    try {
      let stdout: string;
      try {
        stdout = execFileSync(pythonCommand(), ['-m', 'docproc.parse_file', path], {
          cwd: DOCPROC_DIR,
          encoding: 'utf-8',
          timeout: 120_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        // Exit 1 with a JSON body is docproc refusing the file; anything else means it could not run.
        const body = (err as { stdout?: string }).stdout;
        if (!body?.trim().startsWith('{')) throw err;
        stdout = body;
      }
      // The same body POST /v1/parse returns: { success, data } or { success: false, error }.
      const body = JSON.parse(stdout) as { success: boolean; data?: typeof parsed; error?: { code: string } };
      parsed = body.success && body.data ? body.data : { error: body.error };
    } catch (err) {
      out.push({
        layer: 'formats',
        id: f.file,
        ok: !required,
        detail: `${required ? '' : 'skipped: '}docproc could not run (${(err as Error).message.split('\n')[0]})`,
      });
      continue;
    }
    if (!parsed.locations) {
      out.push({ layer: 'formats', id: f.file, ok: false, detail: `docproc refused the file (${parsed.error?.code})` });
      continue;
    }
    const where = (l: NonNullable<typeof parsed.locations>[number]): string =>
      l.sheet && l.cellRange ? `sheet ${l.sheet}, ${l.cellRange}` : l.slide ? `slide ${l.slide}` : l.page ? `page ${l.page}` : (l.sectionPath ?? 'document');
    const scan = scanForInjection(parsed.locations.map((l) => ({ ordinal: l.ordinal, text: l.text, where: where(l) })));
    const kinds = new Set(scan.signals.map((s) => s.kind));
    const missing = f.expectSignals.filter((k) => !kinds.has(k));
    const located = scan.signals.some((s) => (s.where ?? '').includes(f.where));
    const ok = missing.length === 0 && located;
    out.push({
      layer: 'formats',
      id: f.file,
      ok,
      detail: ok
        ? undefined
        : `${missing.length ? `missing ${missing.join(', ')}; ` : ''}${located ? '' : `no signal located at "${f.where}"; `}found ${scan.signals.map((s) => `${s.kind}@${s.where}`).join(', ') || 'none'}`,
    });
  }
  return out;
}

export async function runInjectionSuite(opts: { requireDocproc?: boolean } = {}): Promise<{ version: string; outcomes: Outcome[]; failed: number }> {
  const file = JSON.parse(readFileSync(join(FIXTURES, 'cases.json'), 'utf-8')) as CaseFile;
  const outcomes: Outcome[] = [...registryOutcomes()];
  for (const text of file.benign) {
    const found = findInjectionSignals(text);
    outcomes.push({
      layer: 'benign',
      id: text.slice(0, 48),
      ok: found.length === 0,
      detail: found.length ? `false alarm: ${found.map((s) => s.kind).join(', ')}` : undefined,
    });
  }
  for (const c of file.cases) outcomes.push(...(await runCase(file, c)));
  if (existsSync(DOCPROC_DIR)) outcomes.push(...formatOutcomes(file, Boolean(opts.requireDocproc)));
  return { version: file.version, outcomes, failed: outcomes.filter((o) => !o.ok).length };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const reportAt = args.includes('--report') ? args[args.indexOf('--report') + 1] : undefined;
  runInjectionSuite({ requireDocproc: args.includes('--require-docproc') })
    .then((r) => {
      const layers = [...new Set(r.outcomes.map((o) => o.layer))];
      for (const layer of layers) {
        const rows = r.outcomes.filter((o) => o.layer === layer);
        const bad = rows.filter((o) => !o.ok);
        const skipped = rows.filter((o) => o.ok && o.detail?.startsWith('skipped')).length;
        console.info(`${bad.length ? 'FAIL' : 'ok  '} ${layer.padEnd(9)} ${rows.length - bad.length}/${rows.length}${skipped ? ` (${skipped} skipped)` : ''}`);
        for (const o of bad) console.info(`       x ${o.id}: ${o.detail ?? ''}`);
      }
      if (reportAt) writeFileSync(reportAt, JSON.stringify(r, null, 2));
      console.info(
        r.failed
          ? `\nPrompt-injection suite ${r.version}: ${r.failed} failure(s). Release blocked.`
          : `\nPrompt-injection suite ${r.version}: all ${r.outcomes.length} checks passed.`,
      );
      process.exit(r.failed ? 1 : 0);
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(2);
    });
}
