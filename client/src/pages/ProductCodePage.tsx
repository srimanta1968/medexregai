import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { usePageMeta } from '../hooks/usePageMeta';
import { ApiError } from '../lib/api';
import { CheckResult, CodePage, publicCodesApi } from '../lib/publicCodesApi';

const card = 'rounded-2xl border border-slate-200 bg-white p-6 shadow-sm';
const input = 'mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
const primary = 'rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60';
const fmt = (n: number) => n.toLocaleString('en-US');

function Stat({ value, label }: { value: string; label: string }): JSX.Element {
  return (
    <div className={card}>
      <p className="text-3xl font-bold text-slate-900">{value}</p>
      <p className="mt-1 text-sm text-slate-600">{label}</p>
    </div>
  );
}

function CodeLookup({ initial = '' }: { initial?: string }): JSX.Element {
  const navigate = useNavigate();
  const [code, setCode] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) {
      setError('A product code is three letters, for example FPA.');
      return;
    }
    setError(null);
    navigate(`/codes/${c}`);
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2" aria-label="Look up a product code">
      <label className="text-sm font-medium text-slate-900">
        FDA product code
        <input name="productCodeLookup" className={`${input} w-32 uppercase`} maxLength={3} value={code} onChange={(e) => setCode(e.target.value)} />
      </label>
      <button type="submit" className={primary}>
        Look up
      </button>
      {error && (
        <p role="alert" className="w-full text-sm text-red-700">
          {error}
        </p>
      )}
    </form>
  );
}

