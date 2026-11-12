import { ChangeEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { FormMessage } from '../../components/auth/AuthUi';
import { usePageMeta } from '../../hooks/usePageMeta';
import { ApiError } from '../../lib/api';
import { Draft, DraftStatement, DraftVersion, draftsApi, fileToBase64 } from '../../lib/draftsApi';
import { saveBlob } from '../../lib/trustApi';

const card = 'rounded-2xl border border-slate-200 bg-white p-5 shadow-sm';
const primary = 'rounded-md bg-brand-700 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-60';
const secondary = 'rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:border-brand-400 disabled:opacity-60';
const message = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);
const REMOVAL: Record<string, string> = {
  UNCITED: 'No source cited',
  UNRESOLVED: 'Source not found in this project',
  QUOTE_MISMATCH: 'Quote not in the source',
  VALUE_MISMATCH: 'Value differs from the source',
  NOT_A_STATEMENT: 'Not about the device',
};

function Statement({ s }: { s: DraftStatement }): JSX.Element {
  if (s.kind === 'heading') return <h3 className="mt-4 font-semibold text-slate-900">{s.text}</h3>;
  return (
    <span className="mr-1">
      <span className={s.origin === 'generated' ? '' : 'rounded bg-emerald-50 px-0.5'}>{s.text}</span>{' '}
      {s.citations.map((c, i) => (
        <span key={`${c.marker}-${i}`} title={c.marker} className="mr-1 inline-block rounded-full bg-slate-100 px-2 py-0.5 align-middle text-xs text-slate-700">
          {c.label}
        </span>
      ))}
      {s.origin === 'human_edited' && <span className="mr-1 inline-block rounded-full bg-emerald-100 px-2 py-0.5 align-middle text-xs text-emerald-900">Your edit · human-approved</span>}
      {s.origin === 'human_added' && <span className="mr-1 inline-block rounded-full bg-emerald-100 px-2 py-0.5 align-middle text-xs text-emerald-900">Added by you · human-approved</span>}
      {s.warnings.map((w) => (
        <span key={w} className="mr-1 inline-block rounded-full bg-amber-100 px-2 py-0.5 align-middle text-xs text-amber-900">
          {w}
        </span>
      ))}
    </span>
  );
}

function DraftBody({ draft }: { draft: Draft }): JSX.Element {
  const paragraphs = useMemo(() => {
    const m = new Map<number, DraftStatement[]>();
    for (const s of draft.statements) m.set(s.paragraph, [...(m.get(s.paragraph) ?? []), s]);
    return [...m.values()];
  }, [draft.statements]);
  return (
    <div className="space-y-3 leading-7 text-slate-800">
      {paragraphs.map((p) => (
        <p key={p[0].id}>
          {p.map((s) => (
            <Statement key={s.id} s={s} />
          ))}
        </p>
      ))}
    </div>
  );
}

/**
 * F3.2 Draft review (UI 2.0 §5.2): one section's draft, every statement with the source it
 * cites. Statements the citation gate removed are listed with the reason, as open items.
 * The draft goes to Word with sources as comments; an edited copy comes back as a new version
 * with the consultant's edits kept as human-approved.
 */
