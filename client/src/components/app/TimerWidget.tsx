import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { announceTimeChange, clock, TIME_CHANGED, timeApi, TimeEntry } from '../../lib/timeApi';

/**
 * F4.1 one-click timer in the top bar: the running activity and its time, with Stop; otherwise
 * a link to the time page where each activity starts with one click. Time capture is optional
 * (PRD FR-14.20), so the widget is small and never in the way.
 */
export default function TimerWidget(): JSX.Element {
  const { authedRequest } = useAuth();
  const api = useMemo(() => timeApi(authedRequest), [authedRequest]);
  const [entry, setEntry] = useState<TimeEntry | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .current()
      .then((r) => setEntry(r.entry))
      .catch(() => setEntry(null))
      .finally(() => setLoaded(true));
  }, [api]);

  useEffect(() => {
    load();
    window.addEventListener(TIME_CHANGED, load);
    const refresh = window.setInterval(load, 60_000);
    return () => {
      window.removeEventListener(TIME_CHANGED, load);
      window.clearInterval(refresh);
    };
  }, [load]);

  useEffect(() => {
    if (!entry) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [entry]);

  const stop = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.stop();
    } catch {
      // Already stopped elsewhere: the refresh below shows the real state.
    } finally {
      setBusy(false);
      announceTimeChange();
    }
  };

  if (!loaded) return <span className="hidden" />;
  if (!entry) {
    return (
      <Link to="/app/time" className="rounded-md border border-slate-300 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50" title="Log time against an activity">
        Start timer
      </Link>
    );
  }
  const elapsed = (now - Date.parse(entry.startedAt)) / 1000;
  return (
    <span className="flex items-center gap-2 rounded-md bg-emerald-50 px-2 py-1 text-emerald-900" role="status" aria-live="off">
      <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
      <Link to="/app/time" className="font-medium hover:underline" title={entry.projectName ?? 'No project'}>
        {entry.activityLabel}
      </Link>
      <span className="tabular-nums">{clock(elapsed)}</span>
      <button type="button" name="stopTimer" onClick={() => void stop()} className="rounded border border-emerald-300 bg-white px-2 py-0.5 text-xs font-semibold text-emerald-900 hover:bg-emerald-100">
        Stop
      </button>
    </span>
  );
}
