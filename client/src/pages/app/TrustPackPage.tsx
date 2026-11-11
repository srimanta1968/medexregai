import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { FormMessage } from '../../components/auth/AuthUi';
import { usePageMeta } from '../../hooks/usePageMeta';
import { ApiError } from '../../lib/api';
import { PackKey, ProjectDeletion, TrustPackSummary, saveBlob, trustApi } from '../../lib/trustApi';

const card = 'rounded-2xl border border-slate-200 bg-white p-6 shadow-sm';
const button = 'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:border-brand-400 disabled:opacity-60';
const primary = 'rounded-md bg-brand-700 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-60';
const when = (iso: string) => new Date(iso).toLocaleString();
const message = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

const PACK_CONTENTS: Record<PackKey, string[]> = {
  validation: ['Intended use', 'Risk assessment template (pre-filled)', 'Test evidence for this release', 'Release notes and AI model change log'],
  'data-handling': ['What we hold and for how long', 'Where data goes and subprocessors', 'AI and your data', 'Deleting a project', 'Security controls'],
};

function Packs({ summary, onDownload }: { summary: TrustPackSummary; onDownload: (key: PackKey, fileName: string) => Promise<void> }): JSX.Element {
  const [busy, setBusy] = useState<PackKey | null>(null);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {summary.packs.map((p) => (
        <section key={p.key} className={card} aria-labelledby={`pack-${p.key}`}>
          <h2 id={`pack-${p.key}`} className="text-lg font-semibold text-slate-900">
            {p.title}
          </h2>
          <p className="mt-1 text-sm text-slate-600">{p.summary}</p>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-700">
            {PACK_CONTENTS[p.key].map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <button
            type="button"
            className={`${primary} mt-4`}
            disabled={busy !== null}
            onClick={() => {
              setBusy(p.key);
              void onDownload(p.key, p.fileName).finally(() => setBusy(null));
            }}
          >
            {busy === p.key ? 'Preparing…' : `Download ${p.title.toLowerCase()} (PDF)`}
          </button>
        </section>
      ))}
    </div>
  );
}

function Clause({ text, status }: { text: string; status: string }): JSX.Element {
  const [copied, setCopied] = useState<string | null>(null);
  const quote = useRef<HTMLQuoteElement>(null);
  const copy = async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // Clipboard API refused (permissions, insecure origin): select the clause and use the copy command.
      const selection = window.getSelection();
      if (quote.current && selection) {
        const range = document.createRange();
        range.selectNodeContents(quote.current);
        selection.removeAllRanges();
        selection.addRange(range);
        ok = document.execCommand('copy');
      }
    }
    setCopied(ok ? 'Clause copied. Paste it into your client agreement.' : 'Select the clause above and copy it.');
  };
  return (
    <section className={card} aria-labelledby="clause-title">
      <h2 id="clause-title" className="text-lg font-semibold text-slate-900">
        A clause you can give your clients
      </h2>
      <p className="mt-1 text-sm text-slate-600">For your client agreements: how your firm uses MedexRegAI with their documents.</p>
      <blockquote ref={quote} className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-4 text-sm leading-relaxed text-slate-800">
        {text}
      </blockquote>
      <p className="mt-2 text-xs text-amber-800">{status}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" className={button} onClick={() => void copy()}>
          Copy clause
        </button>
        <span role="status" className="text-sm text-emerald-800">
          {copied}
        </span>
      </div>
    </section>
  );
}

function DataUsePanel({
  summary,
  canManage,
  onChange,
}: {
  summary: TrustPackSummary;
  canManage: boolean;
  onChange: (on: boolean) => Promise<void>;
}): JSX.Element {
  const [saving, setSaving] = useState(false);
  const d = summary.dataUse;
  return (
    <section className={card} aria-labelledby="data-use-title">
      <h2 id="data-use-title" className="text-lg font-semibold text-slate-900">
        Data use
      </h2>
      <dl className="mt-3 divide-y divide-slate-100 text-sm">
        <div className="flex flex-wrap items-start justify-between gap-2 py-3">
          <dt>
            <span className="font-medium text-slate-900">AI training on your data</span>
            <span className="block text-slate-600">Client content is never used to train any model. This is not a setting.</span>
          </dt>
          <dd className="rounded-full bg-emerald-50 px-3 py-1 font-semibold text-emerald-800">Never</dd>
        </div>
        <div className="flex flex-wrap items-start justify-between gap-2 py-3">
          <dt>
            <span className="font-medium text-slate-900">Data use for product improvement</span>
            <span className="block text-slate-600">
              Off by default. Turning it on records your firm&apos;s consent; nothing in this release uses client content for product improvement.
            </span>
            {d.updatedAt && (
              <span className="block text-xs text-slate-500">
                Last changed {when(d.updatedAt)}
                {d.updatedByName ? ` by ${d.updatedByName}` : ''}.
              </span>
            )}
          </dt>
          <dd className="font-semibold text-slate-900">{d.productImprovement ? 'On' : 'Off (default)'}</dd>
        </div>
      </dl>
      {canManage ? (
        <button
          type="button"
          className={`${button} mt-2`}
          disabled={saving}
          onClick={() => {
            setSaving(true);
            void onChange(!d.productImprovement).finally(() => setSaving(false));
          }}
        >
          {d.productImprovement ? 'Turn product-improvement use off' : 'Turn product-improvement use on'}
        </button>
      ) : (
        <p className="mt-2 text-xs text-slate-500">Only a firm owner or admin can change this.</p>
      )}
    </section>
  );
}

