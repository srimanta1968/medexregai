import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { FormMessage } from '../../components/auth/AuthUi';
import { usePageMeta } from '../../hooks/usePageMeta';
import { ApiError, ApiRequest } from '../../lib/api';
import { saveBlob } from '../../lib/trustApi';

interface ProjectUsage {
  projectId: string;
  projectName: string;
  filesRead: number;
  unitsRead: number;
  draftsGenerated: number;
}

interface ClientUsage {
  workspaceId: string;
  clientName: string;
  projects: ProjectUsage[];
  projectCount: number;
  filesRead: number;
  unitsRead: number;
  draftsGenerated: number;
}

interface UsageSummary {
  from: string;
  to: string;
  clients: ClientUsage[];
  totals: { filesRead: number; unitsRead: number; draftsGenerated: number };
}

type Request = <T>(path: string, init?: Omit<ApiRequest, 'token'>) => Promise<T>;

/** F4.3 usage: server routes in server/src/routes/usage.ts. */
function usageApi(request: Request) {
  const qs = (from: string, to: string, workspaceId?: string) => new URLSearchParams({ from, to, ...(workspaceId ? { workspaceId } : {}) }).toString();
  return {
    summary: (from: string, to: string) => request<UsageSummary>(`/api/usage?${qs(from, to)}`),
    csv: (from: string, to: string, workspaceId?: string) => request<Blob>(`/api/usage/export?${qs(from, to, workspaceId)}`, { responseType: 'blob' }),
  };
}

const card = 'rounded-2xl border border-slate-200 bg-white p-5 shadow-sm';
const input = 'mt-1 block rounded-md border border-slate-300 px-3 py-2 text-sm';
const secondary = 'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:border-brand-400 disabled:opacity-60';
const message = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * F4.3 usage per client for rebilling (PRD v2.0 FR-14.22; UI 2.0 §3 Usage): files read, the
 * pages, sheets or slides in them and drafts generated, per client and project, for a date range,
 * with a CSV per client or for all clients. Owner only.
 */
export default function UsagePage(): JSX.Element {
  const { authedRequest } = useAuth();
  const api = useMemo(() => usageApi(authedRequest), [authedRequest]);
  usePageMeta({ title: 'Usage', description: 'Files read and drafts generated per client, for rebilling.' });
  const now = new Date();
  const [from, setFrom] = useState(iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))));
  const [to, setTo] = useState(iso(now));
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .summary(from, to)
      .then(setSummary)
      .catch((err: unknown) => setError(message(err, 'Could not load usage.')));
  }, [api, from, to]);
  useEffect(load, [load]);

  const download = async (c?: ClientUsage) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      saveBlob(await api.csv(from, to, c?.workspaceId), `Usage ${c ? `${c.clientName} ` : ''}${from} to ${to}.csv`);
      setNotice(c ? `Usage for ${c.clientName} downloaded.` : 'Usage for all clients downloaded.');
    } catch (err) {
      setError(message(err, 'Could not export usage.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-bold text-slate-900">Usage</h1>
      <p className="mt-1 max-w-3xl text-sm text-slate-600">
        What MedexRegAI did for each client: files read, the pages, sheets or slides in them, and section drafts generated. Export a client&apos;s usage to rebill it.
      </p>
      <div aria-live="polite" className="mt-3 space-y-2">
        {notice && <FormMessage tone="success">{notice}</FormMessage>}
        {error && <FormMessage tone="error">{error}</FormMessage>}
      </div>
      <div className="mt-6 flex flex-wrap items-end gap-3">
        <label className="text-sm font-medium text-slate-900">
          From
          <input type="date" name="usageFrom" className={input} value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        </label>
        <label className="text-sm font-medium text-slate-900">
          To
          <input type="date" name="usageTo" className={input} value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />
        </label>
        <button type="button" className={secondary} onClick={() => void download()}>
          Export all clients (CSV)
        </button>
      </div>

      {summary === null ? (
        <p role="status" className="mt-6 text-slate-500">
          Loading…
        </p>
      ) : (
        <>
          <p className="mt-4 text-sm text-slate-700">
            All clients, {summary.from} to {summary.to}: {summary.totals.filesRead} files read ({summary.totals.unitsRead} pages, sheets or slides) ·{' '}
            {summary.totals.draftsGenerated} drafts generated
          </p>
          {summary.clients.length === 0 ? (
            <p className="mt-4 text-sm text-slate-600">No clients yet.</p>
          ) : (
            <div className="mt-4 space-y-4">
              {summary.clients.map((c) => (
                <section key={c.workspaceId} className={card} aria-label={c.clientName}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="text-lg font-semibold text-slate-900">{c.clientName}</h2>
                      <p className="text-sm text-slate-600">
                        {c.projectCount} project{c.projectCount === 1 ? '' : 's'} · {c.filesRead} files read · {c.unitsRead} pages, sheets or slides · {c.draftsGenerated} drafts
                        generated
                      </p>
                    </div>
                    <button type="button" className={secondary} onClick={() => void download(c)}>
                      Export {c.clientName} (CSV)
                    </button>
                  </div>
                  {c.projects.length > 0 && (
                    <table className="mt-3 w-full text-left text-sm">
                      <thead className="text-xs uppercase text-slate-500">
                        <tr>
                          <th className="py-1 pr-3">Project</th>
                          <th className="py-1 pr-3">Files read</th>
                          <th className="py-1 pr-3">Pages, sheets or slides</th>
                          <th className="py-1">Drafts generated</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {c.projects.map((p) => (
                          <tr key={p.projectId}>
                            <td className="py-1.5 pr-3 text-slate-800">{p.projectName}</td>
                            <td className="py-1.5 pr-3">{p.filesRead}</td>
                            <td className="py-1.5 pr-3">{p.unitsRead}</td>
                            <td className="py-1.5">{p.draftsGenerated}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
