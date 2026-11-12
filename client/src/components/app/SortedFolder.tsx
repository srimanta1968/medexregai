import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/api';
import { Coverage, EstarSection, SortedFile, UnreadableFile, VersionGroup, sortingApi } from '../../lib/sortingApi';
import { FormMessage } from '../auth/AuthUi';

const card = 'rounded-2xl border border-slate-200 bg-white p-6 shadow-sm';
const button = 'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:border-brand-400 disabled:opacity-60';
const SOURCE_LABEL: Record<string, string> = { rules: 'by rule', embedding: 'like your filed files', llm: 'by AI', consultant: 'by you' };
const ROLE_LABEL: Record<string, string> = { current: 'current', superseded: 'superseded', duplicate: 'identical copy', candidate: '' };
const message = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/** Versions of one document where the current one is unclear: the consultant picks, the tool never does. */
function VersionPrompt({ group, busy, onConfirm }: { group: VersionGroup; busy: boolean; onConfirm: (fileId: string) => void }): JSX.Element {
  const [choice, setChoice] = useState('');
  return (
    <li className="py-3 text-sm">
      <p className="font-medium text-slate-900">Which is current?</p>
      <p className="text-slate-600">{group.reason}</p>
      <fieldset className="mt-2">
        <legend className="sr-only">Current version</legend>
        {group.members.map((m) => (
          <label key={m.fileId} className="flex items-center gap-2 py-0.5">
            <input type="radio" name={`current-${group.id}`} value={m.fileId} checked={choice === m.fileId} onChange={() => setChoice(m.fileId)} />
            <span>
              {m.name}
              {m.revisionLabel && <span className="text-slate-500"> · rev {m.revisionLabel}{m.revisionFrom === 'title_block' ? ' (title block)' : ''}</span>}
              {m.role === 'duplicate' && <span className="text-slate-500"> · identical copy</span>}
            </span>
          </label>
        ))}
      </fieldset>
      <button type="button" className={`${button} mt-2`} disabled={busy || !choice} onClick={() => onConfirm(choice)}>
        Mark as current
      </button>
    </li>
  );
}

/**
 * F2.2 (UI 2.0 §4.2): the getting-started checklist, the eSTAR coverage panel, the
 * sorted folder (each file with its section, confidence and, on hover, why), version
 * groups that need the consultant to say which file is current, and the files that
 * could not be read with the reason. Moving a file teaches the sorter for this firm only.
 */
