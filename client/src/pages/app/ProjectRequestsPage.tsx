import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { FormMessage } from '../../components/auth/AuthUi';
import { usePageMeta } from '../../hooks/usePageMeta';
import { ApiError } from '../../lib/api';
import { IssuedLink, RequestDetail, RequestSummary, requestsApi } from '../../lib/requestsApi';

/**
 * Client requests (F2.4): draft a request for missing evidence, edit it, approve it.
 * Nothing reaches the client before approval; approving issues an expiring upload link
 * (shown once) and emails the message when there is a recipient address. Each item shows
 * its status until a file arrives against it.
 */

const card = 'rounded-2xl border border-slate-200 bg-white p-6 shadow-sm';
const button = 'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:border-brand-400 disabled:opacity-60';
const primary = 'rounded-md bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60';
const input =
  'mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600';

const STATUS_LABELS: Record<RequestSummary['status'], string> = { draft: 'Draft, not sent', open: 'Approved, waiting for files', closed: 'Closed' };
const EMAIL_LABELS: Record<RequestSummary['emailStatus'], string> = { not_sent: 'Not emailed', sent: 'Emailed', failed: 'Email failed' };

function Composer({ projectId, onCreated }: { projectId: string; onCreated: (r: RequestDetail) => void }): JSX.Element {
  const { authedRequest } = useAuth();
  const api = useMemo(() => requestsApi(authedRequest), [authedRequest]);
  const [items, setItems] = useState([{ label: '', detail: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const value = (k: string): string => String(form.get(k) ?? '').trim();
    setBusy(true);
    setError(null);
    try {
      const created = await api.create(projectId, {
        title: value('requestTitle'),
        message: value('requestMessage'),
        recipientName: value('recipientName') || null,
        recipientEmail: value('recipientEmail') || null,
        items: items.filter((i) => i.label.trim()).map((i) => ({ label: i.label.trim(), detail: i.detail.trim() || undefined })),
      });
      (e.target as HTMLFormElement).reset();
      setItems([{ label: '', detail: '' }]);
      onCreated(created);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The request could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={card} aria-labelledby="compose-title">
      <h2 id="compose-title" className="text-lg font-semibold text-slate-900">
        New request
      </h2>
      <p className="mt-1 text-sm text-slate-600">It is saved as a draft. Nothing reaches the client until you approve it.</p>
      <form className="mt-4 space-y-3" onSubmit={(e) => void onSubmit(e)}>
        <label className="block text-sm font-medium text-slate-800">
          Title
          <input name="requestTitle" required maxLength={200} className={input} placeholder="Missing evidence for the 510(k)" />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-medium text-slate-800">
            Client contact name
            <input name="recipientName" maxLength={200} className={input} />
          </label>
          <label className="block text-sm font-medium text-slate-800">
            Client email (optional)
            <input name="recipientEmail" type="email" maxLength={320} className={input} />
          </label>
        </div>
        <label className="block text-sm font-medium text-slate-800">
          Message to the client
          <textarea name="requestMessage" rows={4} maxLength={5000} className={input} placeholder="Please upload the documents below." />
        </label>
        <fieldset>
          <legend className="text-sm font-medium text-slate-800">What you are asking for</legend>
          <ol className="mt-2 space-y-2">
            {items.map((it, i) => (
              <li key={i} className="grid gap-2 sm:grid-cols-2">
                <label className="block">
                  <span className="sr-only">Item {i + 1}</span>
                  <input
                    name={`itemLabel${i + 1}`}
                    value={it.label}
                    maxLength={200}
                    className={input}
                    placeholder="e.g. EO residuals report"
                    onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                  />
                </label>
                <label className="block">
                  <span className="sr-only">Item {i + 1} details</span>
                  <input
                    name={`itemDetail${i + 1}`}
                    value={it.detail}
                    maxLength={1000}
                    className={input}
                    placeholder="Details (optional)"
                    onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, detail: e.target.value } : x)))}
                  />
                </label>
              </li>
            ))}
          </ol>
          <button type="button" className={`${button} mt-2`} onClick={() => setItems([...items, { label: '', detail: '' }])} disabled={items.length >= 50}>
            Add item
          </button>
        </fieldset>
        {error && <FormMessage tone="error">{error}</FormMessage>}
        <button type="submit" className={primary} disabled={busy}>
          Save draft
        </button>
      </form>
    </section>
  );
}

