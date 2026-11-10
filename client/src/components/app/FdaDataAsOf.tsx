import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';

export interface FdaDatasetMeta {
  dataset: string;
  sourceLastUpdated: string | null;
  lastSyncedAt: string | null;
  lastRunStatus: 'running' | 'succeeded' | 'failed' | null;
  records: number;
}

export interface FdaMeta {
  dataAsOf: string | null;
  datasets: FdaDatasetMeta[];
}

/** Long date without a time zone shift (openFDA dates are calendar dates). */
export const fdaDateLabel = (iso: string): string =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Shared loader so several badges on one page share one request. */
let cached: Promise<FdaMeta> | null = null;
export function loadFdaMeta(request: <T>(path: string) => Promise<T>, refresh = false): Promise<FdaMeta> {
  if (!cached || refresh) {
    cached = request<FdaMeta>('/api/fda/meta').catch((err: unknown) => {
      cached = null;
      throw err;
    });
  }
  return cached;
}

/** "FDA data as of 20 Oct 2026" on every view that shows FDA-derived information. */
export default function FdaDataAsOf(): JSX.Element {
  const { authedRequest } = useAuth();
  const [meta, setMeta] = useState<FdaMeta | null>(null);
  const [failed, setFailed] = useState<boolean>(false);

  useEffect(() => {
    let active = true;
    loadFdaMeta(authedRequest)
      .then((m) => {
        if (active) setMeta(m);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [authedRequest]);

  const text = failed
    ? 'FDA data date unavailable'
    : !meta
      ? 'Checking FDA data date…'
      : meta.dataAsOf
        ? `FDA data as of ${fdaDateLabel(meta.dataAsOf)}`
        : 'FDA data not loaded yet';
  return (
    <Link
      to="/app/fda-sources"
      className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:border-brand-400"
      title="Source: openFDA. Our copy is refreshed daily; click for details."
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${meta?.dataAsOf ? 'bg-emerald-500' : 'bg-amber-500'}`} />
      {text}
    </Link>
  );
}
