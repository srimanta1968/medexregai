import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { FormMessage } from '../../components/auth/AuthUi';
import { usePageMeta } from '../../hooks/usePageMeta';
import { ApiError } from '../../lib/api';
import { DecidePanel } from '../../components/app/DecidePanel';
import { Decision, ProblemDetail, ProblemStatus, ProblemSummary, Severity, problemsApi } from '../../lib/problemsApi';

const card = 'rounded-2xl border border-slate-200 bg-white p-6 shadow-sm';
const button = 'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:border-brand-400 disabled:opacity-60';
const SEVERITY_LABEL: Record<Severity, string> = { high: 'High', medium: 'Med', low: 'Low' };
const SEVERITY_TONE: Record<Severity, string> = { high: 'bg-red-100 text-red-900', medium: 'bg-amber-100 text-amber-900', low: 'bg-slate-100 text-slate-700' };
const STATUS_LABEL: Record<ProblemStatus, string> = { open: 'Open', resolved: 'Resolved', dismissed: 'Dismissed' };
const message = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

function SeverityBadge({ severity }: { severity: Severity }): JSX.Element {
  return <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${SEVERITY_TONE[severity]}`}>{SEVERITY_LABEL[severity]}</span>;
}

/** Both sources side by side: file, version, page and the exact words (UI 2.0 §4.3). */
function SourcesSideBySide({ problem }: { problem: ProblemDetail }): JSX.Element {
  if (problem.kind === 'gap') {
    return (
      <div className="mt-3 rounded-xl bg-slate-50 p-4 text-sm">
        <p className="font-medium text-slate-900">Missing evidence</p>
        <p className="mt-1 text-slate-700">{problem.detail ?? 'No file in this project is filed under this section.'}</p>
      </div>
    );
  }
  return (
    <div className="mt-3 grid gap-3 md:grid-cols-2">
      {problem.sources.map((s, i) => (
        <figure key={s.factId} className="rounded-xl bg-slate-50 p-4 text-sm">
          <figcaption className="text-slate-600">
            <span className="font-semibold text-slate-900">Source {i + 1}</span> · {s.fileName}
            {s.revisionLabel ? ` · rev ${s.revisionLabel}` : ''} · version {s.versionNo} · {s.where}
            {s.current ? ' · current' : ' · not the current version'}
          </figcaption>
          <blockquote className="mt-2 border-l-4 border-amber-300 pl-3 text-slate-900">{s.quote}</blockquote>
          <p className="mt-2 text-slate-600">
            {s.label}: <span className="font-medium text-slate-900">{s.value}</span>
          </p>
        </figure>
      ))}
    </div>
  );
}

/**
 * F2.3 Problems (UI 2.0 §4.3): gaps and contradictions found in the client's files,
 * highest severity first; opening one shows both sources side by side. The consultant
 * decides; nothing in the client's documents is changed.
 */
export default function ProjectProblemsPage(): JSX.Element {
  const { projectId = '' } = useParams();
  const { authedRequest } = useAuth();
  const api = useMemo(() => problemsApi(authedRequest, projectId), [authedRequest, projectId]);
  usePageMeta({ title: 'Problems', description: 'Missing evidence and contradictions between the client documents.' });
  const [status, setStatus] = useState<ProblemStatus | 'all'>('open');
  const [items, setItems] = useState<ProblemSummary[] | null>(null);
  const [counts, setCounts] = useState<{ contradictions: number; gaps: number; open: number } | null>(null);
  const [open, setOpen] = useState<ProblemDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .list(status)
      .then((p) => {
        setItems(p.items);
        setCounts(p.counts);
      })
      .catch((err: unknown) => setError(message(err, 'Could not load the problems.')));
  }, [api, status]);
  useEffect(load, [load]);

  const show = async (id: string) => {
    setError(null);
    try {
      setOpen(await api.get(id));
    } catch (err) {
      setError(message(err, 'Could not open the problem.'));
    }
  };
  const decide = async (decision: Decision, note: string) => {
    if (!open) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const d = await api.decide(open.id, decision, note);
      setOpen(d);
      setNotice(
        d.status === 'dismissed'
          ? 'Dismissed. Your note is kept in the project record.'
          : d.requestItemId
            ? 'Resolved and added to the draft client request. Nothing is sent until you approve the request.'
            : 'Resolved. Your decision and reason are kept in the project record.',
      );
      load();
    } catch (err) {
      setError(message(err, 'Could not save the decision.'));
    } finally {
      setBusy(false);
    }
  };
  const recheck = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await api.check();
      setNotice(`Checked: ${r.contradictions} contradiction(s) and ${r.gaps} gap(s) found.`);
      load();
    } catch (err) {
      setError(message(err, 'Could not check the project.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
      <nav aria-label="Breadcrumb" className="text-sm text-slate-500">
        <Link to={`/app/projects/${projectId}`} className="hover:underline">
          Project
        </Link>{' '}
        › <span aria-current="page">Problems</span>
      </nav>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-slate-900">Problems</h1>
        <button type="button" className={button} disabled={busy} onClick={() => void recheck()}>
          {busy ? 'Checking…' : 'Check again'}
        </button>
      </div>
      <p className="mt-1 text-sm text-slate-600">
        {counts ? `${counts.contradictions} contradiction(s) · ${counts.gaps} missing item(s) open. ` : ''}Every finding shows its sources so it can be checked in
        seconds. You decide; nothing in the client&apos;s documents is changed.
      </p>
      <div aria-live="polite" className="mt-3 space-y-2">
        {notice && <FormMessage tone="success">{notice}</FormMessage>}
        {error && <FormMessage tone="error">{error}</FormMessage>}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_2fr]">
        <section className={card} aria-labelledby="all-title">
          <div className="flex items-center justify-between gap-2">
            <h2 id="all-title" className="text-lg font-semibold text-slate-900">
              All problems
            </h2>
            <label className="text-sm">
              <span className="sr-only">Show</span>
              <select name="problemStatus" className="rounded-md border border-slate-300 px-2 py-1" value={status} onChange={(e) => setStatus(e.target.value as ProblemStatus | 'all')}>
                <option value="open">Open</option>
                <option value="resolved">Resolved</option>
                <option value="dismissed">Dismissed</option>
                <option value="all">All</option>
              </select>
            </label>
          </div>
          {items === null ? (
            <p role="status" className="mt-3 text-slate-500">
              Loading…
            </p>
          ) : items.length === 0 ? (
            <p className="mt-3 text-sm text-slate-600">{status === 'open' ? 'No open problems. Add files or check again after the client sends more.' : 'Nothing here.'}</p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100">
              {items.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className={`flex w-full items-start gap-2 py-2 text-left text-sm hover:bg-slate-50 ${open?.id === p.id ? 'bg-slate-50' : ''}`}
                    aria-current={open?.id === p.id ? 'true' : undefined}
                    onClick={() => void show(p.id)}
                  >
                    <SeverityBadge severity={p.severity} />
                    <span>
                      <span className="text-slate-900">{p.title}</span>
                      {p.status !== 'open' && <span className="block text-xs text-slate-500">{STATUS_LABEL[p.status]}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={card} aria-labelledby="problem-title" aria-live="polite">
          {!open ? (
            <p className="text-sm text-slate-600">Pick a problem to see its sources side by side.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <SeverityBadge severity={open.severity} />
                <h2 id="problem-title" className="text-lg font-semibold text-slate-900">
                  {open.title}
                </h2>
              </div>
              <p className="mt-1 text-sm text-slate-600">
                {open.kind === 'contradiction' ? 'Contradiction' : 'Gap'} · {open.severityReason}
              </p>
              <SourcesSideBySide problem={open} />
              {open.status !== 'open' ? (
                <p className="mt-4 text-sm text-slate-700">
                  {STATUS_LABEL[open.status]} by {open.decidedBy ?? 'a consultant'}: {open.decisionNote}
                  {open.requestItemId && (
                    <>
                      {' '}
                      <Link to={`/app/projects/${projectId}/requests`} className="text-brand-700 hover:underline">
                        See the client request
                      </Link>
                    </>
                  )}
                </p>
              ) : (
                <DecidePanel key={open.id} problem={open} busy={busy} onDecide={(d, n) => void decide(d, n)} />
              )}
            </>
          )}
        </section>
      </div>
    </section>
  );
}
