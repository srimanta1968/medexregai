import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import DataTable, { Column } from '../../components/common/DataTable';
import { usePageMeta } from '../../hooks/usePageMeta';
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

const COLUMNS: Column<PortfolioRow>[] = [
  { key: 'client', header: 'Client', cell: (r) => r.clientName },
  {
    key: 'project',
    header: 'Project',
    cell: (r) => (
      <>
        <Link to={`/app/projects/${r.projectId}`} className="font-medium text-brand-700 hover:underline">
          {r.projectName}
        </Link>
        <span className="block text-xs text-slate-500">{r.deviceName}</span>
      </>
    ),
  },
  { key: 'stage', header: 'Stage', cell: (r) => r.stageLabel },
  { key: 'next', header: 'Next action', cell: (r) => r.nextAction ?? '—' },
  {
    key: 'due',
    header: 'Due',
    cell: (r) => <span className={r.due?.overdue ? 'font-semibold text-red-700' : undefined}>{dueText(r.due)}</span>,
  },
  {
    key: 'risks',
    header: 'Risks',
    className: 'py-3',
    cell: (r) => (
      <>
        <span className={`${chip} inline-block border text-xs ${RISK_CLASS[r.riskLevel]}`}>{RISK_LABEL[r.riskLevel]}</span>
        {r.risks.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
            {r.risks.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        )}
      </>
    ),
  },
];

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
  const [totals, setTotals] = useState<Portfolio['totals'] | null>(null);
  const load = useCallback((cursor?: string) => api.get({ status, cursor }), [api, status]);
  const onFirstPage = useCallback((p: Portfolio) => setTotals(p.totals), []);

  const t = totals;
  const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-bold text-slate-900">Portfolio</h1>
      <p className="mt-1 max-w-3xl text-sm text-slate-600">
        Every submission in your firm, soonest due first. An open FDA letter&apos;s response date takes the place of the project&apos;s target date.
      </p>

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

      <DataTable<PortfolioRow, Portfolio>
        columns={COLUMNS}
        rowKey={(r) => r.projectId}
        load={load}
        resetKey={status}
        onFirstPage={onFirstPage}
        caption="Submissions, soonest due first"
        minWidth="760px"
        moreLabel="More projects"
        errorText="Could not load the portfolio."
        empty={
          <p>
            No projects here yet. Add one from{' '}
            <Link to="/app/clients" className="text-brand-700 hover:underline">
              Clients and projects
            </Link>
            .
          </p>
        }
      />
    </section>
  );
}
