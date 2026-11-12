import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { FormMessage } from '../../components/auth/AuthUi';
import { usePageMeta } from '../../hooks/usePageMeta';
import { ApiError } from '../../lib/api';
import { Baseline, Comparison, hrs, percent, pilotApi, PilotReport } from '../../lib/pilotApi';
import { saveBlob } from '../../lib/trustApi';

const card = 'rounded-2xl border border-slate-200 bg-white p-5 shadow-sm';
const primary = 'rounded-md bg-brand-700 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-60';
const secondary = 'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:border-brand-400 disabled:opacity-60';
const input = 'mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
const message = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

function verdict(c: Comparison): JSX.Element {
  if (c.metTarget === null) return <span className="text-slate-500">No baseline to compare</span>;
  return c.metTarget ? <span className="font-semibold text-emerald-700">Target met</span> : <span className="font-semibold text-amber-700">Target not met</span>;
}

function ComparisonCard({ title, gate, c, note }: { title: string; gate: string; c: Comparison; note: string }): JSX.Element {
  return (
    <section className={card} aria-label={title}>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{gate}</p>
      <h2 className="mt-1 text-lg font-semibold text-slate-900">{title}</h2>
      <p className="mt-2 text-3xl font-bold text-slate-900">{c.reduction === null ? '—' : `${percent(c.reduction)} lower`}</p>
      <p className="mt-1 text-sm text-slate-600">
        {hrs(c.actualHours)} logged · baseline {hrs(c.baselineHours)} · proposed target {percent(c.target)} lower
      </p>
      <p className="mt-1 text-sm">{verdict(c)}</p>
      <p className="mt-2 text-xs text-slate-500">{note}</p>
    </section>
  );
}

/** The firm's baseline: hours per A3 activity on a comparable past 510(k). Owners and admins edit it. */
function BaselineEditor({ api, onSaved }: { api: ReturnType<typeof pilotApi>; onSaved: () => void }): JSX.Element {
  const { session } = useAuth();
  const canEdit = session?.role === 'owner' || session?.role === 'admin';
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [basis, setBasis] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .baseline()
      .then((b) => {
        setBaseline(b);
        setBasis(b.basis ?? '');
        setValues(Object.fromEntries(b.activities.map((a) => [a.code, a.hours === null ? '' : String(a.hours)])));
      })
      .catch((err: unknown) => setError(message(err, 'Could not load the baseline.')));
  }, [api]);
  const save = async () => {
    if (busy) return;
    const hours: Record<string, number> = {};
    for (const [code, v] of Object.entries(values)) {
      if (v.trim() === '') continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) {
        setError('Hours must be zero or more.');
        return;
      }
      hours[code] = n;
    }
    setBusy(true);
    setError(null);
    try {
      setBaseline(await api.setBaseline({ basis: basis.trim() || null, hours }));
      setNotice('Baseline saved.');
      onSaved();
    } catch (err) {
      setError(message(err, 'Could not save the baseline.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={card} aria-labelledby="baseline-title">
      <h2 id="baseline-title" className="text-lg font-semibold text-slate-900">
        Firm baseline · {baseline ? hrs(baseline.totalHours) : '…'}
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        Hours your firm spent on each activity on one comparable past 510(k), before MedexRegAI. The same split the validation workbook asked for; the report compares
        logged time against it.
      </p>
      {canEdit ? (
        <>
          <label className="mt-3 block text-sm font-medium text-slate-900">
            What the baseline is
            <input name="baselineBasis" className={input} value={basis} maxLength={200} placeholder="e.g. Traditional 510(k), infusion set, 2025" onChange={(e) => setBasis(e.target.value)} />
          </label>
          <div className="mt-3 grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {baseline?.activities.map((a) => (
              <label key={a.code} className="block text-sm text-slate-800">
                {a.label}
                <input
                  name={`baseline-${a.code}`}
                  inputMode="decimal"
                  className={input}
                  value={values[a.code] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [a.code]: e.target.value }))}
                />
              </label>
            ))}
          </div>
          <button type="button" className={`${primary} mt-4`} onClick={() => void save()}>
            Save baseline
          </button>
        </>
      ) : (
        <p className="mt-2 text-sm text-slate-600">Only an owner or admin can change the baseline.</p>
      )}
      {notice && <FormMessage tone="success">{notice}</FormMessage>}
      {error && <FormMessage tone="error">{error}</FormMessage>}
    </section>
  );
}

