import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { fdaDateLabel } from '../../components/app/FdaDataAsOf';
import { Field, FormMessage } from '../../components/auth/AuthUi';
import { usePageMeta } from '../../hooks/usePageMeta';
import { ApiError } from '../../lib/api';
import { Clearance, Flags, K_NUMBER, PRODUCT_CODE, ProductCode, fdaApi } from '../../lib/fdaApi';

interface Result {
  clearance?: Clearance;
  flags?: Flags;
  productCode?: ProductCode;
  /** The product code a K-number points at may be missing from the classification copy. */
  productCodeMissing?: boolean;
}

const date = (d: string | null): string => (d ? fdaDateLabel(d) : '—');
const asOf = (d: string | null): string => (d ? `FDA data as of ${fdaDateLabel(d)}` : 'FDA data date unknown');

function Card({ title, source, children }: { title: string; source: string; children: ReactNode }): JSX.Element {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm" aria-label={title}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
        <span className="text-xs text-slate-500">{source}</span>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Facts({ rows }: { rows: [string, ReactNode][] }): JSX.Element {
  return (
    <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt className="text-xs uppercase tracking-wide text-slate-500">{k}</dt>
          <dd className="mt-0.5 text-slate-900">{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

const FdaLink = ({ href, children }: { href: string; children: ReactNode }): JSX.Element => (
  <a href={href} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-brand-700 underline hover:text-brand-900">
    {children}
    <span className="sr-only"> (opens the FDA website in a new tab)</span>
  </a>
);

function ClearanceCard({ c }: { c: Clearance }): JSX.Element {
  return (
    <Card title={`${c.kNumber} verified`} source={asOf(c.dataAsOf)}>
      <p className="mb-4 inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-sm font-medium text-emerald-800">
        <span aria-hidden="true">✓</span> Found in the FDA 510(k) database
      </p>
      <Facts
        rows={[
          ['Device', c.deviceName],
          ['Applicant', c.applicant],
          ['Decision', c.decisionDescription ? `${c.decisionDescription} (${c.decisionCode})` : c.decisionCode],
          ['Decision date', date(c.decisionDate)],
          ['Received', date(c.dateReceived)],
          ['Product code', c.productCode],
          ['Device class', c.deviceClass],
          ['Regulation number', c.regulationNumber ? `21 CFR ${c.regulationNumber}` : null],
          ['Type', c.clearanceType],
          ['Summary or statement', c.statementOrSummary],
        ]}
      />
      <div className="mt-4">
        <FdaLink href={c.fdaUrl}>View {c.kNumber} on fda.gov</FdaLink>
      </div>
    </Card>
  );
}

function ProductCodeCard({ p }: { p: ProductCode }): JSX.Element {
  return (
    <Card title={`Product code ${p.productCode}`} source={asOf(p.dataAsOf)}>
      <Facts
        rows={[
          ['Device', p.deviceName],
          ['Device class', p.deviceClass],
          ['Regulation number', p.regulationNumber ? `21 CFR ${p.regulationNumber}` : null],
          ['Specialty', p.medicalSpecialtyDescription],
          ['Review panel', p.reviewPanel],
          ['Implant', p.implant ? 'Yes' : 'No'],
          ['Life-sustaining or supporting', p.lifeSustainSupport ? 'Yes' : 'No'],
          [
            '510(k)s on file',
            `${p.clearances.total.toLocaleString()}${p.clearances.latestDecisionDate ? `, latest ${date(p.clearances.latestDecisionDate)}` : ''}`,
          ],
        ]}
      />
      {p.definition && <p className="mt-4 text-sm text-slate-700">{p.definition}</p>}
      <div className="mt-4">
        <FdaLink href={p.fdaUrl}>View {p.productCode} on fda.gov</FdaLink>
      </div>
    </Card>
  );
}

function FlagsCard({ f }: { f: Flags }): JSX.Element {
  const { recalls, maude } = f;
  return (
    <Card title="Recall and adverse-event flags" source={asOf(recalls.dataAsOf)}>
      {/* UI 2.0 §7.2: a recall-linked device is never shown as clean. */}
      {recalls.total > 0 ? (
        <p role="status" className="inline-flex items-center gap-2 rounded-full bg-red-50 px-3 py-1 text-sm font-semibold text-red-800">
          <span aria-hidden="true">!</span> Recall linked: {recalls.total} recall{recalls.total === 1 ? '' : 's'} name {f.kNumber}
          {recalls.open > 0 ? `, ${recalls.open} still open` : ''}
        </p>
      ) : (
        <p role="status" className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-sm font-medium text-slate-800">
          No FDA recall names {f.kNumber}
        </p>
      )}
      {recalls.items.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Recalls that name {f.kNumber}</caption>
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="py-2 pr-4">
                  Recall
                </th>
                <th scope="col" className="py-2 pr-4">
                  Status
                </th>
                <th scope="col" className="py-2 pr-4">
                  Initiated
                </th>
                <th scope="col" className="py-2">
                  Reason
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 align-top">
              {recalls.items.map((r) => (
                <tr key={r.productResNumber}>
                  <th scope="row" className="py-2 pr-4 font-medium">
                    {r.fdaUrl ? <FdaLink href={r.fdaUrl}>{r.productResNumber}</FdaLink> : r.productResNumber}
                    <span className="block text-xs font-normal text-slate-500">{r.recallingFirm}</span>
                  </th>
                  <td className="py-2 pr-4">{r.recallStatus}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{date(r.dateInitiated)}</td>
                  <td className="py-2 text-slate-700">{r.reasonForRecall}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {recalls.total > recalls.shown && (
            <p className="mt-2 text-xs text-slate-500">
              Showing the {recalls.shown} most recent of {recalls.total}.
            </p>
          )}
        </div>
      )}

      <h3 className="mt-6 text-sm font-semibold text-slate-900">Adverse-event reports (MAUDE){f.productCode ? ` for product code ${f.productCode}` : ''}</h3>
      {maude.tracked ? (
        <>
          <Facts
            rows={[
              ['Reports in the last 12 months', maude.reportsLast12Months?.toLocaleString()],
              ['Reports on file', maude.reportsInCopy?.toLocaleString()],
              ['Reports received', `${date(maude.firstReportDate)} to ${date(maude.lastReportDate)}`],
              ['Data', asOf(maude.dataAsOf)],
            ]}
          />
          <p className="mt-3 text-xs text-slate-500">{maude.note}</p>
        </>
      ) : (
        <p className="mt-2 text-sm text-slate-700">{maude.note}</p>
      )}
    </Card>
  );
}

/** Verify a K-number, look up a product code, and see recall and MAUDE flags (F1.3; UI 2.0 §7.2 flags). */
export default function FdaLookupPage(): JSX.Element {
  usePageMeta({ title: 'FDA lookup', description: 'Verify a K-number, look up a product code and see recall and adverse-event flags.' });
  const { authedRequest } = useAuth();
  const [params, setParams] = useSearchParams();
  const q = (params.get('q') ?? '').trim().toUpperCase();
  const [input, setInput] = useState(q);
  const [inputError, setInputError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    if (!q) return;
    let active = true;
    setBusy(true);
    setError(null);
    setResult(null);
    (async (): Promise<Result> => {
      if (PRODUCT_CODE.test(q)) return { productCode: await fdaApi.productCode(authedRequest, q) };
      const [clearance, flags] = await Promise.all([fdaApi.clearance(authedRequest, q), fdaApi.flags(authedRequest, q)]);
      if (!clearance.productCode) return { clearance, flags };
      try {
        return { clearance, flags, productCode: await fdaApi.productCode(authedRequest, clearance.productCode) };
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return { clearance, flags, productCodeMissing: true };
        throw err;
      }
    })()
      .then((r) => active && setResult(r))
      .catch((err: unknown) => {
        if (!active) return;
        if (err instanceof ApiError && err.status === 404)
          setError(`${q} was not found in our copy of the FDA data. Check the number, or look it up on fda.gov.`);
        else setError(err instanceof ApiError ? err.message : 'The lookup failed. Please try again.');
      })
      .finally(() => active && setBusy(false));
    return () => {
      active = false;
    };
  }, [q, authedRequest]);

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    const v = input.trim().toUpperCase();
    if (!K_NUMBER.test(v) && !PRODUCT_CODE.test(v)) {
      setInputError('Enter a K-number such as K031698, a De Novo number such as DEN260027, or a three-letter product code such as FRN.');
      return;
    }
    setInputError(undefined);
    setParams({ q: v });
  };

  return (
    <section className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-bold text-slate-900">FDA lookup</h1>
      <p className="mt-2 max-w-3xl text-sm text-slate-600">
        Verify a predicate's K-number, check a product code's class and regulation, and see whether FDA has recalls or adverse-event reports on file. Answers
        come from our daily copy of public FDA data and link to the FDA's own record. See{' '}
        <Link to="/app/fda-sources" className="underline">
          FDA data sources
        </Link>
        .
      </p>
      <form onSubmit={onSubmit} noValidate className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="sm:w-96">
          <Field
            name="fdaQuery"
            label="K-number or product code"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            error={inputError}
            hint="For example K031698, DEN260027 or FRN"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-brand-700 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-60 sm:mt-6"
        >
          {busy ? 'Looking up…' : 'Look up'}
        </button>
      </form>

      <div className="mt-8 space-y-6" aria-live="polite" aria-busy={busy}>
        {error && <FormMessage tone="error">{error}</FormMessage>}
        {result?.clearance && <ClearanceCard c={result.clearance} />}
        {result?.flags && <FlagsCard f={result.flags} />}
        {result?.productCode && <ProductCodeCard p={result.productCode} />}
        {result?.productCodeMissing && (
          <p className="text-sm text-slate-600">Product code {result.clearance?.productCode} is not in our copy of the FDA classification database.</p>
        )}
      </div>
      <p className="mt-8 text-xs text-slate-500">
        Source: openFDA (open.fda.gov), U.S. Food and Drug Administration. MedexRegAI is not affiliated with the FDA.
      </p>
    </section>
  );
}
