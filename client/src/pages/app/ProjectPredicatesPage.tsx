import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { FormMessage } from '../../components/auth/AuthUi';
import { usePageMeta } from '../../hooks/usePageMeta';
import { ApiError } from '../../lib/api';
import {
  Candidate,
  Comparison,
  COMPARISON_LABEL,
  flagLabel,
  LEVEL_LABEL,
  predicatesApi,
  SearchMode,
  SearchResult,
  SeCell,
  SeComparison,
} from '../../lib/predicatesApi';
import { saveBlob } from '../../lib/trustApi';

const card = 'rounded-2xl border border-slate-200 bg-white p-5 shadow-sm';
const input = 'mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
const primary = 'rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700';
const secondary = 'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:border-brand-400';
const small = 'rounded border border-slate-300 bg-white px-2 py-0.5 text-xs font-medium text-slate-700 hover:border-brand-400';
const message = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

const FLAG_CLASS = { clean: 'text-emerald-700', recall_linked: 'font-semibold text-red-700', unknown: 'text-amber-700' } as const;

function Sources({ cell }: { cell: SeCell }): JSX.Element {
  if (!cell.citations.length) return <span className="text-xs text-slate-400">No source found</span>;
  return (
    <span className="block text-xs text-slate-500">
      {cell.citations.map((c) => (c.marker ? `${c.label} ${c.marker}` : c.label)).join('; ')}
    </span>
  );
}

/**
 * F5.2 predicates and SE comparison (UI 2.0 §7.2): search candidate predicates by product code,
 * keyword or meaning, each with IFU and technology similarity (an estimate from word overlap) and
 * recall flags (a recall-linked predicate is never shown clean); build a cited SE comparison,
 * set each row's comparison, and export it to Word and Excel. MedexRegAI never decides
 * substantial equivalence.
 */