/**
 * F4.2 pilot report (PRD v2.0 §12, UI 2.0 §6.1): hours against the firm's own baseline for the
 * whole project (G3') and the drafted sections (G2'), drafts kept without change from the Word
 * re-import (G2'), hours by activity, PDF and CSV, and the firm's RA lead sign-off.
 */
export default function ProjectPilotReportPage(): JSX.Element {
  const { projectId = '' } = useParams();
  const { authedRequest, session } = useAuth();
  const api = useMemo(() => pilotApi(authedRequest, projectId), [authedRequest, projectId]);
  usePageMeta({ title: 'Pilot report', description: 'Hours against the firm baseline and drafts kept without change.' });
  const [report, setReport] = useState<PilotReport | null>(null);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canSign = ['owner', 'admin', 'reviewer'].includes(session?.role ?? '');

  const load = useCallback(() => {
    api
      .report()
      .then(setReport)
      .catch((err: unknown) => setError(message(err, 'Could not load the pilot report.')));
  }, [api]);
  useEffect(load, [load]);

  const download = async (kind: 'pdf' | 'csv') => {
    if (busy || !report) return;
    setBusy(true);
    setError(null);
    try {
      saveBlob(kind === 'pdf' ? await api.pdf() : await api.csv(), `${report.projectName} - Pilot ${kind === 'pdf' ? 'report.pdf' : 'hours by activity.csv'}`);
      setNotice(kind === 'pdf' ? 'Pilot report downloaded.' : 'Hours by activity downloaded.');
    } catch (err) {
      setError(message(err, 'Could not download the report.'));
    } finally {
      setBusy(false);
    }
  };

  const sign = async () => {
    if (busy || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setReport(await api.signOff({ signerTitle: title.trim(), note: note.trim() || null }));
      setNotice('Report signed.');
      setNote('');
    } catch (err) {
      setError(message(err, 'Could not sign the report.'));
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
        › <span aria-current="page">Pilot report</span>
      </nav>
      <h1 className="mt-1 text-2xl font-bold text-slate-900">Pilot report</h1>
      <p className="mt-1 max-w-3xl text-sm text-slate-600">
        Time your firm logged on this project against its own baseline, and how much of each draft came back from Word unchanged. Targets are the proposed pilot targets;
        your firm judges what the numbers show.
      </p>
      <div aria-live="polite" className="mt-3 space-y-2">
        {notice && <FormMessage tone="success">{notice}</FormMessage>}
        {error && <FormMessage tone="error">{error}</FormMessage>}
      </div>
      {report === null ? (
        <p role="status" className="mt-6 text-slate-500">
          Loading…
        </p>
      ) : (
        <>
          <div className="mt-6 flex flex-wrap gap-2">
            <button type="button" className={secondary} onClick={() => void download('pdf')}>
              Download PDF
            </button>
            <button type="button" className={secondary} onClick={() => void download('csv')}>
              Download hours (CSV)
            </button>
            <Link to="/app/time" className={secondary}>
              Log time
            </Link>
          </div>
          <div className="mt-6 grid gap-4 lg:grid-cols-3">
            <ComparisonCard title="Whole project" gate="G3′" c={report.wholeProject} note={`${report.timeEntries} entries by ${report.people} ${report.people === 1 ? 'person' : 'people'}, all activities.`} />
            <ComparisonCard title="Drafted sections" gate="G2′" c={report.draftedSections} note="Write, tabulate and reconcile: the work drafting replaces." />
            <section className={card} aria-label="Drafts kept without change">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">G2′</p>
              <h2 className="mt-1 text-lg font-semibold text-slate-900">Drafts kept without change</h2>
              <p className="mt-2 text-3xl font-bold text-slate-900">{percent(report.acceptance.rate)}</p>
              <p className="mt-1 text-sm text-slate-600">
                {report.acceptance.rate === null
                  ? 'No draft re-imported from Word yet.'
                  : `${report.acceptance.unchanged} of ${report.acceptance.draftedStatements} drafted statements unchanged · ${report.acceptance.edited} edited · ${report.acceptance.deleted} deleted`}
              </p>
              <p className="mt-1 text-sm">
                {report.acceptance.metTarget === null ? (
                  <span className="text-slate-500">Proposed target {percent(report.acceptance.target)}</span>
                ) : report.acceptance.metTarget ? (
                  <span className="font-semibold text-emerald-700">Target met</span>
                ) : (
                  <span className="font-semibold text-amber-700">Target not met</span>
                )}
              </p>
              <p className="mt-2 text-xs text-slate-500">Any edit counts as a change, so this is a floor.</p>
            </section>
          </div>

          <section className={`${card} mt-6`} aria-labelledby="activities-title">
            <h2 id="activities-title" className="text-lg font-semibold text-slate-900">
              Hours by activity
            </h2>
            <table className="mt-3 w-full text-left text-sm">
              <thead className="text-xs uppercase text-slate-500">
                <tr>
                  <th className="py-1 pr-3">Activity</th>
                  <th className="py-1 pr-3">Logged</th>
                  <th className="py-1 pr-3">Baseline</th>
                  <th className="py-1">Lower by</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {report.byActivity.map((a) => (
                  <tr key={a.code}>
                    <td className="py-1.5 pr-3 text-slate-800">{a.label}</td>
                    <td className="py-1.5 pr-3">{hrs(a.actualHours)}</td>
                    <td className="py-1.5 pr-3">{hrs(a.baselineHours)}</td>
                    <td className="py-1.5">{percent(a.reduction)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className={`${card} mt-6`} aria-labelledby="signoff-title">
            <h2 id="signoff-title" className="text-lg font-semibold text-slate-900">
              Sign-off by the firm&apos;s RA lead · {report.signoffs.length}
            </h2>
            {report.signoffs.length === 0 ? (
              <p className="mt-1 text-sm text-slate-600">Not signed yet.</p>
            ) : (
              <ul className="mt-2 space-y-1 text-sm">
                {report.signoffs.map((s) => (
                  <li key={s.id} className="text-slate-800">
                    Signed by {s.signerName}, {s.signerTitle}, {new Date(s.signedAt).toLocaleString()}
                    {s.note && <span className="text-slate-600"> — {s.note}</span>}
                    {!s.current && <span className="ml-1 text-amber-700">(the numbers have changed since)</span>}
                  </li>
                ))}
              </ul>
            )}
            {canSign ? (
              <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
                <label className="block text-sm font-medium text-slate-900">
                  Your title
                  <input name="signerTitle" className={input} value={title} maxLength={200} placeholder="e.g. RA lead" onChange={(e) => setTitle(e.target.value)} />
                </label>
                <label className="block text-sm font-medium text-slate-900">
                  Note (optional)
                  <input name="signoffNote" className={input} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
                </label>
                <button type="button" className={primary} aria-disabled={!title.trim()} onClick={() => void sign()}>
                  Sign the report
                </button>
              </div>
            ) : (
              <p className="mt-2 text-sm text-slate-600">Only someone whose role can review drafts can sign.</p>
            )}
          </section>
        </>
      )}
      <div className="mt-6">
        <BaselineEditor api={api} onSaved={load} />
      </div>
    </section>
  );
}
