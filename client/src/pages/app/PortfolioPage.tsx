import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { FormMessage } from '../../components/auth/AuthUi';
import { usePageMeta } from '../../hooks/usePageMeta';
import { ApiError } from '../../lib/api';
import { dueText, Portfolio, portfolioApi, PortfolioRow, STATUS_FILTERS, StatusFilter } from '../../lib/portfolioApi';

const card = 'rounded-2xl border border-slate-200 bg-white p-5 shadow-sm';
const chip = 'rounded-full border px-3 py-1 text-sm font-medium';
const RISK_CLASS: Record<PortfolioRow['riskLevel'], string> = {
  high: 'bg-red-50 text-red-800 border-red-200',
  medium: 'bg-amber-50 text-amber-800 border-amber-200',
  low: 'bg-slate-50 text-slate-700 border-slate-200',
};
const RISK_LABEL: Record<PortfolioRow['riskLevel'], string> = { high: 'High risk', medium: 'Medium risk', low: 'Low risk' };

function Tile({ value, label, tone }: { value: number; label: string; tone?: 'alert' }): JSX.Element {
  return (
    <div className={card}>
      <p className={`text-3xl font-bold ${tone === 'alert' && value > 0 ? 'text-red-700' : 'text-slate-900'}`}>{value}</p>
      <p className="mt-1 text-sm text-slate-600">{label}</p>
    </div>
  );
}

/**
 * F5.3 portfolio (UI 2.0 §7.3): every submission in the firm at a glance, with totals for active
 * projects, open client requests, open high problems and running FDA clocks; each row shows the
 * stage, next action, due date (an open FDA letter's response date wins over the target date) and
 * risks. Soonest due first.
 */
export default function PortfolioPage(): JSX.Element {
  const { authedRequest } = useAuth();
  const api = useMemo(() => portfolioApi(authedRequest), [authedRequest]);
  usePageMeta({ title: 'Portfolio', description: 'All clients and projects at a glance.' });

  const [status, setStatus] = useState<StatusFilter>('open');
  const [data, setData] = useState<Portfolio | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    (cursor?: string) => {
      setLoading(true);
      setError(null);
      api
        .get({ status, cursor })
        .then((r) => setData((prev) => (cursor && prev ? { ...r, items: [...prev.items, ...r.items] } : r)))
        .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Could not load the portfolio.'))
        .finally(() => setLoading(false));
    },
    [api, status],
  );
  useEffect(() => load(), [load]);

  const t = data?.totals;
  const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-bold text-slate-900">Portfolio</h1>
      <p className="mt-1 max-w-3xl text-sm text-slate-600">
        Every submission in your firm, soonest due first. An open FDA letter&apos;s response date takes the place of the project&apos;s target date.
      </p>
      <div aria-live="polite" className="mt-3">
        {error && <FormMessage tone="error">{error}</FormMessage>}
      </div>

      {t && (
        <section aria-label="Totals" className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Tile value={t.activeProjects} label={`active 510(k) ${plural(t.activeProjects, 'project')}`} />
          <Tile value={t.openRequests} label={`open client ${plural(t.openRequests, 'request')}`} />
          <Tile value={t.highProblems} label={`high ${plural(t.highProblems, 'problem')} open`} tone="alert" />
          <Tile value={t.fdaClocksRunning} label={`FDA ${plural(t.fdaClocksRunning, 'clock')} running`} tone="alert" />
        </section>
      )}
      {t && t.overdue > 0 && (
        <p className="mt-3 text-sm font-semibold text-red-700">
          {t.overdue} {plural(t.overdue, 'project is', 'projects are')} past due.
        </p>
      )}

      <div className="mt-6 flex flex-wrap gap-2" role="group" aria-label="Show projects">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            aria-pressed={status === f.key}
            className={`${chip} ${status === f.key ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 bg-white text-slate-700 hover:border-brand-400'}`}
            onClick={() => setStatus(f.key)}
          >
            Show {f.label.toLowerCase()}
          </button>
        ))}
      </div>

      {data && data.items.length === 0 && !loading && (
        <p className="mt-6 text-sm text-slate-600">
          No projects here yet. Add one from{' '}
          <Link to="/app/clients" className="text-brand-700 hover:underline">
            Clients and projects
          </Link>
          .
        </p>
      )}

      {data && data.items.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <caption className="sr-only">Submissions, soonest due first</caption>
            <thead className="text-xs uppercase text-slate-500">
              <tr>
                <th scope="col" className="py-2 pr-3">Client</th>
                <th scope="col" className="py-2 pr-3">Project</th>
                <th scope="col" className="py-2 pr-3">Stage</th>
                <th scope="col" className="py-2 pr-3">Next action</th>
                <th scope="col" className="py-2 pr-3">Due</th>
                <th scope="col" className="py-2">Risks</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 align-top">
              {data.items.map((r) => (
                <tr key={r.projectId}>
                  <td className="py-3 pr-3 text-slate-800">{r.clientName}</td>
                  <td className="py-3 pr-3">
                    <Link to={`/app/projects/${r.projectId}`} className="font-medium text-brand-700 hover:underline">
                      {r.projectName}
                    </Link>
                    <span className="block text-xs text-slate-500">{r.deviceName}</span>
                  </td>
                  <td className="py-3 pr-3 text-slate-800">{r.stageLabel}</td>
                  <td className="py-3 pr-3 text-slate-800">{r.nextAction ?? '—'}</td>
                  <td className={`py-3 pr-3 ${r.due?.overdue ? 'font-semibold text-red-700' : 'text-slate-800'}`}>{dueText(r.due)}</td>
                  <td className="py-3">
                    <span className={`${chip} inline-block border text-xs ${RISK_CLASS[r.riskLevel]}`}>{RISK_LABEL[r.riskLevel]}</span>
                    {r.risks.length > 0 && (
                      <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
                        {r.risks.map((x) => (
                          <li key={x}>{x}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data?.nextCursor && (
        <button
          type="button"
          disabled={loading}
          className="mt-4 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:border-brand-400"
          onClick={() => load(data.nextCursor ?? undefined)}
        >
          More projects
        </button>
      )}
      {loading && <p className="mt-4 text-sm text-slate-500">Loading…</p>}
    </section>
  );
}