export function SortedFolder({ projectId, refreshKey }: { projectId: string; refreshKey: string }): JSX.Element {
  const { authedRequest } = useAuth();
  const api = useMemo(() => sortingApi(authedRequest, projectId), [authedRequest, projectId]);
  const [sections, setSections] = useState<EstarSection[]>([]);
  const [files, setFiles] = useState<SortedFile[] | null>(null);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [groups, setGroups] = useState<VersionGroup[]>([]);
  const [unreadable, setUnreadable] = useState<UnreadableFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .files()
      .then((p) => setFiles(p.items))
      .catch((err: unknown) => setError(message(err, 'Could not load the sorted folder.')));
    api
      .coverage()
      .then(setCoverage)
      .catch(() => undefined);
    api
      .versionGroups()
      .then(setGroups)
      .catch(() => undefined);
    api
      .unreadable()
      .then((p) => setUnreadable(p.items))
      .catch(() => undefined);
  }, [api]);
  useEffect(() => {
    api
      .sections()
      .then(setSections)
      .catch(() => undefined);
  }, [api]);
  useEffect(load, [load, refreshKey]);
  // Files are sorted shortly after they are read: refresh while any is still waiting.
  useEffect(() => {
    if (!files?.some((f) => !f.assignment && !f.unreadable)) return;
    const t = setTimeout(load, 3000);
    return () => clearTimeout(t);
  }, [files, load]);

  const evidence = useMemo(() => sections.filter((s) => s.takesEvidence), [sections]);
  const grouped = useMemo(() => {
    const by = new Map<string, SortedFile[]>();
    for (const f of files ?? []) {
      const key = f.assignment?.sectionId ?? '';
      by.set(key, [...(by.get(key) ?? []), f]);
    }
    const order = (id: string) => (id === '' ? -1 : (sections.find((s) => s.id === id)?.ordinal ?? 999));
    return [...by.entries()].sort((a, b) => order(a[0]) - order(b[0]));
  }, [files, sections]);
  const roleOf = useMemo(() => {
    const m = new Map<string, { role: string; label: string | null }>();
    for (const g of groups) for (const mb of g.members) m.set(mb.fileId, { role: g.status === 'unclear' ? 'unclear' : mb.role, label: mb.revisionLabel });
    return m;
  }, [groups]);

  const run = async (work: () => Promise<string>, failed: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await work());
      load();
    } catch (err) {
      setError(message(err, failed));
    } finally {
      setBusy(false);
    }
  };
  const move = (f: SortedFile, sectionId: string) =>
    run(async () => {
      const r = await api.assign(f.id, sectionId === '' ? null : sectionId);
      return r.assignment.sectionTitle
        ? `Filed ${f.name} under ${r.assignment.sectionTitle}. Similar files will be sorted the same way.`
        : `${f.name} marked as not evidence for any section.`;
    }, 'Could not move the file.');
  const confirm = (g: VersionGroup, fileId: string) =>
    run(async () => {
      await api.confirmCurrent(g.id, fileId);
      return `${g.members.find((m) => m.fileId === fileId)?.name ?? 'The file'} is now the current version.`;
    }, 'Could not record the current version.');

  const noFiles = files !== null && files.length === 0;
  const unclear = groups.filter((g) => g.needsDecision);
  const empty = coverage?.sections.filter((s) => s.empty) ?? [];
  return (
    <div className={`mt-6 grid gap-6 ${noFiles ? 'lg:grid-cols-2' : 'lg:grid-cols-[2fr_1fr]'}`}>
      {!noFiles && (
        <div className="space-y-6">
          <section className={card} aria-labelledby="sorted-title">
            <h2 id="sorted-title" className="text-lg font-semibold text-slate-900">
              Sorted into eSTAR sections
            </h2>
            <p className="mt-1 text-sm text-slate-600">Wrong section? Pick the right one. Corrections teach the sorter for this firm only.</p>
            <div aria-live="polite" className="mt-3 space-y-2">
              {notice && <FormMessage tone="success">{notice}</FormMessage>}
              {error && <FormMessage tone="error">{error}</FormMessage>}
            </div>
            {files === null ? (
              <p role="status" className="mt-3 text-slate-500">
                Loading…
              </p>
            ) : (
              grouped.map(([sectionId, list]) => (
                <div key={sectionId || 'unsorted'} className="mt-4">
                  <h3 className="text-sm font-semibold text-slate-900">
                    {sectionId ? (sections.find((s) => s.id === sectionId)?.title ?? sectionId) : 'Not sorted yet'} · {list.length} file{list.length === 1 ? '' : 's'}
                  </h3>
                  <ul className="mt-1 divide-y divide-slate-100">
                    {list.map((f) => {
                      const v = roleOf.get(f.id);
                      return (
                        <li key={f.id} className="flex flex-wrap items-start justify-between gap-2 py-2 text-sm">
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-slate-900" title={f.assignment?.reason}>
                              {f.name}
                            </span>
                            <span className="text-slate-600">
                              {f.assignment
                                ? `${Math.round(f.assignment.confidence * 100)}% · ${SOURCE_LABEL[f.assignment.source] ?? f.assignment.source}`
                                : f.unreadable
                                  ? 'Could not be read'
                                  : 'Waiting to be read'}
                              {v && (v.role === 'unclear' ? ' · Which is current?' : ROLE_LABEL[v.role] ? ` · ${v.label ? `rev ${v.label} · ` : ''}${ROLE_LABEL[v.role]}` : '')}
                              {f.assignment?.needsReview && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-amber-900">Please confirm</span>}
                            </span>
                            {f.assignment && (
                              <details className="text-slate-600">
                                <summary className="cursor-pointer text-xs text-brand-700">Why this section</summary>
                                <span className="text-xs">{f.assignment.reason}</span>
                              </details>
                            )}
                          </span>
                          <label className="text-sm">
                            <span className="sr-only">Section for {f.name}</span>
                            <select
                              name={`section-${f.name}`}
                              aria-label={`Section for ${f.name}`}
                              className="rounded-md border border-slate-300 px-2 py-1"
                              value={f.assignment?.sectionId ?? ''}
                              disabled={busy}
                              onChange={(e) => void move(f, e.target.value)}
                            >
                              <option value="">No section</option>
                              {evidence.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.title}
                                </option>
                              ))}
                            </select>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))
            )}
          </section>

          <section className={card} aria-labelledby="versions-title">
            <h2 id="versions-title" className="text-lg font-semibold text-slate-900">
              Versions
            </h2>
            {unclear.length === 0 ? (
              <p className="mt-1 text-sm text-slate-600">
                No unclear versions.{groups.length ? ` ${groups.length} document(s) have more than one file; the current one is clear.` : ''}
              </p>
            ) : (
              <>
                <p className="mt-1 text-sm text-slate-600">For these documents the current version is not clear. We will not pick one for you.</p>
                <ul className="divide-y divide-slate-100">
                  {unclear.map((g) => (
                    <VersionPrompt key={g.id} group={g} busy={busy} onConfirm={(fileId) => void confirm(g, fileId)} />
                  ))}
                </ul>
              </>
            )}
          </section>

          <section className={card} aria-labelledby="unreadable-title">
            <h2 id="unreadable-title" className="text-lg font-semibold text-slate-900">
              Not readable · {unreadable.length} file{unreadable.length === 1 ? '' : 's'}
            </h2>
            {unreadable.length === 0 ? (
              <p className="mt-1 text-sm text-slate-600">Every file so far could be read.</p>
            ) : (
              <ul className="mt-2 divide-y divide-slate-100" aria-label="Files that could not be read">
                {unreadable.map((u) => (
                  <li key={u.id} className="py-2 text-sm">
                    <p className="font-medium text-slate-900">
                      {u.name} <span className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">{u.label}</span>
                      {u.listedOnly && <span className="ml-1 text-xs text-slate-500">listed only</span>}
                    </p>
                    <p className="text-slate-600">{u.reason}</p>
                    <p className="text-slate-500">{u.advice}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      <div className={noFiles ? 'contents' : 'space-y-6'}>
        {coverage && (
          <section className={card} aria-labelledby="checklist-title">
            <h2 id="checklist-title" className="text-lg font-semibold text-slate-900">
              Getting started
            </h2>
            <ol className="mt-2 space-y-2 text-sm">
              {coverage.checklist.map((s) => (
                <li key={s.key} className="flex gap-2">
                  <span aria-hidden="true" className={s.done ? 'text-emerald-700' : 'text-slate-400'}>
                    {s.done ? '✓' : '○'}
                  </span>
                  <span>
                    <span className="font-medium text-slate-900">{s.label}</span>
                    <span className="sr-only">{s.done ? ' (done)' : ' (to do)'}</span>
                    <span className="block text-slate-600">{s.detail}</span>
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}
        {coverage && (
          <section className={card} aria-labelledby="coverage-title">
            <h2 id="coverage-title" className="text-lg font-semibold text-slate-900">
              eSTAR coverage
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              {empty.length} of {coverage.sections.length} sections have no evidence yet. Some may not apply to this device.
            </p>
            <ul className="mt-2 space-y-1 text-sm" aria-label="eSTAR coverage">
              {coverage.sections.map((s) => (
                <li key={s.id} className="flex justify-between gap-2">
                  <span className={s.empty ? 'text-amber-800' : 'text-slate-900'}>{s.title}</span>
                  <span className={s.empty ? 'text-amber-800' : 'text-slate-600'}>{s.empty ? 'No evidence yet' : `${s.fileCount} file${s.fileCount === 1 ? '' : 's'}`}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-slate-500">Sections from FDA&apos;s eSTAR 510(k) guidance (October 2, 2023), Table 1.</p>
          </section>
        )}
      </div>
    </div>
  );
}