function DeviceCheck({ page }: { page: CodePage }): JSX.Element {
  const [description, setDescription] = useState('');
  const [consent, setConsent] = useState(false);
  const [email, setEmail] = useState('');
  const [website, setWebsite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResult(
        await publicCodesApi.check({
          productCode: page.productCode,
          description,
          contactConsent: consent,
          email: consent ? email : undefined,
          website: website || undefined,
        }),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The check could not run. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`${card} mt-10`} aria-labelledby="check-heading">
      <h2 id="check-heading" className="text-xl font-semibold text-slate-900">
        Check your device for free
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        Describe your device. We compare it with what FDA has cleared under {page.productCode} using FDA&apos;s public data only. Nothing is filed and no
        account is needed.
      </p>
      <form onSubmit={(e) => void submit(e)} className="mt-4 space-y-3">
        <label className="block text-sm font-medium text-slate-900">
          What is your device and what does it do?
          <textarea
            name="deviceDescription"
            rows={4}
            maxLength={2000}
            className={input}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input name="contactConsent" type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>Contact me about this check. We keep your email and description only if you tick this.</span>
        </label>
        {consent && (
          <label className="block text-sm font-medium text-slate-900">
            Email
            <input name="checkEmail" type="email" className={input} value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
        )}
        <div className="hidden" aria-hidden="true">
          <label>
            Website
            <input name="website" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
          </label>
        </div>
        <button type="submit" className={primary} disabled={busy}>
          {busy ? 'Checking…' : 'Run the free check'}
        </button>
      </form>
      <div aria-live="polite">
        {error && (
          <p role="alert" className="mt-3 text-sm text-red-700">
            {error}
          </p>
        )}
        {result && (
          <div className="mt-6 space-y-4 border-t border-slate-200 pt-4 text-sm text-slate-800">
            <h3 className="text-lg font-semibold text-slate-900">Your check result</h3>
            <p>
              <strong>{result.productCode}</strong> · {result.deviceName ?? 'Unnamed'} · {result.classLabel ?? 'Class not listed'}
              {result.regulationNumber ? ` · 21 CFR ${result.regulationNumber}` : ''}
            </p>
            {result.pathway && (
              <p>
                <strong>Likely pathway: {result.pathway.label}.</strong> {result.pathway.note}
              </p>
            )}
            <div>
              <p className="font-semibold">Cleared devices with names closest to your description</p>
              {result.similarClearances.length === 0 ? (
                <p className="text-slate-600">None of the 100 most recent clearances under this code share words with your description.</p>
              ) : (
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {result.similarClearances.map((s) => (
                    <li key={s.kNumber}>
                      <a href={s.fdaUrl} className="text-brand-700 hover:underline" target="_blank" rel="noreferrer">
                        {s.kNumber}
                      </a>{' '}
                      {s.deviceName} · {s.applicant} · {s.decisionDate} · {s.match} name match
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-1 text-xs text-slate-500">
                A word match on device names is a starting point for predicate research, not a finding of substantial equivalence.
              </p>
            </div>
            <p>
              Recall events under this code in the last {result.window.years} years: {fmt(result.recalls.total)} ({fmt(result.recalls.open)} with FDA status open)
              {result.recalls.topRootCauses.length > 0 && `; most common root cause: ${result.recalls.topRootCauses[0].cause}`}.
            </p>
            {result.contacted && <p className="font-semibold text-emerald-700">Thanks. We will be in touch by email.</p>}
            <p className="text-xs text-slate-500">
              Sources: FDA classification database (data as of {result.sources.classification.dataAsOf ?? 'unknown'}), {result.sources.clearances.dataset} (as of{' '}
              {result.sources.clearances.dataAsOf ?? 'unknown'}), {result.sources.recalls.dataset} (as of {result.sources.recalls.dataAsOf ?? 'unknown'}).
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * F6.1 public product-code page (UI 2.0 §8.1): what FDA has cleared under a product code, typical
 * time from receipt to decision, recall themes, every figure with its FDA source and date; and the
 * free device check. FDA data only; no sign-in. /codes without a code shows the lookup.
 */
export default function ProductCodePage(): JSX.Element {
  const { code = '' } = useParams();
  const upper = code.toUpperCase();
  const [page, setPage] = useState<CodePage | null>(null);
  const [error, setError] = useState<string | null>(null);

  usePageMeta({
    title: page ? `${page.productCode} ${page.deviceName ?? ''}: FDA clearances and recalls`.trim() : upper ? `FDA product code ${upper}` : 'FDA product codes',
    description: page
      ? `${page.productCode} (${page.deviceName ?? 'device'}, ${page.classLabel ?? 'class not listed'}): ${page.stats.clearances.total} FDA clearances and ${page.stats.recalls.total} recalls in the last ${page.stats.window.years} years, from FDA data.`
      : 'What FDA has cleared under a product code, from FDA data.',
  });

  useEffect(() => {
    if (!upper) return;
    setPage(null);
    setError(null);
    publicCodesApi
      .page(upper)
      .then(setPage)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Could not load FDA data. Please try again.'));
  }, [upper]);

  if (!upper) {
    return (
      <section className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6">
        <h1 className="text-3xl font-bold text-slate-900">FDA product codes</h1>
        <p className="mt-2 max-w-2xl text-slate-600">See what FDA has cleared under a product code, how long decisions took and what was recalled, from FDA&apos;s own data.</p>
        <div className="mt-6">
          <CodeLookup />
        </div>
      </section>
    );
  }

  const s = page?.stats;
  const r = s?.clearances.receiptToDecisionDays;
  return (
    <section className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6">
      <p className="text-sm text-slate-500">
        <Link to="/codes" className="hover:underline">
          FDA product codes
        </Link>{' '}
        / {upper}
      </p>
      {error && (
        <div className="mt-4">
          <p role="alert" className="text-red-700">
            {error}
          </p>
          <div className="mt-4">
            <CodeLookup initial={upper} />
          </div>
        </div>
      )}
      {!page && !error && <p className="mt-6 text-slate-500">Loading FDA data…</p>}
      {page && s && r && (
        <>
          <h1 className="mt-2 text-3xl font-bold text-slate-900">
            Product code {page.productCode}: {page.deviceName ?? 'unnamed device'}
          </h1>
          <p className="mt-2 text-slate-700">
            {[page.classLabel, page.regulationNumber && `21 CFR ${page.regulationNumber}`, page.medicalSpecialty, page.implant && 'implant', page.lifeSustainSupport && 'life-sustaining']
              .filter(Boolean)
              .join(' · ')}
          </p>
          {page.pathway && (
            <p className="mt-2 max-w-3xl text-slate-700">
              <strong>Pathway: {page.pathway.label}.</strong> {page.pathway.note}
            </p>
          )}
          {page.definition && <p className="mt-2 max-w-3xl text-sm text-slate-600">{page.definition}</p>}

          <h2 className="mt-8 text-xl font-semibold text-slate-900">What FDA has cleared, last {s.window.years} years</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Stat value={fmt(s.clearances.total)} label={`clearances, ${s.window.from} to ${s.window.to} (${fmt(page.clearancesAllTime)} in all years)`} />
            <Stat value={r.median === null ? '—' : `${fmt(r.median)} days`} label="median time from FDA receipt to decision" />
            <Stat value={fmt(s.recalls.total)} label={`recall events started (${fmt(s.recalls.open)} with FDA status open; ${fmt(s.recalls.products)} products)`} />
          </div>
          {r.median !== null && (
            <p className="mt-2 text-xs text-slate-500">
              Middle half: {fmt(r.p25 ?? 0)} to {fmt(r.p75 ?? 0)} days, from {fmt(r.n)} decisions. Calendar days from FDA receipt to decision, including any time the
              submission was on hold waiting for the sponsor; this is not FDA&apos;s review-day count.
            </p>
          )}
          {s.clearances.byYear.length > 0 && (
            <table className="mt-4 text-sm">
              <caption className="text-left font-medium text-slate-900">Clearances per year</caption>
              <tbody>
                {s.clearances.byYear.map((y) => (
                  <tr key={y.year}>
                    <th scope="row" className="pr-4 text-left font-normal text-slate-600">
                      {y.year}
                    </th>
                    <td className="text-slate-900">{fmt(y.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {s.clearances.latest.length > 0 && (
            <>
              <h2 className="mt-8 text-xl font-semibold text-slate-900">Most recent clearances</h2>
              <ul className="mt-2 space-y-1 text-sm">
                {s.clearances.latest.map((k) => (
                  <li key={k.kNumber}>
                    <a href={k.fdaUrl} className="font-medium text-brand-700 hover:underline" target="_blank" rel="noreferrer">
                      {k.kNumber}
                    </a>{' '}
                    {k.deviceName} · {k.applicant} · {k.decisionDate}
                    {k.clearanceType ? ` · ${k.clearanceType}` : ''}
                  </li>
                ))}
              </ul>
            </>
          )}

          <h2 className="mt-8 text-xl font-semibold text-slate-900">Recall themes</h2>
          {s.recalls.topRootCauses.length === 0 ? (
            <p className="mt-2 text-sm text-slate-600">No recalls with a recorded root cause in the last {s.window.years} years.</p>
          ) : (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
              {s.recalls.topRootCauses.map((c) => (
                <li key={c.cause}>
                  {c.cause}: {fmt(c.count)}
                </li>
              ))}
            </ul>
          )}

          <DeviceCheck page={page} />

          <p className="mt-6 text-sm text-slate-700">
            Need help with a submission?{' '}
            <Link to={`/introductions?productCode=${page.productCode}`} className="font-medium text-brand-700 hover:underline">
              Ask to be introduced to a regulatory consultant
            </Link>
            .
          </p>

          <section className="mt-10 text-xs text-slate-500" aria-label="Sources">
            <h2 className="font-semibold text-slate-700">Sources</h2>
            <ul className="mt-1 space-y-0.5">
              <li>
                <a href={s.sources.classification.fdaUrl} className="hover:underline" target="_blank" rel="noreferrer">
                  FDA product classification database, {page.productCode}
                </a>{' '}
                (data as of {s.sources.classification.dataAsOf ?? 'unknown'})
              </li>
              <li>
                {s.sources.clearances.dataset} (data as of {s.sources.clearances.dataAsOf ?? 'unknown'})
              </li>
              <li>
                {s.sources.recalls.dataset} (data as of {s.sources.recalls.dataAsOf ?? 'unknown'})
              </li>
            </ul>
            <p className="mt-2">Figures are computed by MedexRegAI from FDA&apos;s public data. They are not FDA statements or regulatory advice.</p>
          </section>
        </>
      )}
    </section>
  );
}