function RequestPanel({ request, onChanged }: { request: RequestDetail; onChanged: (r: RequestDetail) => void }): JSX.Element {
  const { authedRequest } = useAuth();
  const api = useMemo(() => requestsApi(authedRequest), [authedRequest]);
  const [issued, setIssued] = useState<IssuedLink['link'] | null>(null);
  const [message, setMessage] = useState(request.message);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  useEffect(() => setMessage(request.message), [request.id, request.message]);

  const act = async (work: () => Promise<{ text: string } | void>): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      const r = await work();
      if (r) setNote({ tone: 'success', text: r.text });
    } catch (err) {
      setNote({ tone: 'error', text: err instanceof ApiError ? err.message : 'Something went wrong. Please try again.' });
    } finally {
      setBusy(false);
    }
  };
  const days = (): number => Number((document.getElementById('linkDays') as HTMLSelectElement | null)?.value ?? 14);

  return (
    <section className={`${card} mt-6`} aria-labelledby="request-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="request-title" className="text-lg font-semibold text-slate-900">
          {request.title}
        </h2>
        <span className="text-sm text-slate-600">{STATUS_LABELS[request.status]}</span>
      </div>
      <p className="mt-1 text-sm text-slate-600">
        {request.recipientName || request.recipientEmail
          ? `For ${[request.recipientName, request.recipientEmail].filter(Boolean).join(', ')}`
          : 'No recipient set'}
        {request.status !== 'draft' && ` · ${EMAIL_LABELS[request.emailStatus]}`}
        {request.emailStatus === 'failed' && request.emailError ? `: ${request.emailError}` : ''}
      </p>

      {request.status === 'draft' ? (
        <label className="mt-4 block text-sm font-medium text-slate-800">
          Message (edit before approving)
          <textarea name="draftMessage" rows={4} className={input} value={message} onChange={(e) => setMessage(e.target.value)} />
        </label>
      ) : (
        <p className="mt-4 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm text-slate-800">{request.message || 'No message.'}</p>
      )}

      <h3 className="mt-5 text-sm font-semibold text-slate-900">Requested items</h3>
      <ul className="mt-2 divide-y divide-slate-100 text-sm">
        {request.items.map((i) => (
          <li key={i.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
            <span>
              <span className="font-medium text-slate-900">{i.label}</span>
              {i.detail && <span className="text-slate-600"> — {i.detail}</span>}
            </span>
            <span className={i.status === 'received' ? 'font-semibold text-emerald-700' : 'text-slate-600'}>
              {i.status === 'received' ? `Received (${i.receivedCount} file${i.receivedCount === 1 ? '' : 's'})` : 'Requested'}
            </span>
          </li>
        ))}
      </ul>

      {request.link && (
        <p className="mt-4 text-sm text-slate-700">
          Upload link: {request.link.active ? 'active' : request.link.revokedAt ? 'withdrawn' : 'expired'}, until{' '}
          {new Date(request.link.expiresAt).toLocaleString()} · {request.link.filesReceived} of {request.link.maxFiles} files received
        </p>
      )}

      {issued && (
        <div role="status" className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          <p className="font-semibold">Upload link ready</p>
          <p className="mt-1">
            Copy it now: for security it is shown only once. Anyone with the link can upload files until {new Date(issued.expiresAt).toLocaleString()}.
          </p>
          <label className="mt-2 block">
            <span className="sr-only">Upload link</span>
            <input readOnly value={issued.url} className={`${input} font-mono text-xs`} onFocus={(e) => e.target.select()} />
          </label>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className={button} onClick={() => void navigator.clipboard?.writeText(issued.url)}>
              Copy link
            </button>
            <a className={button} href={issued.url}>
              Open the upload page
            </a>
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {request.status !== 'closed' && (
          <label className="text-sm text-slate-700">
            Link valid for{' '}
            <select id="linkDays" name="linkDays" defaultValue="14" className="rounded-md border border-slate-300 px-2 py-1 text-sm">
              {[3, 7, 14, 30].map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          </label>
        )}
        {request.status === 'draft' && (
          <>
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  onChanged(await api.update(request.id, { message }));
                  return { text: 'Draft saved.' };
                })
              }
            >
              Save draft
            </button>
            <button
              type="button"
              className={primary}
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  if (message !== request.message) await api.update(request.id, { message });
                  const r = await api.approve(request.id, days());
                  setIssued(r.link);
                  onChanged(r.request);
                  return { text: r.request.emailStatus === 'sent' ? 'Approved and emailed to the client.' : 'Approved. Send the link to the client.' };
                })
              }
            >
              Approve and create link
            </button>
          </>
        )}
        {request.status === 'open' && (
          <>
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const r = await api.reissue(request.id, days());
                  setIssued(r.link);
                  onChanged(r.request);
                  return { text: 'A new link was created; the old one no longer works.' };
                })
              }
            >
              New link
            </button>
            {request.link?.active && (
              <button
                type="button"
                className={`${button} text-red-700`}
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    onChanged(await api.revoke(request.id));
                    setIssued(null);
                    return { text: 'Link withdrawn. The client can no longer upload with it.' };
                  })
                }
              >
                Withdraw link
              </button>
            )}
          </>
        )}
      </div>
      <div aria-live="polite" className="mt-2">
        {note && <FormMessage tone={note.tone}>{note.text}</FormMessage>}
      </div>
    </section>
  );
}

