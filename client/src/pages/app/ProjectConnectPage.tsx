import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { FormMessage } from '../../components/auth/AuthUi';
import { usePageMeta } from '../../hooks/usePageMeta';
import { ApiError } from '../../lib/api';
import { InboundEmail, InboundSettings, inboundApi } from '../../lib/inboundApi';

const card = 'rounded-2xl border border-slate-200 bg-white p-6 shadow-sm';
const button = 'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:border-brand-400 disabled:opacity-60';
const primary = 'rounded-md bg-brand-700 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-60';
const message = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

const PROVIDERS = ['Dropbox', 'Box', 'SharePoint or OneDrive', 'Google Drive'];

const STATUS_LABEL: Record<InboundEmail['status'], string> = {
  queued: 'Waiting',
  processing: 'Reading',
  accepted: 'Received',
  rejected: 'Refused',
  failed: 'Failed',
};

/** Option A: linked folders. The provider apps are not registered yet, so connecting is not offered. */
function LinkFolder(): JSX.Element {
  return (
    <section className={card} aria-labelledby="link-title">
      <h2 id="link-title" className="text-lg font-semibold text-slate-900">
        A. Link the client&apos;s folder
      </h2>
      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">What MedexRegAI can do with a linked folder</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-700">
            <li>See and download the files in the one folder you choose, where the provider lets us limit access to it.</li>
            <li>Notice when a file in that folder changes, so new versions are picked up.</li>
          </ul>
        </div>
        <div>
          <h3 className="text-sm font-semibold text-slate-900">What it can never do</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-700">
            <li>Change, move, rename, delete or share any file.</li>
            <li>Keep a fetched copy after reading it: only text, page locations and fingerprints are kept.</li>
          </ul>
          <p className="mt-1 text-sm text-slate-700">You or your firm admin can disconnect at any time, which revokes our access at the provider.</p>
        </div>
      </div>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
        {PROVIDERS.map((p) => (
          <li key={p} className="rounded-lg border border-slate-200 p-3 text-sm">
            <p className="font-medium text-slate-900">{p}</p>
            <p className="text-slate-500">Read-only. Not available yet.</p>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-slate-500">
        Folder links need MedexRegAI to be registered as an app with each provider, which is not done yet. Until then, use an upload link or the forwarding
        address.
      </p>
    </section>
  );
}

function Forwarding({ projectId }: { projectId: string }): JSX.Element {
  const { authedRequest } = useAuth();
  const api = useMemo(() => inboundApi(authedRequest, projectId), [authedRequest, projectId]);
  const [settings, setSettings] = useState<InboundSettings | null>(null);
  const [messages, setMessages] = useState<InboundEmail[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [senderError, setSenderError] = useState<string | undefined>();

  const load = useCallback(() => {
    api
      .settings()
      .then(setSettings)
      .catch((err: unknown) => setError(message(err, 'Could not load the forwarding address.')));
    api
      .messages()
      .then((p) => setMessages(p.items))
      .catch(() => undefined);
  }, [api]);
  useEffect(load, [load]);
  // Messages are read within seconds: refresh while any is waiting.
  useEffect(() => {
    if (!messages.some((m) => m.status === 'queued' || m.status === 'processing')) return;
    const t = setTimeout(load, 3000);
    return () => clearTimeout(t);
  }, [messages, load]);

  const run = async (work: () => Promise<InboundSettings>, done: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setSettings(await work());
      setNotice(done);
    } catch (err) {
      setError(message(err, 'Something went wrong. Please try again.'));
    } finally {
      setBusy(false);
    }
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice('Address copied.');
    } catch {
      setNotice('Select the address and copy it.');
    }
  };
  const saveSenders = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const raw = String(new FormData(e.currentTarget).get('allowedSenders') ?? '');
    const entries = raw
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    setSenderError(undefined);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setSettings(await api.setSenders(entries));
      setNotice('Allowed senders saved.');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VALIDATION_ERROR') setSenderError(err.message);
      else setError(message(err, 'Could not save the allowed senders.'));
    } finally {
      setBusy(false);
    }
  };

  const a = settings?.address;
  return (
    <section className={card} aria-labelledby="forward-title">
      <h2 id="forward-title" className="text-lg font-semibold text-slate-900">
        C. Forward by email
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        This project&apos;s own address. Attachments sent or forwarded to it are added to the project&apos;s files within two minutes, checked and scanned like
        any upload. Mail is accepted from your firm&apos;s members and the senders you allow.
      </p>
      <div aria-live="polite" className="mt-3 space-y-2">
        {notice && <FormMessage tone="success">{notice}</FormMessage>}
        {error && <FormMessage tone="error">{error}</FormMessage>}
      </div>
      {settings && !settings.configured && <p className="mt-3 text-sm text-slate-600">Forwarding addresses are not set up on this server yet.</p>}
      {settings?.configured && !a && (
        <button type="button" className={`${primary} mt-4`} disabled={busy} onClick={() => void run(api.turnOn, 'Forwarding address is on.')}>
          Turn on forwarding address
        </button>
      )}
      {a && (
        <>
          <p className="mt-4 break-all rounded-md border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm text-slate-900">{a.email}</p>
          <div className="mt-3 flex flex-wrap gap-3">
            <button type="button" className={button} onClick={() => void copy(a.email)}>
              Copy address
            </button>
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() => void run(api.turnOn, 'New address issued. The old address no longer works.')}
            >
              Issue a new address
            </button>
            <button type="button" className={button} disabled={busy} onClick={() => void run(api.turnOff, 'Forwarding address turned off.')}>
              Turn off
            </button>
          </div>
          <form className="mt-5 max-w-xl" onSubmit={(e) => void saveSenders(e)} noValidate>
            <label htmlFor="allowedSenders" className="block text-sm font-medium text-slate-800">
              Also accept mail from (addresses or @domains, separated by commas)
            </label>
            <input
              id="allowedSenders"
              name="allowedSenders"
              key={a.allowedSenders.join(',')}
              defaultValue={a.allowedSenders.join(', ')}
              aria-invalid={senderError ? true : undefined}
              aria-describedby={senderError ? 'allowedSenders-error' : undefined}
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-slate-900 shadow-sm"
              placeholder="@client.com, qa@testlab.com"
            />
            {senderError && (
              <p id="allowedSenders-error" className="mt-1 text-sm text-red-700">
                {senderError}
              </p>
            )}
            <button type="submit" className={`${button} mt-2`} disabled={busy}>
              Save allowed senders
            </button>
          </form>
        </>
      )}
      <h3 className="mt-6 text-sm font-semibold text-slate-900">Messages received</h3>
      {messages.length === 0 ? (
        <p className="mt-1 text-sm text-slate-500">Nothing received yet.</p>
      ) : (
        <ul className="mt-2 divide-y divide-slate-100">
          {messages.map((m) => (
            <li key={m.id} className="py-3 text-sm">
              <p className="text-slate-900">
                <span className="font-semibold">{STATUS_LABEL[m.status]}</span> · {m.subject || '(no subject)'} · from {m.fromAddress ?? 'unknown'} ·{' '}
                {new Date(m.receivedAt).toLocaleString()}
              </p>
              {m.reason && <p className="text-slate-600">{m.reason}</p>}
              {m.attachments.length > 0 && (
                <ul className="mt-1 space-y-0.5 pl-4 text-slate-700">
                  {m.attachments.map((x, i) => (
                    <li key={`${m.id}-${i}`}>
                      {x.name}: {x.outcome === 'stored' ? 'added' : x.outcome === 'unchanged' ? 'already in the project' : `refused. ${x.reason ?? ''}`}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function ProjectConnectPage(): JSX.Element {
  const { projectId = '' } = useParams();
  usePageMeta({ title: 'Connect client files', description: 'Link a folder, send an upload link, or use the project forwarding address.' });
  return (
    <section className="mx-auto w-full max-w-5xl space-y-6 px-4 py-10 sm:px-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Connect client files</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-600">
          Three ways to get the client&apos;s evidence into this project. Use whichever the client allows.
        </p>
      </div>
      <LinkFolder />
      <section className={card} aria-labelledby="upload-title">
        <h2 id="upload-title" className="text-lg font-semibold text-slate-900">
          B. Send the client an upload link
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          The client uploads from a phone or computer without an account, through an expiring link you can withdraw. Links are created with a client request.
        </p>
        <Link to={`/app/projects/${projectId}/requests`} className={`${button} mt-4 inline-block`}>
          Go to client requests
        </Link>
      </section>
      <Forwarding projectId={projectId} />
    </section>
  );
}