export default function ProjectPredicatesPage(): JSX.Element {
  const { projectId = '' } = useParams();
  const { authedRequest } = useAuth();
  const api = useMemo(() => predicatesApi(authedRequest, projectId), [authedRequest, projectId]);
  usePageMeta({ title: 'Predicates and research', description: 'Predicate search and substantial-equivalence comparison.' });

  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [comparisons, setComparisons] = useState<SeComparison[] | null>(null);
  const [open, setOpen] = useState<SeComparison | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .comparisons()
      .then((r) => setComparisons(r.items))
      .catch((err: unknown) => setError(message(err, 'Could not load the comparisons.')));
  }, [api]);
  useEffect(load, [load]);

  const act = async (fn: () => Promise<void>, fallback: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError(message(err, fallback));
    } finally {
      setBusy(false);
    }
  };

  const search = (mode: SearchMode) =>
    act(async () => {
      if (mode !== 'product_code' && query.trim().length < 2) throw new ApiError(400, 'VALIDATION_ERROR', 'Type at least two characters to search.');
      const r = await api.search({ mode, q: mode === 'product_code' ? undefined : query.trim() });
      setResult(r);
      setNotice(`${r.items.length} candidate predicate${r.items.length === 1 ? '' : 's'} found.`);
    }, 'Could not search FDA data.');

  const more = () =>
    act(async () => {
      if (!result?.nextCursor) return;
      const r = await api.search({ mode: result.mode, q: result.query ?? undefined, productCode: result.productCode ?? undefined, cursor: result.nextCursor });
      setResult({ ...r, items: [...result.items, ...r.items] });
    }, 'Could not load more candidates.');

  const compare = (c: Candidate) =>
    act(async () => {
      const existing = comparisons?.find((x) => x.predicateKNumber === c.kNumber);
      const sc = existing ? await api.get(existing.id) : await api.compare(c.kNumber);
      setOpen(sc);
      setNotice(existing ? `Opened the comparison with ${c.kNumber}.` : `Comparison with ${c.kNumber} built: ${sc.counts.rows} rows, ${sc.counts.review} to review.`);
      load();
    }, 'Could not build the comparison.');

  const openComparison = (id: string) => act(async () => setOpen(await api.get(id)), 'Could not open the comparison.');

  const setComparison = (key: string, comparison: Comparison) =>
    act(async () => {
      if (!open) return;
      setOpen(await api.editRow(open.id, key, { comparison }));
      setNotice(`${open.rows.find((r) => r.key === key)?.attribute ?? 'Row'} marked ${COMPARISON_LABEL[comparison].toLowerCase()}.`);
      load();
    }, 'Could not save the row.');

  const saveNote = (key: string) =>
    act(async () => {
      if (!open) return;
      setOpen(await api.editRow(open.id, key, { note: (notes[key] ?? '').trim() || null }));
      setNotice('Note saved.');
    }, 'Could not save the note.');

  const rebuild = () =>
    act(async () => {
      if (!open) return;
      setOpen(await api.rebuild(open.id));
      setNotice('Comparison rebuilt; your edited rows were kept.');
    }, 'Could not rebuild the comparison.');

  const remove = () =>
    act(async () => {
      if (!open) return;
      await api.remove(open.id);
      setOpen(null);
      setNotice('Comparison deleted.');
      load();
    }, 'Could not delete the comparison.');

  const download = (format: 'docx' | 'xlsx') =>
    act(async () => {
      if (!open) return;
      saveBlob(await api.exportFile(open.id, format), `SE comparison ${open.predicateKNumber}.${format}`);
      setNotice(format === 'docx' ? 'Word file downloaded.' : 'Excel file downloaded.');
    }, 'Could not export the comparison.');

  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
      <p className="text-sm text-slate-500">
        <Link to={`/app/projects/${projectId}`} className="hover:underline">
          Project
        </Link>{' '}
        / Predicates and research
      </p>
      <h1 className="mt-1 text-2xl font-bold text-slate-900">Predicates and research</h1>
      <p className="mt-1 max-w-3xl text-sm text-slate-600">
        Candidate predicates from FDA&apos;s 510(k), classification and recall data. Similarity is an estimate from the words your client&apos;s files share with
        each predicate&apos;s 510(k) summary; a predicate with a linked recall is never shown as clean. You decide substantial equivalence.
      </p>
      <div aria-live="polite" className="mt-3 space-y-2">
        {notice && <FormMessage tone="success">{notice}</FormMessage>}
        {error && <FormMessage tone="error">{error}</FormMessage>}
      </div>

      <section className={`${card} mt-6`} aria-label="Search predicates">
        <label className="block text-sm font-medium text-slate-900">
          Device name, keywords or a description
          <input name="predicateQuery" className={input} value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={primary} onClick={() => void search('keyword')}>
            Search by keyword
          </button>
          <button type="button" className={secondary} onClick={() => void search('semantic')}>
            Search by meaning
          </button>
          <button type="button" className={secondary} onClick={() => void search('product_code')}>
            Search by the device&apos;s product code
          </button>
        </div>
      </section>

      {result && (
        <section className="mt-6" aria-label="Candidate predicates">
          <h2 className="text-lg font-semibold text-slate-900">Candidate predicates</h2>
          {!result.subject.hasIfuText && (
            <p className="mt-1 text-sm text-amber-700">No indications for use found in this project&apos;s files yet, so IFU similarity is not known.</p>
          )}
          {result.items.length === 0 ? (
            <p className="mt-2 text-sm text-slate-600">No 510(k)s match.</p>
          ) : (
            <ul className="mt-3 space-y-3">
              {result.items.map((c) => (
                <li key={c.kNumber} className={`${card} flex flex-wrap items-start justify-between gap-3`}>
                  <div className="min-w-0 max-w-3xl">
                    <p className="font-semibold text-slate-900">
                      {c.kNumber} · {c.deviceName ?? 'Unnamed device'}
                    </p>
                    <p className="text-sm text-slate-600">
                      {[c.applicant, c.productCode && `product code ${c.productCode}`, c.decisionDate && `cleared ${c.decisionDate}`].filter(Boolean).join(' · ')}
                    </p>
                    <p className="mt-1 text-sm text-slate-700">
                      IFU {LEVEL_LABEL[c.similarity.ifu]} · technology {LEVEL_LABEL[c.similarity.tech]} ·{' '}
                      <span className={FLAG_CLASS[c.flags.status]}>{flagLabel(c.flags)}</span>
                    </p>
                    {c.matched && <p className="mt-1 line-clamp-2 text-xs text-slate-500">Matched: {c.matched.text}</p>}
                  </div>
                  <button type="button" className={secondary} onClick={() => void compare(c)}>
                    Compare with {c.kNumber}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {result.nextCursor && (
            <button type="button" className={`${secondary} mt-3`} onClick={() => void more()}>
              More candidates
            </button>
          )}
        </section>
      )}

      {comparisons && comparisons.length > 0 && (
        <section className="mt-8" aria-label="SE comparisons">
          <h2 className="text-lg font-semibold text-slate-900">SE comparisons</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            {comparisons.map((c) => (
              <button key={c.id} type="button" className={secondary} onClick={() => void openComparison(c.id)}>
                Open {c.predicateKNumber} ({c.counts.review} to review)
              </button>
            ))}
          </div>
        </section>
      )}

      {open && (
        <section className={`${card} mt-6`} aria-label="SE comparison">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">
                SE comparison with {open.predicateKNumber}
                {open.predicateDeviceName ? ` · ${open.predicateDeviceName}` : ''}
              </h2>
              <p className="text-sm text-slate-600">
                {open.counts.same} same · {open.counts.different} different · {open.counts.review} to review · {open.counts.edited} edited by you
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={secondary} onClick={() => void download('docx')}>
                Export to Word
              </button>
              <button type="button" className={secondary} onClick={() => void download('xlsx')}>
                Export to Excel
              </button>
              <button type="button" className={secondary} onClick={() => void rebuild()}>
                Rebuild
              </button>
              <button type="button" className={secondary} onClick={() => void remove()}>
                Delete comparison
              </button>
            </div>
          </div>
          <table className="mt-4 w-full text-left text-sm">
            <thead className="text-xs uppercase text-slate-500">
              <tr>
                <th className="py-1 pr-3">Attribute</th>
                <th className="py-1 pr-3">Subject device</th>
                <th className="py-1 pr-3">Predicate device</th>
                <th className="py-1">Comparison</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 align-top">
              {open.rows.map((r) => (
                <tr key={r.key}>
                  <td className="py-2 pr-3 font-medium text-slate-900">
                    {r.attribute}
                    {r.edited && <span className="block text-xs font-normal text-slate-500">edited</span>}
                  </td>
                  <td className="py-2 pr-3 text-slate-800">
                    {r.subject.text || <span className="text-slate-400">—</span>}
                    <Sources cell={r.subject} />
                  </td>
                  <td className="py-2 pr-3 text-slate-800">
                    {r.predicate.text || <span className="text-slate-400">—</span>}
                    <Sources cell={r.predicate} />
                  </td>
                  <td className="py-2">
                    <p className="font-semibold text-slate-900">{COMPARISON_LABEL[r.comparison]}</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {(['same', 'different', 'review'] as Comparison[])
                        .filter((x) => x !== r.comparison)
                        .map((x) => (
                          <button key={x} type="button" className={small} onClick={() => void setComparison(r.key, x)}>
                            {x === 'review' ? `Back to review: ${r.attribute}` : `${COMPARISON_LABEL[x]}: ${r.attribute}`}
                          </button>
                        ))}
                    </div>
                    {r.note && <p className="mt-1 text-xs text-slate-600">{r.note}</p>}
                    <label className="mt-1 block text-xs text-slate-600">
                      Note
                      <input
                        name={`note-${r.key}`}
                        className="mt-0.5 block w-full rounded border border-slate-300 px-2 py-1 text-xs"
                        value={notes[r.key] ?? ''}
                        onChange={(e) => setNotes({ ...notes, [r.key]: e.target.value })}
                      />
                    </label>
                    <button type="button" className={`${small} mt-1`} onClick={() => void saveNote(r.key)}>
                      Save note: {r.attribute}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </section>
  );
}
