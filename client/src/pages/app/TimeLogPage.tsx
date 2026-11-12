import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { FormMessage } from '../../components/auth/AuthUi';
import { usePageMeta } from '../../hooks/usePageMeta';
import { ApiError } from '../../lib/api';
import { Activity, addDays, announceTimeChange, clock, hours, localStart, mondayOf, TIME_CHANGED, timeApi, TimeEntry, WeekSummary } from '../../lib/timeApi';
import { saveBlob } from '../../lib/trustApi';
import { workspaceApi } from '../../lib/workspaceApi';

const card = 'rounded-2xl border border-slate-200 bg-white p-5 shadow-sm';
const secondary = 'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:border-brand-400 disabled:opacity-60';
const message = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);
const DAY = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

interface ProjectOption {
  id: string;
  label: string;
}

/**
 * F4.1 time log (PRD FR-14.20, UI 2.0 §6.1): one click per activity starts a timer (and stops
 * the one running), a weekly summary by day, activity and project, the week's entries (editable)
 * and the CSV export of totals by project and activity. Optional: nothing here is required.
 */
export default function TimeLogPage(): JSX.Element {
  const { authedRequest, session } = useAuth();
  const api = useMemo(() => timeApi(authedRequest), [authedRequest]);
  const ws = useMemo(() => workspaceApi(authedRequest), [authedRequest]);
  usePageMeta({ title: 'Time', description: 'One-click time log by activity, with a weekly summary and CSV export.' });
  const [activities, setActivities] = useState<Activity[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [projectId, setProjectId] = useState('');
  const [current, setCurrent] = useState<TimeEntry | null>(null);
  const [week, setWeek] = useState(() => mondayOf(new Date()));
  const [summary, setSummary] = useState<WeekSummary | null>(null);
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canExportFirm = session?.role === 'owner' || session?.role === 'admin';

  useEffect(() => {
    api.activities().then(setActivities).catch((err: unknown) => setError(message(err, 'Could not load the activities.')));
    ws.listClients()
      .then(async (c) => {
        const lists = await Promise.all(c.items.map((client) => ws.listProjects(client.id).then((p) => p.items.map((x) => ({ id: x.id, label: `${client.name} · ${x.name}` })))));
        setProjects(lists.flat());
      })
      .catch(() => setProjects([]));
  }, [api, ws]);

  const load = useCallback(() => {
    Promise.all([api.current(), api.week(week), api.entries(localStart(week), localStart(addDays(week, 7)))])
      .then(([c, s, e]) => {
        setCurrent(c.entry);
        setSummary(s);
        setEntries(e.items);
      })
      .catch((err: unknown) => setError(message(err, 'Could not load your time.')));
  }, [api, week]);

  useEffect(() => {
    load();
    window.addEventListener(TIME_CHANGED, load);
    return () => window.removeEventListener(TIME_CHANGED, load);
  }, [load]);

  useEffect(() => {
    if (!current) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [current]);

  const act = async (work: () => Promise<string>, fallback: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setNotice(await work());
      announceTimeChange();
    } catch (err) {
      setNotice(null);
      setError(message(err, fallback));
    } finally {
      setBusy(false);
    }
  };

  const start = (a: Activity) => {
    // A repeated click on the activity already running changes nothing.
    if (current?.activityCode === a.code && (current.projectId ?? '') === projectId) return;
    void act(async () => {
      const r = await api.start({ activityCode: a.code, projectId: projectId || null });
      setCurrent(r.entry);
      return r.stopped ? `${a.label} started; ${r.stopped.activityLabel} stopped after ${hours(r.stopped.seconds)}.` : `${a.label} started.`;
    }, 'Could not start the timer.');
  };

  const stop = () => {
    // A repeated click after the timer stopped does nothing.
    if (!current) return;
    void act(async () => {
      const e = await api.stop();
      setCurrent(null);
      return `${e.activityLabel} stopped after ${hours(e.seconds)}.`;
    }, 'Could not stop the timer.');
  };

  const exportCsv = (scope: 'mine' | 'firm') =>
    void act(async () => {
      saveBlob(await api.exportCsv(localStart(week), localStart(addDays(week, 7)), scope), `Time ${week}${scope === 'firm' ? ' firm' : ''}.csv`);
      return 'CSV downloaded.';
    }, 'Could not export the time.');

  const max = Math.max(1, ...(summary?.byDay.map((d) => d.seconds) ?? [1]));

  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-bold text-slate-900">Time</h1>
      <p className="mt-1 max-w-3xl text-sm text-slate-600">
        Optional. One click starts a timer for an activity and stops the one running. The activities are the ones consultants used to say where 510(k) hours go, so
        the totals show where yours go.
      </p>
      <div aria-live="polite" className="mt-3 space-y-2">
        {notice && <FormMessage tone="success">{notice}</FormMessage>}
        {error && <FormMessage tone="error">{error}</FormMessage>}
      </div>

      <section aria-labelledby="timer-title" className={`${card} mt-6`}>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="timer-title" className="text-lg font-semibold text-slate-900">
            {current ? `Running: ${current.activityLabel} · ${clock((now - Date.parse(current.startedAt)) / 1000)}` : 'No timer running'}
          </h2>
          <div className="flex items-end gap-3">
            <label className="text-sm font-medium text-slate-900">
              Project
              <select name="timeProject" className="mt-1 block w-72 rounded-md border border-slate-300 px-2 py-1.5 text-sm" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">No project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            {current && (
              <button type="button" name="stopTimerPage" className={secondary} onClick={stop}>
                Stop timer
              </button>
            )}
          </div>
        </div>
        {current && <p className="mt-1 text-sm text-slate-600">{current.projectName ?? 'No project'}</p>}
        <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {activities.map((a) => {
            const running = current?.activityCode === a.code;
            return (
              <li key={a.code}>
                <button
                  type="button"
                  name={`start-${a.code}`}
                  aria-pressed={running}
                  title={a.description}
                  onClick={() => start(a)}
                  className={`w-full rounded-xl border p-3 text-left text-sm ${running ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200 bg-white hover:border-brand-400'}`}
                >
                  <span className="block font-semibold text-slate-900">{a.label}</span>
                  <span className="block text-xs text-slate-600">{a.description}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="week-title" className={`${card} mt-6`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="week-title" className="text-lg font-semibold text-slate-900">
            Week of {DAY.format(new Date(localStart(week)))}: {hours(summary?.totalSeconds ?? 0)}
          </h2>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={secondary} onClick={() => setWeek((w) => addDays(w, -7))}>
              Previous week
            </button>
            <button type="button" className={secondary} disabled={week === mondayOf(new Date())} onClick={() => setWeek((w) => addDays(w, 7))}>
              Next week
            </button>
            <button type="button" className={secondary} onClick={() => exportCsv('mine')}>
              Export my time (CSV)
            </button>
            {canExportFirm && (
              <button type="button" className={secondary} onClick={() => exportCsv('firm')}>
                Export firm time (CSV)
              </button>
            )}
          </div>
        </div>
        {summary && summary.entryCount === 0 ? (
          <p className="mt-3 text-sm text-slate-600">No time logged this week.</p>
        ) : (
          summary && (
            <div className="mt-4 grid gap-6 lg:grid-cols-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">By day</h3>
                <ul className="mt-2 space-y-1 text-sm">
                  {summary.byDay.map((d) => (
                    <li key={d.date} className="flex items-center gap-2">
                      <span className="w-28 text-slate-600">{DAY.format(new Date(localStart(d.date)))}</span>
                      <span className="h-2 rounded bg-brand-500" style={{ width: `${(d.seconds / max) * 60}%` }} aria-hidden="true" />
                      <span className="text-slate-800">{d.seconds ? hours(d.seconds) : '—'}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-slate-900">By activity</h3>
                <ul className="mt-2 space-y-1 text-sm">
                  {summary.byActivity.map((a) => (
                    <li key={a.code} className="flex justify-between gap-3">
                      <span className="text-slate-700">{a.label}</span>
                      <span className="text-slate-900">{hours(a.seconds)}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-slate-900">By project</h3>
                <ul className="mt-2 space-y-1 text-sm">
                  {summary.byProject.map((p) => (
                    <li key={p.projectId ?? 'none'} className="flex justify-between gap-3">
                      <span className="text-slate-700">{p.projectName}</span>
                      <span className="text-slate-900">{hours(p.seconds)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )
        )}
      </section>

      <section aria-labelledby="entries-title" className={`${card} mt-6`}>
        <h2 id="entries-title" className="text-lg font-semibold text-slate-900">
          Entries · {entries.length}
        </h2>
        {entries.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">No entries this week.</p>
        ) : (
          <table className="mt-3 w-full text-left text-sm">
            <thead className="text-xs uppercase text-slate-500">
              <tr>
                <th className="py-1 pr-3">When</th>
                <th className="py-1 pr-3">Activity</th>
                <th className="py-1 pr-3">Project</th>
                <th className="py-1 pr-3">Time</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="py-2 pr-3 text-slate-700">
                    {DAY.format(new Date(e.startedAt))}, {TIME.format(new Date(e.startedAt))}
                    {e.endedAt ? `–${TIME.format(new Date(e.endedAt))}` : ' (running)'}
                  </td>
                  <td className="py-2 pr-3">
                    <select
                      aria-label={`Activity of the entry at ${TIME.format(new Date(e.startedAt))}`}
                      className="rounded border border-slate-300 px-1 py-0.5"
                      value={e.activityCode}
                      onChange={(ev) => void act(async () => (await api.update(e.id, { activityCode: ev.target.value }), 'Entry changed.'), 'Could not change the entry.')}
                    >
                      {activities.map((a) => (
                        <option key={a.code} value={a.code}>
                          {a.label}
                        </option>
                      ))}
                    </select>
                    {e.editedAt && <span className="ml-1 text-xs text-slate-500">edited</span>}
                  </td>
                  <td className="py-2 pr-3 text-slate-700">{e.projectName ?? 'No project'}</td>
                  <td className="py-2 pr-3 tabular-nums text-slate-900">{e.running ? clock((now - Date.parse(e.startedAt)) / 1000) : hours(e.seconds)}</td>
                  <td className="py-2 text-right">
                    {!e.running && (
                      <button type="button" className="text-sm font-medium text-rose-700 hover:underline" onClick={() => void act(async () => (await api.remove(e.id), 'Entry deleted.'), 'Could not delete the entry.')}>
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </section>
  );
}
