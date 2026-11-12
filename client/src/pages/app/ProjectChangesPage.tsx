import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { FormMessage } from '../../components/auth/AuthUi';
import { usePageMeta } from '../../hooks/usePageMeta';
import { ApiError } from '../../lib/api';
import { ACTION_LABEL, Impact, ImpactItem, impactApi, Revision } from '../../lib/impactApi';

const card = 'rounded-2xl border border-slate-200 bg-white p-5 shadow-sm';
const message = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);
const KIND_LABEL: Record<ImpactItem['kind'], string> = { draft: 'Draft', problem: 'Problem', request_item: 'Client request' };

function ItemRow({ item }: { item: ImpactItem }): JSX.Element {
  return (
    <tr className="border-t border-slate-100 align-top">
      <td className="py-3 pr-4">
        <span className="block text-xs uppercase tracking-wide text-slate-500">{KIND_LABEL[item.kind]}</span>
        <span className="font-medium text-slate-900">{item.title}</span>
      </td>
      <td className="py-3 pr-4 text-sm text-slate-700">
        {item.detail}
        {item.statements && item.statements.length > 0 && (
          <details className="mt-1">
            <summary className="cursor-pointer text-xs text-brand-700">Show the statements</summary>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-slate-600">
              {item.statements.map((s) => (
                <li key={s.statementId}>
                  {s.text} <span className="text-slate-400">(cites v{s.citedVersionNo})</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </td>
      <td className="py-3 text-sm">
        {item.handled ? (
          <span className="text-emerald-800">
            {ACTION_LABEL[item.handled.action]} · {item.handled.by ?? 'someone'} · {new Date(item.handled.at).toLocaleString()}
          </span>
        ) : (
          <span className="text-slate-600">Suggested: {ACTION_LABEL[item.suggested]}</span>
        )}
      </td>
    </tr>
  );
}

function ImpactView({ impact }: { impact: Impact }): JSX.Element {
  if (!impact.previous) return <p className="text-sm text-slate-600">This is the first version of the file; nothing relied on an earlier one.</p>;
  return (
    <div className="space-y-6">
      <section className={card} aria-labelledby="affects-title">
        <h2 id="affects-title" className="text-lg font-semibold text-slate-900">
          What this change affects · {impact.items.filter((i) => i.stillAffected).length}
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Everything that relied on v{impact.previous.versionNo}. Nothing is re-drafted or changed until you choose. The old version stays in the record.
        </p>
        {impact.items.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600">Nothing in the drafts, problems or client requests relied on the old version.</p>
        ) : (
          <table className="mt-3 w-full text-left">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="pb-1 pr-4 font-medium">Where</th>
                <th className="pb-1 pr-4 font-medium">What relied on v{impact.previous.versionNo}</th>
                <th className="pb-1 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {impact.items.map((i) => (
                <ItemRow key={i.key} item={i} />
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className={card} aria-labelledby="changed-title">
        <h2 id="changed-title" className="text-lg font-semibold text-slate-900">
          What changed in v{impact.version.versionNo}
        </h2>
        {impact.changes.length === 0 && impact.passages.length === 0 ? (
          <p className="mt-1 text-sm text-slate-600">The text of the two versions is the same.</p>
        ) : (
          <ul className="mt-2 space-y-2 text-sm">
            {impact.changes.map((c) => (
              <li key={c.topicKey}>
                <span className="font-medium text-slate-900">{c.label}:</span> {c.before ?? 'not stated'} → {c.after ?? 'no longer stated'}
              </li>
            ))}
            {impact.passages.map((p, i) => (
              <li key={i} className="rounded-lg bg-slate-50 p-2">
                {p.before && <span className="block text-rose-800 line-through decoration-rose-300">{p.before}</span>}
                {p.after && <span className="block text-emerald-800">{p.after}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * F3.3 Changes (UI 2.0 §5.3): each new version a client sends, and what it affects. Because
 * every drafted statement knows its source, a new revision shows exactly what needs to change.
 */
export default function ProjectChangesPage(): JSX.Element {
  const { projectId = '' } = useParams();
  const { authedRequest } = useAuth();
  const api = useMemo(() => impactApi(authedRequest, projectId), [authedRequest, projectId]);
  usePageMeta({ title: 'Changes', description: 'New client file versions and what they affect.' });
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .revisions()
      .then((r) => {
        setRevisions(r);
        setOpenId((cur) => cur ?? r[0]?.version.id ?? null);
      })
      .catch((err: unknown) => setError(message(err, 'Could not load the changes.')));
  }, [api]);
  const loadImpact = useCallback(
    (versionId: string) =>
      api
        .impact(versionId)
        .then(setImpact)
        .catch((err: unknown) => setError(message(err, 'Could not load what this version affects.'))),
    [api],
  );
  useEffect(() => {
    if (openId) void loadImpact(openId);
  }, [openId, loadImpact]);

  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
      <nav aria-label="Breadcrumb" className="text-sm text-slate-500">
        <Link to={`/app/projects/${projectId}`} className="hover:underline">
          Project
        </Link>{' '}
        › <span aria-current="page">Changes</span>
      </nav>
      <h1 className="mt-1 text-2xl font-bold text-slate-900">Changes</h1>
      <p className="mt-1 max-w-3xl text-sm text-slate-600">
        When a client sends a new version of a file, everything that cited the old one is listed here with what to do about it.
      </p>
      {error && (
        <div className="mt-3">
          <FormMessage tone="error">{error}</FormMessage>
        </div>
      )}
      {revisions === null ? (
        <p role="status" className="mt-6 text-slate-500">
          Loading…
        </p>
      ) : revisions.length === 0 ? (
        <div className={`${card} mt-6`}>
          <h2 className="font-semibold text-slate-900">No new versions yet</h2>
          <p className="mt-1 text-sm text-slate-600">When a client sends a revised file, it appears here with everything it affects.</p>
        </div>
      ) : (
        <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_3fr]">
          <ul className="space-y-2" aria-label="New versions">
            {revisions.map((r) => (
              <li key={r.version.id}>
                <button
                  type="button"
                  aria-pressed={openId === r.version.id}
                  onClick={() => setOpenId(r.version.id)}
                  className={`w-full rounded-xl border bg-white p-3 text-left text-sm shadow-sm hover:border-brand-400 ${openId === r.version.id ? 'border-brand-500' : 'border-slate-200'}`}
                >
                  <span className="block font-medium text-slate-900">{r.fileName}</span>
                  <span className="block text-xs text-slate-600">
                    v{r.version.versionNo} replaces v{r.previousVersionNo} · {new Date(r.version.createdAt).toLocaleDateString()}
                  </span>
                  <span className="block text-xs text-slate-600">
                    {r.affectedStatements} statement{r.affectedStatements === 1 ? '' : 's'} cite the old version
                    {r.handled > 0 && ` · ${r.handled} handled`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div>{impact && impact.version.id === openId ? <ImpactView impact={impact} /> : <p className="text-slate-500">Loading…</p>}</div>
        </div>
      )}
    </section>
  );
}