export default function SectionDraftPage(): JSX.Element {
  const { projectId = '', sectionId = '' } = useParams();
  const { authedRequest } = useAuth();
  const api = useMemo(() => draftsApi(authedRequest, sectionId), [authedRequest, sectionId]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [versions, setVersions] = useState<DraftVersion[] | null>(null);
  const [version, setVersion] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  usePageMeta({ title: draft ? `${draft.sectionTitle} draft` : 'Section draft', description: 'A cited section draft for review.' });

  const load = useCallback(
    (v?: number) =>
      api
        .current(v)
        .then((r) => {
          setDraft(r.draft);
          setVersions(r.versions);
        })
        .catch((err: unknown) => setError(message(err, 'Could not load the draft.'))),
    [api],
  );
  useEffect(() => {
    void load(version);
  }, [load, version]);

  // While the draft is being written, check every few seconds.
  const working = draft?.status === 'queued' || draft?.status === 'generating';
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => void load(version), 2000);
    return () => clearInterval(t);
  }, [working, load, version]);

  const run = async (what: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await what();
    } catch (err) {
      setError(message(err, fallback));
    } finally {
      setBusy(false);
    }
  };
  const requestDraft = () =>
    run(async () => {
      const d = await api.request();
      setVersion(undefined);
      setDraft(d);
      setNotice(`Drafting version ${d.versionNo}. This takes about a minute.`);
      await load();
    }, 'Could not start the draft.');
  const download = () =>
    run(async () => {
      const name = `${draft?.sectionTitle ?? 'Section'} draft v${draft?.versionNo ?? ''}.docx`;
      saveBlob(await api.exportDocx(draft?.versionNo), name);
      setNotice(`Downloaded ${name}. Sources are Word comments; edit it and import it back.`);
    }, 'Could not export the draft.');
  const importFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    void run(async () => {
      const d = await api.importDocx(file.name, await fileToBase64(file));
      setVersion(undefined);
      setDraft(d);
      const s = d.importSummary;
      setNotice(
        s
          ? `Imported as version ${d.versionNo}: ${s.edited} edited, ${s.added} added, ${s.deleted.length} deleted, ${s.unchanged} unchanged. Your edits are human-approved.`
          : `Imported as version ${d.versionNo}.`,
      );
      await load();
    }, 'Could not import the document.');
  };

  return (
    <section className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
      <nav aria-label="Breadcrumb" className="text-sm text-slate-500">
        <Link to={`/app/projects/${projectId}`} className="hover:underline">
          Project
        </Link>{' '}
        ›{' '}
        <Link to={`/app/projects/${projectId}/review`} className="hover:underline">
          Review
        </Link>{' '}
        › <span aria-current="page">Draft</span>
      </nav>
      <h1 className="mt-1 text-2xl font-bold text-slate-900">{draft?.sectionTitle ?? 'Section draft'}</h1>
      <p className="mt-1 max-w-3xl text-sm text-slate-600">
        Every statement cites the client file it comes from. Anything the citation check could not tie to a source is removed and listed below. You review
        and approve; MedexRegAI never files.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" className={primary} disabled={busy || working} onClick={() => void requestDraft()}>
          {draft ? 'Draft again' : 'Draft this section'}
        </button>
        <button type="button" className={secondary} disabled={busy || draft?.status !== 'ready'} onClick={() => void download()}>
          Download Word
        </button>
        <label className={`${secondary} cursor-pointer`}>
          Import edited Word
          <input type="file" name="draftImport" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="sr-only" onChange={importFile} disabled={busy} />
        </label>
        {versions && versions.length > 1 && (
          <label className="ml-auto text-sm">
            <span className="mr-2 text-slate-600">Version</span>
            <select
              name="draftVersion"
              className="rounded-md border border-slate-300 px-2 py-1.5"
              value={draft?.versionNo ?? ''}
              onChange={(e) => setVersion(Number(e.target.value))}
            >
              {versions.map((v) => (
                <option key={v.id} value={v.versionNo}>
                  v{v.versionNo} · {v.origin === 'imported' ? 'imported from Word' : 'generated'} · {v.status}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div aria-live="polite" className="mt-3 space-y-2">
        {notice && <FormMessage tone="success">{notice}</FormMessage>}
        {error && <FormMessage tone="error">{error}</FormMessage>}
      </div>

      {versions === null ? (
        <p role="status" className="mt-6 text-slate-500">
          Loading…
        </p>
      ) : !draft ? (
        <div className={`${card} mt-6`}>
          <h2 className="font-semibold text-slate-900">No draft yet</h2>
          <p className="mt-1 text-sm text-slate-600">Draft this section from the client files filed under it. Each statement will cite its source.</p>
        </div>
      ) : (
        <div className="mt-6 grid gap-6 lg:grid-cols-[2fr_1fr]">
          <article className={card} aria-label={`Draft version ${draft.versionNo}`}>
            <p className="text-xs text-slate-500">
              Version {draft.versionNo} · {draft.origin === 'imported' ? `imported from Word (based on v${draft.basedOnVersion ?? '?'})` : 'generated'}
              {draft.createdBy && ` · ${draft.createdBy}`}
            </p>
            {working && (
              <p role="status" className="mt-3 text-slate-700">
                Drafting… this takes about a minute.
              </p>
            )}
            {draft.status === 'failed' && <FormMessage tone="error">{draft.error ?? 'The draft could not be written.'}</FormMessage>}
            {draft.status === 'ready' && (
              <div className="mt-3">
                {draft.statements.length ? <DraftBody draft={draft} /> : <p className="text-sm text-slate-600">This version has no statements.</p>}
              </div>
            )}
          </article>
          <aside className="space-y-4">
            <section className={card} aria-labelledby="removed-title">
              <h2 id="removed-title" className="font-semibold text-slate-900">
                Removed: no source found · {draft.removed.length}
              </h2>
              {draft.removed.length === 0 ? (
                <p className="mt-1 text-sm text-slate-600">Nothing was removed.</p>
              ) : (
                <ul className="mt-2 space-y-2 text-sm">
                  {draft.removed.map((r, i) => (
                    <li key={i} className="rounded-lg bg-amber-50 p-2">
                      <span className="block font-medium text-amber-900">{REMOVAL[r.code] ?? r.code}</span>
                      <span className="block text-slate-700">“{r.text}”</span>
                      <span className="block text-xs text-slate-500">{r.reason}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {draft.importSummary && (
              <section className={card} aria-labelledby="import-title">
                <h2 id="import-title" className="font-semibold text-slate-900">
                  Changes from Word
                </h2>
                <p className="mt-1 text-sm text-slate-700">
                  {draft.importSummary.edited} edited, {draft.importSummary.added} added, {draft.importSummary.unchanged} unchanged.
                </p>
                {draft.importSummary.deleted.length > 0 && (
                  <ul className="mt-2 list-disc pl-5 text-sm text-slate-600">
                    {draft.importSummary.deleted.map((t, i) => (
                      <li key={i}>Deleted: “{t}”</li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}