export default function ProjectRequestsPage(): JSX.Element {
  usePageMeta({ title: 'Client requests', description: 'Ask the client for missing evidence through a no-login upload link.' });
  const { projectId = '' } = useParams();
  const { authedRequest } = useAuth();
  const api = useMemo(() => requestsApi(authedRequest), [authedRequest]);
  const [list, setList] = useState<RequestSummary[] | null>(null);
  const [selected, setSelected] = useState<RequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .list(projectId)
      .then((p) => setList(p.items))
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Requests could not be loaded.'));
  }, [api, projectId]);
  useEffect(load, [load]);

  const open = (id: string): void => {
    api
      .detail(id)
      .then(setSelected)
      .catch(() => setError('The request could not be opened.'));
  };
  const changed = (r: RequestDetail): void => {
    setSelected(r);
    load();
  };

  return (
    <div className="mx-auto max-w-4xl">
      <p className="text-sm">
        <Link to={`/app/projects/${encodeURIComponent(projectId)}`} className="font-medium text-brand-700 hover:underline">
          Back to the project
        </Link>
      </p>
      <h1 className="mt-2 text-2xl font-bold text-slate-900">Client requests</h1>
      <p className="mt-1 text-sm text-slate-600">
        Ask the client for missing evidence. They upload from a link on their phone, without an account; each file joins this submission&rsquo;s files.
      </p>
      {error && <FormMessage tone="error">{error}</FormMessage>}

      <section className={`${card} mt-6`} aria-labelledby="list-title">
        <h2 id="list-title" className="text-lg font-semibold text-slate-900">
          Requests
        </h2>
        {list && list.length === 0 && <p className="mt-2 text-sm text-slate-600">No requests yet.</p>}
        <ul className="mt-2 divide-y divide-slate-100">
          {(list ?? []).map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
              <button type="button" className="text-left font-medium text-brand-700 hover:underline" onClick={() => open(r.id)}>
                {r.title}
              </button>
              <span className="text-sm text-slate-600">
                {STATUS_LABELS[r.status]} · {r.receivedCount} of {r.itemCount} received
              </span>
            </li>
          ))}
        </ul>
      </section>

      {selected && <RequestPanel key={selected.id} request={selected} onChanged={changed} />}

      <div className="mt-6">
        <Composer
          projectId={projectId}
          onCreated={(r) => {
            setSelected(r);
            load();
          }}
        />
      </div>
    </div>
  );
}