function Deletions({
  items,
  summary,
  onCertificate,
}: {
  items: ProjectDeletion[];
  summary: TrustPackSummary;
  onCertificate: (d: ProjectDeletion) => Promise<void>;
}): JSX.Element {
  return (
    <section className={card} aria-labelledby="deletion-title">
      <h2 id="deletion-title" className="text-lg font-semibold text-slate-900">
        Delete a project&apos;s data
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        A firm owner or admin can delete a project, with everything held for it, from the project&apos;s page (Delete project data). Database records go at once
        and stored file copies within minutes; we commit to {summary.deletionDays} days. Database backups expire after {summary.backupRetentionDays} days. A
        deletion certificate is issued when it completes.
      </p>
      {items.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">No projects have been deleted.</p>
      ) : (
        <ul className="mt-4 divide-y divide-slate-100">
          {items.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
              <div>
                <p className="font-medium text-slate-900">
                  {d.projectName} <span className="font-normal text-slate-500">({d.clientName})</span>
                </p>
                <p className="text-slate-600">
                  {d.status === 'completed'
                    ? `Deleted ${when(d.completedAt ?? d.requestedAt)} by request of ${d.requestedByName}`
                    : `Removing stored files (${d.objectsRemoved} of ${d.objectsTotal}); due by ${when(d.dueBy)}`}
                </p>
              </div>
              {d.status === 'completed' ? (
                <button type="button" className={button} onClick={() => void onCertificate(d)}>
                  Download certificate
                </button>
              ) : (
                <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800">In progress</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function TrustPackPage(): JSX.Element {
  usePageMeta({ title: 'Trust pack', description: 'Validation and data-handling packs, the client clause, data-use settings and project deletion.' });
  const { session, authedRequest } = useAuth();
  const api = useMemo(() => trustApi(authedRequest), [authedRequest]);
  const location = useLocation();
  const [summary, setSummary] = useState<TrustPackSummary | null>(null);
  const [deletions, setDeletions] = useState<ProjectDeletion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>((location.state as { notice?: string } | null)?.notice ?? null);
  const canManage = session?.role === 'owner' || session?.role === 'admin';

  const loadDeletions = useCallback(
    () =>
      api
        .deletions()
        .then((p) => setDeletions(p.items))
        .catch(() => undefined),
    [api],
  );
  useEffect(() => {
    api
      .summary()
      .then(setSummary)
      .catch((err: unknown) => setError(message(err, 'Could not load the trust pack.')));
    void loadDeletions();
  }, [api, loadDeletions]);
  // A deletion in progress finishes within moments: refresh until it has.
  useEffect(() => {
    if (!deletions.some((d) => d.status !== 'completed')) return;
    const t = setTimeout(() => void loadDeletions(), 2000);
    return () => clearTimeout(t);
  }, [deletions, loadDeletions]);

  const download = async (key: PackKey, fileName: string) => {
    setError(null);
    try {
      saveBlob(await api.pack(key), fileName);
      setNotice(`Downloaded ${fileName}.`);
    } catch (err) {
      setError(message(err, 'Could not prepare the pack.'));
    }
  };
  const certificate = async (d: ProjectDeletion) => {
    setError(null);
    try {
      const name = `deletion-certificate-${d.id.slice(0, 8)}.pdf`;
      saveBlob(await api.certificate(d.id), name);
      setNotice(`Downloaded ${name}.`);
    } catch (err) {
      setError(message(err, 'Could not download the certificate.'));
    }
  };
  const setProductImprovement = async (on: boolean) => {
    setError(null);
    try {
      const dataUse = await api.setProductImprovement(on);
      setSummary((s) => (s ? { ...s, dataUse } : s));
      setNotice(on ? 'Product-improvement use is on.' : 'Product-improvement use is off.');
    } catch (err) {
      setError(message(err, 'Could not change the setting.'));
    }
  };

  return (
    <section className="mx-auto w-full max-w-5xl space-y-6 px-4 py-10 sm:px-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Trust pack</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-600">
          Everything your quality and IT owners need to assess MedexRegAI. Included free and generated for your firm from the release you use
          {summary ? ` (${summary.release})` : ''}.
        </p>
      </div>
      <div aria-live="polite">
        {notice && <FormMessage tone="success">{notice}</FormMessage>}
        {error && <FormMessage tone="error">{error}</FormMessage>}
      </div>
      {!summary && !error && (
        <p role="status" className="text-slate-500">
          Loading…
        </p>
      )}
      {summary && (
        <>
          <Packs summary={summary} onDownload={download} />
          <Clause text={summary.clause.text} status={summary.clause.status} />
          <DataUsePanel summary={summary} canManage={canManage} onChange={setProductImprovement} />
          <Deletions items={deletions} summary={summary} onCertificate={certificate} />
        </>
      )}
    </section>
  );
}
