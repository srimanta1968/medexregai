import { ChangeEvent, useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { usePageMeta } from '../hooks/usePageMeta';
import { ApiError } from '../lib/api';
import { PublicRequest, publicRequestApi } from '../lib/requestsApi';

/**
 * The client's upload page (F2.4): opened from the link in the consultant's request,
 * on a phone, with no account. The link is the credential, so the page never shows
 * other projects, names of other files or anything beyond what was asked for.
 */

const mb = (bytes: number): string => `${Math.floor(bytes / (1024 * 1024))} MB`;

type Status = { tone: 'busy' | 'ok' | 'error'; text: string };

function ItemUpload({
  index,
  item,
  accept,
  onUpload,
}: {
  index: number;
  item: PublicRequest['items'][number] | null;
  accept: string;
  onUpload: (file: File, itemId?: string) => Promise<Status>;
}): JSX.Element {
  const [status, setStatus] = useState<Status | null>(null);
  const inputId = `file-${index}`;
  const onChange = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    for (const file of files) {
      setStatus({ tone: 'busy', text: `Uploading ${file.name}…` });
      // One at a time: each file is checked and scanned before the next one goes.
      setStatus(await onUpload(file, item?.id));
    }
  };
  const received = item?.status === 'received';
  return (
    <li className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-slate-900">{item ? item.label : 'Anything else'}</p>
          {item?.detail && <p className="mt-0.5 text-sm text-slate-600">{item.detail}</p>}
          {!item && <p className="mt-0.5 text-sm text-slate-600">Other files you were asked for or think are relevant.</p>}
        </div>
        {item && (
          <span
            className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${received ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-slate-700'}`}
          >
            {received ? 'Received' : 'Requested'}
          </span>
        )}
      </div>
      <label
        htmlFor={inputId}
        className="mt-3 flex min-h-[44px] cursor-pointer items-center justify-center rounded-lg border border-brand-600 bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700"
      >
        {received ? 'Add another file' : 'Choose file'}
      </label>
      <input
        id={inputId}
        name={inputId}
        type="file"
        multiple
        accept={accept}
        className="sr-only"
        aria-label={`Upload a file for ${item ? item.label : 'anything else'}`}
        onChange={(e) => void onChange(e)}
      />
      <div aria-live="polite">
        {status && (
          <p className={`mt-2 text-sm ${status.tone === 'error' ? 'text-red-700' : status.tone === 'ok' ? 'text-emerald-800' : 'text-slate-600'}`}>
            {status.text}
          </p>
        )}
      </div>
    </li>
  );
}

export default function ClientUploadPage(): JSX.Element {
  usePageMeta({ title: 'Upload requested files', description: 'Send the files your regulatory consultant asked for.' });
  const { token = '' } = useParams();
  const [view, setView] = useState<PublicRequest | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The link is a credential: keep it out of the Referer header of anything this page loads.
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'no-referrer';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);

  const load = useCallback(() => {
    publicRequestApi
      .view(token)
      .then((v) => {
        setView(v);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'This page could not be loaded. Check your connection and try again.'));
  }, [token]);
  useEffect(load, [load]);

  const upload = async (file: File, itemId?: string): Promise<Status> => {
    if (view && file.size > view.maxFileBytes) return { tone: 'error', text: `${file.name} is larger than ${mb(view.maxFileBytes)}.` };
    try {
      const r = await publicRequestApi.upload(token, file, itemId);
      load();
      return { tone: 'ok', text: r.alreadyReceived ? `${r.fileName} was already received.` : `Received ${r.fileName}. Thank you.` };
    } catch (err) {
      return { tone: 'error', text: err instanceof ApiError ? err.message : `${file.name} could not be uploaded. Try again.` };
    }
  };

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6 sm:py-10">
      <div className="mx-auto w-full max-w-lg">
        <p className="text-sm font-semibold text-brand-700">Secure upload</p>
        {error && (
          <div role="alert" className="mt-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
            {error}
          </div>
        )}
        {!view && !error && (
          <p role="status" className="mt-3 text-sm text-slate-600">
            Opening the request…
          </p>
        )}
        {view && (
          <>
            <h1 className="mt-1 text-2xl font-bold text-slate-900">{view.title}</h1>
            <p className="mt-1 text-sm text-slate-600">From {view.firmName}</p>
            {view.message && <p className="mt-4 whitespace-pre-wrap text-base text-slate-800">{view.message}</p>}
            <ol className="mt-5 space-y-3">
              {view.items.map((item, i) => (
                <ItemUpload key={item.id} index={i + 1} item={item} accept={view.accepted.extensions.map((e) => `.${e}`).join(',')} onUpload={upload} />
              ))}
              <ItemUpload index={0} item={null} accept={view.accepted.extensions.map((e) => `.${e}`).join(',')} onUpload={upload} />
            </ol>
            <p className="mt-5 text-xs text-slate-500">
              Accepted: {view.accepted.label}, up to {mb(view.maxFileBytes)} each. Every file is checked for malware before it is stored. This link works until{' '}
              {new Date(view.expiresAt).toLocaleString()}. You do not need an account.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
