import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { Field, FormMessage, SubmitButton } from '../../components/auth/AuthUi';
import { usePageMeta } from '../../hooks/usePageMeta';
import { ApiError } from '../../lib/api';
import {
  AiRoute,
  AiSettings,
  EvalRun,
  EvalScores,
  EvalThresholds,
  FirmProvider,
  PlatformHealth,
  ProjectUsage,
  ROUTE_LABELS,
  aiSettingsApi,
} from '../../lib/aiSettingsApi';
import { formValue, useSubmit } from '../auth/useForm';

const card = 'rounded-2xl border border-slate-200 bg-white p-6 shadow-sm';
const button = 'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:border-brand-400 disabled:opacity-60';
const usd = (n: number) => (n === 0 ? '$0' : n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);
const providerLabel = (kind: string) => (kind === 'ollama' || kind === 'openai_compatible' ? 'Our self-hosted model' : kind);

function HealthCard({ health, onCheck, checking }: { health: PlatformHealth | null; onCheck: () => void; checking: boolean }): JSX.Element {
  const h = health?.platform;
  return (
    <section className={card} aria-labelledby="health-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="health-title" className="text-lg font-semibold text-slate-900">
          Our self-hosted models
        </h2>
        <button type="button" className={button} onClick={onCheck} disabled={checking}>
          {checking ? 'Checking…' : 'Check again'}
        </button>
      </div>
      <div aria-live="polite" className="mt-3">
        {!h ? (
          <p className="text-sm text-slate-600">Checking the models…</p>
        ) : (
          <>
            <p
              className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-semibold ${h.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800'}`}
            >
              <span aria-hidden="true">{h.ok ? '✓' : '!'}</span>
              {h.ok ? `Healthy (${h.latencyMs} ms)` : 'Not reachable or a model is missing'}
            </p>
            {h.error && <p className="mt-2 text-sm text-red-700">{h.error.message}</p>}
            <ul className="mt-3 space-y-1 text-sm text-slate-700">
              {h.models.map((m) => (
                <li key={m.name}>
                  <span className="font-mono">{m.name}</span> — {m.available ? 'available' : 'not available'}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-slate-500">
              {h.provider} at {h.endpoint}. Checked {new Date(health.checkedAt).toLocaleTimeString()}.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

function RoutesTable({ settings }: { settings: AiSettings }): JSX.Element {
  return (
    <section className={card} aria-labelledby="routes-title">
      <h2 id="routes-title" className="text-lg font-semibold text-slate-900">
        Which model answers each step
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        By default every step runs on our own self-hosted models; client files never go to a third party. Registry {settings.registryVersion}.
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">AI steps and the model that answers each</caption>
          <thead className="text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th scope="col" className="py-2 pr-4">
                Step
              </th>
              <th scope="col" className="py-2 pr-4">
                Answered by
              </th>
              <th scope="col" className="py-2">
                Model
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {settings.routes.map((r) => (
              <tr key={r.route}>
                <th scope="row" className="py-2 pr-4 font-medium text-slate-900">
                  {ROUTE_LABELS[r.route]}
                  <span className="block text-xs font-normal text-slate-500">{r.description}</span>
                </th>
                <td className="py-2 pr-4 text-slate-700">
                  {r.source === 'firm'
                    ? `Your provider: ${settings.providers.find((p) => p.id === r.firmProviderId)?.name ?? 'your provider'}`
                    : providerLabel(r.provider)}
                </td>
                <td className="py-2 font-mono text-xs text-slate-700">{r.model}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** How client files are kept from steering the AI (F7.5, NFR-16). */
function GuardPanel({ settings }: { settings: AiSettings }): JSX.Element {
  const total = settings.routes.reduce((t, r) => ({ checked: t.checked + r.guard.last30Days.checked, rejected: t.rejected + r.guard.last30Days.rejected }), {
    checked: 0,
    rejected: 0,
  });
  return (
    <section className={`${card} mt-6`} aria-labelledby="guard-title">
      <h2 id="guard-title" className="text-lg font-semibold text-slate-900">
        Client files cannot instruct the AI
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        Text from client files reaches a model only as marked document content, never as instructions. No step can use tools, so nothing a file says can send,
        change or open anything. Every answer is checked against the step&rsquo;s expected format and the passages it was given; an answer that fails is
        discarded. Checks {settings.outputSchemaVersion}.
      </p>
      <p className="mt-2 text-sm text-slate-700">
        Last 30 days: {total.checked} answer{total.checked === 1 ? '' : 's'} checked, {total.rejected} discarded.
      </p>
      <ul className="mt-4 divide-y divide-slate-100 text-sm">
        {settings.routes.map((r) => (
          <li key={r.route} className="py-2">
            <p className="font-medium text-slate-900">{ROUTE_LABELS[r.route]}</p>
            <p className="text-slate-600">
              Tools: {r.guard.tools.length ? r.guard.tools.join(', ') : 'none'} · Checked: {r.guard.outputCheck}
            </p>
            {r.guard.last30Days.checked > 0 && (
              <p className="text-xs text-slate-500">
                {r.guard.last30Days.checked} checked, {r.guard.last30Days.rejected} discarded, {r.guard.last30Days.flaggedInputs} with instruction-like text in
                the files
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

const pct = (x: number | null | undefined): string => (x === null || x === undefined ? 'n/a' : `${Math.round(x * 1000) / 10}%`);

/** Gold-set scores against the thresholds, optionally beside our own model's (F7.4). */
function ScoreList({ scores, thresholds, baseline }: { scores: EvalScores; thresholds: EvalThresholds; baseline?: EvalScores | null }): JSX.Element {
  const rows: { label: string; value: number | undefined; target: number; extra?: string; base?: number }[] = [
    {
      label: 'Sorting files into sections',
      value: scores.classification?.accuracy,
      target: thresholds.classification,
      base: baseline?.classification?.accuracy,
    },
    {
      label: 'Contradictions found (precision)',
      value: scores.contradiction?.precision,
      target: thresholds.contradiction,
      extra: scores.contradiction ? `recall ${pct(scores.contradiction.recall)}` : undefined,
      base: baseline?.contradiction?.precision,
    },
    {
      label: 'Drafts accepted',
      value: scores.drafting?.acceptance,
      target: thresholds.drafting,
      extra: scores.drafting ? `citation precision ${pct(scores.drafting.citationPrecision)}` : undefined,
      base: baseline?.drafting?.acceptance,
    },
    { label: 'Planted instructions resisted', value: scores.injection?.resistance, target: thresholds.injection, base: baseline?.injection?.resistance },
  ];
  return (
    <ul className="mt-2 space-y-1 text-sm">
      {rows.map((r) => (
        <li key={r.label} className="flex flex-wrap gap-x-2">
          <span className="text-slate-700">{r.label}:</span>
          <span className={`font-semibold ${r.value !== undefined && r.value >= r.target ? 'text-emerald-700' : 'text-red-700'}`}>{pct(r.value)}</span>
          <span className="text-slate-500">
            (target {pct(r.target)}
            {r.extra ? `; ${r.extra}` : ''}
            {r.base !== undefined ? `; our model ${pct(r.base)}` : ''})
          </span>
        </li>
      ))}
    </ul>
  );
}

const EVAL_LABELS: Record<FirmProvider['evalStatus'], string> = {
  not_run: 'Not evaluated yet: drafting stays on our models until it passes',
  running: 'Evaluation running…',
  passed: 'Evaluation passed: this model may draft',
  failed: 'Evaluation not passed: drafting stays on our models',
};

/** Our own model's latest evaluation, and how a firm model is judged (F7.4). */
function EvaluationPanel({ settings }: { settings: AiSettings }): JSX.Element {
  const e = settings.evaluation;
  return (
    <section className={`${card} mt-6`} aria-labelledby="eval-title">
      <h2 id="eval-title" className="text-lg font-semibold text-slate-900">
        How models are evaluated
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        Every model is scored on the same fictional test package (gold sets {e.setsVersion}) through the same steps and checks your files go through. A model
        must reach every target before it may draft.
      </p>
      {e.platform ? (
        <>
          <p className="mt-3 text-sm text-slate-700">
            Our model <span className="font-mono text-xs">{e.platform.model}</span>, evaluated{' '}
            {e.platform.finishedAt ? new Date(e.platform.finishedAt).toLocaleDateString() : ''}: {e.platform.status === 'passed' ? 'passed' : 'not passed'}.
          </p>
          <ScoreList scores={e.platform.scores} thresholds={e.thresholds} />
        </>
      ) : (
        <p className="mt-3 text-sm text-slate-700">Our model has not been evaluated in this environment yet.</p>
      )}
    </section>
  );
}

function ProviderCard({ p, onChanged, evaluation }: { p: FirmProvider; onChanged: () => void; evaluation: AiSettings['evaluation'] }): JSX.Element {
  const { authedRequest } = useAuth();
  const api = useMemo(() => aiSettingsApi(authedRequest), [authedRequest]);
  const [routes, setRoutes] = useState<AiRoute[]>(p.enabledRoutes);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  useEffect(() => setRoutes(p.enabledRoutes), [p.enabledRoutes]);
  const [latest, setLatest] = useState<EvalRun | null>(null);
  useEffect(() => {
    if (p.evalStatus === 'not_run') return;
    let alive = true;
    const load = (): void => {
      api
        .evaluations(p.id)
        .then((r) => alive && setLatest(r.items[0] ?? null))
        .catch(() => undefined);
    };
    load();
    // While it runs, check back every 15 seconds; the worker records the result.
    const timer = p.evalStatus === 'running' ? window.setInterval(() => (load(), onChanged()), 15_000) : undefined;
    return () => {
      alive = false;
      if (timer) window.clearInterval(timer);
    };
  }, [api, p.id, p.evalStatus, onChanged]);

  const act = (work: () => Promise<{ tone: 'error' | 'success'; text: string } | void>) => async () => {
    setBusy(true);
    setMessage(null);
    try {
      const m = await work();
      if (m) setMessage(m);
      onChanged();
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof ApiError ? err.message : 'Something went wrong. Please try again.' });
    } finally {
      setBusy(false);
    }
  };

  const status =
    p.testStatus === 'passed' ? 'Connection test passed' : p.testStatus === 'failed' ? 'Connection failed' : 'Not tested yet: run a connection test before use';
  return (
    <li className="rounded-xl border border-slate-200 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold text-slate-900">{p.name}</h3>
        <span className="text-xs text-slate-500">
          {p.kind === 'anthropic' ? 'Claude API' : 'OpenAI-compatible'} · key ends in {p.keyHint}
        </span>
      </div>
      <p className="mt-1 text-sm text-slate-600">
        <span className="font-mono text-xs">{p.generationModel}</span> at {p.baseUrl}
      </p>
      <p
        className={`mt-2 text-sm font-medium ${p.testStatus === 'passed' ? 'text-emerald-700' : p.testStatus === 'failed' ? 'text-red-700' : 'text-amber-700'}`}
      >
        {status}
      </p>
      {p.testStatus === 'failed' && p.testError && <p className="text-xs text-red-700">{p.testError}</p>}
      <p className={`mt-1 text-sm ${p.evalStatus === 'passed' ? 'text-emerald-700' : p.evalStatus === 'failed' ? 'text-red-700' : 'text-slate-600'}`}>
        {EVAL_LABELS[p.evalStatus]}
      </p>
      {latest && latest.status !== 'queued' && latest.status !== 'running' && (
        <div className="mt-1">
          {latest.status === 'error' ? (
            <p className="text-xs text-red-700">The last evaluation could not finish: {latest.error}</p>
          ) : (
            <ScoreList scores={latest.scores} thresholds={evaluation.thresholds} baseline={evaluation.platform?.scores} />
          )}
        </div>
      )}
      <fieldset className="mt-3" disabled={busy || p.testStatus !== 'passed'}>
        <legend className="text-sm font-medium text-slate-800">Use this provider for</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {(Object.keys(ROUTE_LABELS) as AiRoute[]).map((r) => {
            const needsEval = r === 'draft' && p.evalStatus !== 'passed';
            return (
              <label key={r} className="flex items-start gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={routes.includes(r)}
                  disabled={needsEval}
                  onChange={(e) => setRoutes(e.target.checked ? [...routes, r] : routes.filter((x) => x !== r))}
                />
                <span>
                  {ROUTE_LABELS[r]}
                  {needsEval && <span className="block text-xs text-slate-500">Needs the evaluation check first</span>}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className={button}
          disabled={busy}
          onClick={act(async () => {
            const r = await api.testProvider(p.id);
            return r.passed
              ? { tone: 'success', text: `Connection test passed (${r.latencyMs} ms).` }
              : { tone: 'error', text: `Connection failed: ${r.error?.message ?? 'unknown error'}` };
          })}
        >
          Test connection
        </button>
        <button
          type="button"
          className={button}
          disabled={busy || p.testStatus !== 'passed'}
          onClick={act(async () => {
            await api.setRoutes(p.id, routes);
            return { tone: 'success', text: 'Saved.' };
          })}
        >
          Save steps
        </button>
        <button
          type="button"
          className={button}
          disabled={busy || p.testStatus !== 'passed' || p.evalStatus === 'running'}
          onClick={act(async () => {
            await api.evaluate(p.id);
            return { tone: 'success', text: 'Evaluation queued. It makes about 50 calls to your model and usually takes a few minutes.' };
          })}
        >
          Run evaluation
        </button>
        <button
          type="button"
          className={`${button} text-red-700`}
          disabled={busy}
          onClick={act(async () => {
            if (!window.confirm(`Remove ${p.name}? Its steps go back to our self-hosted models.`)) return;
            await api.deleteProvider(p.id);
          })}
        >
          Remove
        </button>
      </div>
      <div aria-live="polite" className="mt-2">
        {message && <FormMessage tone={message.tone}>{message.text}</FormMessage>}
      </div>
    </li>
  );
}

function AddProviderForm({ onAdded }: { onAdded: () => void }): JSX.Element {
  const { authedRequest } = useAuth();
  const api = useMemo(() => aiSettingsApi(authedRequest), [authedRequest]);
  const { busy, error, run, fieldError } = useSubmit();
  const [done, setDone] = useState<string | null>(null);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    const form = event.currentTarget;
    setDone(null);
    void run(async () => {
      const p = await api.addProvider({
        name: formValue(event, 'providerName'),
        kind: formValue(event, 'providerKind') as FirmProvider['kind'],
        baseUrl: formValue(event, 'providerUrl'),
        generationModel: formValue(event, 'providerModel'),
        apiKey: formValue(event, 'providerKey'),
      });
      form.reset();
      setDone(`${p.name} added. Run a connection test before using it.`);
      onAdded();
    })(event);
  };
  return (
    <form onSubmit={submit} noValidate className="mt-4">
      <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
        <legend className="sr-only">Add your own AI provider</legend>
        <Field name="providerName" label="Name" required error={fieldError('name')} />
        <div>
          <label htmlFor="providerKind" className="block text-sm font-medium text-slate-800">
            Type
          </label>
          <select
            id="providerKind"
            name="providerKind"
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-slate-900"
            defaultValue="openai_compatible"
          >
            <option value="openai_compatible">OpenAI-compatible (e.g. vLLM, Azure OpenAI)</option>
            <option value="anthropic">Claude API</option>
          </select>
        </div>
        <Field name="providerUrl" label="Base URL (https)" required placeholder="https://llm.example.com/v1" error={fieldError('baseUrl')} />
        <Field name="providerModel" label="Model name" required error={fieldError('generationModel')} />
        <div className="sm:col-span-2">
          <Field
            name="providerKey"
            label="API key"
            type="password"
            autoComplete="off"
            required
            hint="Stored encrypted and used only for your firm. It cannot be shown again."
            error={fieldError('apiKey')}
          />
        </div>
        <div className="sm:col-span-2 space-y-2">
          {error && !error.details && <FormMessage tone="error">{error.message}</FormMessage>}
          {done && <FormMessage tone="success">{done}</FormMessage>}
          <SubmitButton busy={busy}>Add provider</SubmitButton>
        </div>
      </fieldset>
    </form>
  );
}

function UsageTable({ items, onEstimate }: { items: ProjectUsage[]; onEstimate: () => void }): JSX.Element {
  const { authedRequest } = useAuth();
  const api = useMemo(() => aiSettingsApi(authedRequest), [authedRequest]);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = (projectId: string) => async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const cost = formValue(event, 'costEstimate').trim();
    const tokens = formValue(event, 'tokenEstimate').trim();
    try {
      await api.setEstimates(projectId, { costEstimateUsd: cost ? Number(cost) : null, tokenEstimate: tokens ? Number(tokens) : null });
      setEditing(null);
      onEstimate();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the estimates.');
    }
  };
  if (!items.length) return <p className="mt-3 text-sm text-slate-600">No projects yet. AI use is counted per project as soon as one exists.</p>;
  return (
    <div className="mt-4 overflow-x-auto">
      {error && <FormMessage tone="error">{error}</FormMessage>}
      <table className="w-full text-left text-sm">
        <caption className="sr-only">AI calls, tokens and cost per project</caption>
        <thead className="text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th scope="col" className="py-2 pr-4">
              Project
            </th>
            <th scope="col" className="py-2 pr-4">
              Calls
            </th>
            <th scope="col" className="py-2 pr-4">
              Tokens
            </th>
            <th scope="col" className="py-2 pr-4">
              Cost
            </th>
            <th scope="col" className="py-2">
              Estimate
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 align-top">
          {items.map((u) => (
            <tr key={u.projectId}>
              <th scope="row" className="py-2 pr-4 font-medium text-slate-900">
                {u.projectName}
                {u.openAlerts.length > 0 && (
                  <span className="mt-1 block w-fit rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-800">
                    Over 2× estimate ({u.openAlerts.join(', ')})
                  </span>
                )}
              </th>
              <td className="py-2 pr-4 text-slate-700">
                {u.calls.toLocaleString()}
                {u.failedCalls > 0 && <span className="block text-xs text-slate-500">{u.failedCalls} failed</span>}
              </td>
              <td className="py-2 pr-4 text-slate-700">{(u.inputTokens + u.outputTokens).toLocaleString()}</td>
              <td className="py-2 pr-4 text-slate-700">
                {usd(u.costUsd)}
                {u.unpricedCalls > 0 && <span className="block text-xs text-slate-500">+ {u.unpricedCalls} calls on your own provider</span>}
              </td>
              <td className="py-2 text-slate-700">
                {editing === u.projectId ? (
                  <form onSubmit={save(u.projectId)} className="flex flex-wrap items-end gap-2">
                    <label className="text-xs">
                      USD
                      <input
                        name="costEstimate"
                        type="number"
                        min="0"
                        step="0.01"
                        defaultValue={u.costEstimateUsd ?? ''}
                        className="mt-1 block w-24 rounded border border-slate-300 px-2 py-1"
                      />
                    </label>
                    <label className="text-xs">
                      Tokens
                      <input
                        name="tokenEstimate"
                        type="number"
                        min="0"
                        step="1"
                        defaultValue={u.tokenEstimate ?? ''}
                        className="mt-1 block w-32 rounded border border-slate-300 px-2 py-1"
                      />
                    </label>
                    <button type="submit" className={button}>
                      Save
                    </button>
                  </form>
                ) : (
                  <>
                    {u.costEstimateUsd !== null ? usd(u.costEstimateUsd) : 'No cost estimate'}
                    {u.tokenEstimate !== null && <span className="block text-xs text-slate-500">{u.tokenEstimate.toLocaleString()} tokens</span>}
                    <button type="button" className={`${button} mt-1`} onClick={() => setEditing(u.projectId)}>
                      Edit estimate
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Firm settings: AI models, bring-your-own model and AI cost (F7.1). Owners and admins. */
export default function AiSettingsPage(): JSX.Element {
  usePageMeta({ title: 'AI models and cost', description: 'Which model answers each AI step, your own model, and AI cost per project.' });
  const { authedRequest } = useAuth();
  const api = useMemo(() => aiSettingsApi(authedRequest), [authedRequest]);
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [health, setHealth] = useState<PlatformHealth | null>(null);
  const [usage, setUsage] = useState<ProjectUsage[]>([]);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .settings()
      .then(setSettings)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Could not load AI settings.'));
    api
      .usage()
      .then((p) => setUsage(p.items))
      .catch(() => undefined);
  }, [api]);
  const check = useCallback(() => {
    setChecking(true);
    api
      .health()
      .then(setHealth)
      .catch(() => setHealth(null))
      .finally(() => setChecking(false));
  }, [api]);
  useEffect(() => {
    load();
    check();
  }, [load, check]);

  return (
    <section className="mx-auto w-full max-w-5xl space-y-6 px-4 py-10 sm:px-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">AI models and cost</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-600">
          See which model answers each step, check that our models are healthy, connect your own model if your firm has one, and follow AI cost per project.
        </p>
      </div>
      {error && <FormMessage tone="error">{error}</FormMessage>}
      <HealthCard health={health} onCheck={check} checking={checking} />
      {settings && <RoutesTable settings={settings} />}
      {settings && <GuardPanel settings={settings} />}
      {settings && <EvaluationPanel settings={settings} />}
      <section className={card} aria-labelledby="byo-title">
        <h2 id="byo-title" className="text-lg font-semibold text-slate-900">
          Your own AI provider
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Optional. Use your firm&apos;s own model for some steps. It must pass a connection test first, and drafting also needs our evaluation check. Your key
          is used only for your firm.
        </p>
        {settings && settings.providers.length > 0 && (
          <ul className="mt-4 space-y-3">
            {settings.providers.map((p) => (
              <ProviderCard key={p.id} p={p} onChanged={load} evaluation={settings.evaluation} />
            ))}
          </ul>
        )}
        <AddProviderForm onAdded={load} />
      </section>
      <section className={card} aria-labelledby="usage-title">
        <h2 id="usage-title" className="text-lg font-semibold text-slate-900">
          AI cost by project
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Our self-hosted models cost nothing per call; tokens are still counted. We alert you when a project passes twice its estimate.
        </p>
        <UsageTable items={usage} onEstimate={load} />
      </section>
    </section>
  );
}
