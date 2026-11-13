import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { FormMessage } from '../../components/auth/AuthUi';
import { usePageMeta } from '../../hooks/usePageMeta';
import { ApiError } from '../../lib/api';
import {
  addDays,
  clock,
  DeficiencyStatus,
  fdaLettersApi,
  KIND_LABEL,
  Letter,
  LetterKind,
  LetterSummary,
  Owner,
  Proposal,
  STATUS_LABEL,
} from '../../lib/fdaLettersApi';
import { FileSummary, filesApi } from '../../lib/filesApi';
import { EstarSection, sortingApi } from '../../lib/sortingApi';
import { saveBlob } from '../../lib/trustApi';

const card = 'rounded-2xl border border-slate-200 bg-white p-5 shadow-sm';
const input = 'mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
const primary = 'rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700';
const secondary = 'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:border-brand-400';
const message = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);
const RESPONSE_DAYS = 180;

interface DraftRow {
  keep: boolean;
  number: number;
  summary: string;
  fdaText: string;
  sectionId: string;
  owner: Owner;
  files: { id: string; name: string }[];
  statements: { id: string; text: string }[];
  cues: string[];
}

interface Draft {
  kind: LetterKind;
  fdaReference: string;
  issuedOn: string;
  dueOn: string;
  dueTouched: boolean;
  fileVersionId: string | null;
  rows: DraftRow[];
  notes: string[];
}

function fromProposal(p: Proposal, fileVersionId: string | null): Draft {
  return {
    kind: p.kind,
    fdaReference: p.fdaReference ?? '',
    issuedOn: p.issuedOn ?? '',
    dueOn: p.dueOn ?? '',
    dueTouched: false,
    fileVersionId,
    notes: p.notes,
    rows: p.deficiencies.map((d) => ({
      keep: true,
      number: d.number,
      summary: d.summary,
      fdaText: d.fdaText,
      sectionId: d.sectionId ?? '',
      owner: 'consultant',
      files: d.files,
      statements: d.statements,
      cues: d.sectionCues,
    })),
  };
}

/**
 * F5.1 FDA letter tracker (FR-14.23; UI 2.0 §7.1): the project's AI requests and RTA hold letters
 * with a deadline clock; each letter's numbered deficiencies with section, the client files and
 * drafted statements they affect, owner and status; a Word response skeleton. A new letter is
 * split from a forwarded file or pasted text, and saved only after the consultant confirms it.
 */
export default function ProjectFdaLettersPage(): JSX.Element {
  const { projectId = '' } = useParams();
  const { authedRequest } = useAuth();
  const api = useMemo(() => fdaLettersApi(authedRequest, projectId), [authedRequest, projectId]);
  usePageMeta({ title: 'FDA letters', description: 'Additional Information letters split into tracked deficiencies.' });

  const [letters, setLetters] = useState<LetterSummary[] | null>(null);
  const [open, setOpen] = useState<Letter | null>(null);
  const [sections, setSections] = useState<EstarSection[]>([]);
  const [files, setFiles] = useState<FileSummary[]>([]);
  const [source, setSource] = useState('');
  const [pasted, setPasted] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .list()
      .then((r) => setLetters(r.items))
      .catch((err: unknown) => setError(message(err, 'Could not load the letters.')));
  }, [api]);
  useEffect(load, [load]);
  useEffect(() => {
    sortingApi(authedRequest, projectId)
      .sections()
      .then((s) => setSections(s.filter((x) => x.takesEvidence)))
      .catch(() => setSections([]));
    filesApi(authedRequest)
      .list(projectId)
      .then((r) => setFiles(r.items.filter((f) => f.latest?.parseStatus === 'parsed')))
      .catch(() => setFiles([]));
  }, [authedRequest, projectId]);

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

  const split = () =>
    act(async () => {
      const file = files.find((f) => f.id === source);
      if (!file && !pasted.trim()) throw new ApiError(400, 'VALIDATION_ERROR', 'Choose the letter file or paste its text.');
      const versionId = file?.latest?.id ?? null;
      const p = await api.split(versionId ? { fileVersionId: versionId } : { text: pasted });
      setDraft(fromProposal(p, versionId));
    }, 'Could not split the letter.');

  const save = () =>
    act(async () => {
      if (!draft) return;
      if (!draft.issuedOn) throw new ApiError(400, 'VALIDATION_ERROR', 'Enter the letter date.');
      const saved = await api.create({
        kind: draft.kind,
        fdaReference: draft.fdaReference.trim() || null,
        issuedOn: draft.issuedOn,
        dueOn: draft.dueOn || null,
        fileVersionId: draft.fileVersionId,
        deficiencies: draft.rows
          .filter((r) => r.keep)
          .map((r) => ({
            number: r.number,
            summary: r.summary.trim(),
            fdaText: r.fdaText.trim() || r.summary.trim(),
            sectionId: r.sectionId || null,
            owner: r.owner,
            fileIds: r.files.map((f) => f.id),
            statementIds: r.statements.map((s) => s.id),
          })),
      });
      setDraft(null);
      setPasted('');
      setSource('');
      setOpen(saved);
      setNotice(`Letter saved with ${saved.deficiencyCount} deficienc${saved.deficiencyCount === 1 ? 'y' : 'ies'}. Response due ${saved.dueOn}.`);
      load();
    }, 'Could not save the letter.');

  const openLetter = (id: string) => act(async () => setOpen(await api.get(id)), 'Could not open the letter.');
  const skeleton = (l: LetterSummary) =>
    act(async () => {
      saveBlob(await api.skeleton(l.id), `Response skeleton${l.fdaReference ? ` ${l.fdaReference}` : ''} ${l.issuedOn}.docx`);
      setNotice('Response skeleton downloaded.');
    }, 'Could not export the response skeleton.');
  const setLetterStatus = (status: 'open' | 'responded') =>
    act(async () => {
      if (!open) return;
      setOpen(await api.update(open.id, { status }));
      setNotice(status === 'responded' ? 'Marked as responded.' : 'Reopened.');
      load();
    }, 'Could not update the letter.');
  const removeLetter = () =>
    act(async () => {
      if (!open) return;
      await api.remove(open.id);
      setOpen(null);
      setNotice('Letter deleted.');
      load();
    }, 'Could not delete the letter.');
  // A table edit saves on its own and never blocks the page's other buttons.
  const changeDeficiency = async (id: string, body: { status?: DeficiencyStatus; owner?: Owner; sectionId?: string | null }) => {
    if (!open) return;
    setError(null);
    try {
      const d = await api.updateDeficiency(id, body);
      setOpen(await api.get(open.id));
      setNotice(`Saved the change to deficiency ${d.number}.`);
      load();
    } catch (err) {
      setError(message(err, 'Could not update the deficiency.'));
    }
  };

  const editRow = (i: number, patch: Partial<DraftRow>) => setDraft((d) => (d ? { ...d, rows: d.rows.map((r, k) => (k === i ? { ...r, ...patch } : r)) } : d));
  const addRow = () =>
    setDraft((d) =>
      d
        ? {
            ...d,
            rows: [...d.rows, { keep: true, number: Math.max(0, ...d.rows.map((r) => r.number)) + 1, summary: '', fdaText: '', sectionId: '', owner: 'consultant', files: [], statements: [], cues: [] }],
          }
        : d,
    );
  const sectionSelect = (value: string, onChange: (v: string) => void, name: string) => (
    <select name={name} aria-label="eSTAR section" className={input} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">No section</option>
      {sections.map((s) => (
        <option key={s.id} value={s.id}>
          {s.title}
        </option>
      ))}
    </select>
  );

  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
      <p className="text-sm text-slate-500">
        <Link to={`/app/projects/${projectId}`} className="hover:underline">
          Project
        </Link>{' '}
        / FDA letters
      </p>
      <h1 className="mt-1 text-2xl font-bold text-slate-900">FDA letters</h1>
      <p className="mt-1 max-w-3xl text-sm text-slate-600">
        Additional Information requests and RTA holds, split into FDA&apos;s numbered deficiencies. FDA must receive a complete response to an AI request within 180 calendar
        days of the letter date, with no extensions; an RTA hold also gives 180 calendar days.
      </p>
      <div aria-live="polite" className="mt-3 space-y-2">
        {notice && <FormMessage tone="success">{notice}</FormMessage>}
        {error && <FormMessage tone="error">{error}</FormMessage>}
      </div>

      {/* Letters with their deadline clock */}
      <div className="mt-6 space-y-3">
        {letters === null ? (
          <p role="status" className="text-slate-500">
            Loading…
          </p>
        ) : letters.length === 0 ? (
          <p className="text-sm text-slate-600">No FDA letters logged for this project.</p>
        ) : (
          letters.map((l) => (
            <div key={l.id} className={`${card} flex flex-wrap items-center justify-between gap-3`}>
              <div>
                <p className="font-semibold text-slate-900">
                  {KIND_LABEL[l.kind]}
                  {l.fdaReference ? ` · ${l.fdaReference}` : ''} · letter of {l.issuedOn}
                </p>
                <p className="text-sm text-slate-600">
                  {l.deficiencyCount} deficienc{l.deficiencyCount === 1 ? 'y' : 'ies'} · {l.answeredCount} answered ·{' '}
                  {l.status === 'open' ? `response due ${l.dueOn} (${clock(l.daysLeft)})` : l.status === 'responded' ? `responded ${l.respondedOn ?? ''}` : 'closed'}
                </p>
              </div>
              <div className="flex gap-2">
                <button type="button" className={secondary} onClick={() => void openLetter(l.id)}>
                  Open letter of {l.issuedOn}
                </button>
                <button type="button" className={secondary} onClick={() => void skeleton(l)}>
                  Export response skeleton (Word)
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* One letter's deficiencies */}
      {open && (
        <section className={`${card} mt-6`} aria-label="Deficiencies">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-slate-900">
              {KIND_LABEL[open.kind]} of {open.issuedOn}: {open.deficiencyCount} deficienc{open.deficiencyCount === 1 ? 'y' : 'ies'}
            </h2>
            <div className="flex gap-2">
              {open.status === 'open' ? (
                <button type="button" className={secondary} onClick={() => void setLetterStatus('responded')}>
                  Mark responded
                </button>
              ) : (
                <button type="button" className={secondary} onClick={() => void setLetterStatus('open')}>
                  Reopen
                </button>
              )}
              <button type="button" className={secondary} onClick={() => void removeLetter()}>
                Delete letter
              </button>
            </div>
          </div>
          <table className="mt-3 w-full text-left text-sm">
            <thead className="text-xs uppercase text-slate-500">
              <tr>
                <th className="py-1 pr-3">#</th>
                <th className="py-1 pr-3">Deficiency</th>
                <th className="py-1 pr-3">Section</th>
                <th className="py-1 pr-3">Affected files and statements</th>
                <th className="py-1 pr-3">Owner</th>
                <th className="py-1">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 align-top">
              {open.deficiencies.map((d) => (
                <tr key={d.id}>
                  <td className="py-2 pr-3 font-semibold">{d.number}</td>
                  <td className="py-2 pr-3 text-slate-800">
                    {d.summary}
                    <details className="mt-1 text-xs text-slate-600">
                      <summary className="cursor-pointer">FDA&apos;s text</summary>
                      <p className="mt-1 whitespace-pre-wrap">{d.fdaText}</p>
                    </details>
                  </td>
                  <td className="py-2 pr-3">{sectionSelect(d.sectionId ?? '', (v) => void changeDeficiency(d.id, { sectionId: v || null }), `section-${d.number}`)}</td>
                  <td className="py-2 pr-3 text-slate-700">
                    {d.files.map((f) => (
                      <div key={f.id}>{f.name}</div>
                    ))}
                    {d.statements.length > 0 && <div className="text-xs text-slate-500">{d.statements.length} drafted statements</div>}
                    {!d.files.length && !d.statements.length && <span className="text-slate-400">None linked</span>}
                  </td>
                  <td className="py-2 pr-3">
                    <select name={`owner-${d.number}`} aria-label="Owner" className={input} value={d.owner} onChange={(e) => void changeDeficiency(d.id, { owner: e.target.value as Owner })}>
                      <option value="consultant">Consultant</option>
                      <option value="client">Client</option>
                    </select>
                  </td>
                  <td className="py-2">
                    <select
                      name={`status-${d.number}`}
                      aria-label="Status"
                      className={input}
                      value={d.status}
                      onChange={(e) => void changeDeficiency(d.id, { status: e.target.value as DeficiencyStatus })}
                    >
                      {(Object.keys(STATUS_LABEL) as DeficiencyStatus[]).map((s) => (
                        <option key={s} value={s}>
                          {STATUS_LABEL[s]}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Log a letter: split, check, save */}
      <section className={`${card} mt-8`} aria-label="Log a letter">
        <h2 className="text-lg font-semibold text-slate-900">Log a letter</h2>
        {!draft ? (
          <div className="mt-3 space-y-3">
            <label className="block text-sm font-medium text-slate-900">
              The letter, as a file in this project (forwarded or uploaded)
              <select name="letterFile" className={input} value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="">Paste the text instead</option>
                {files.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            {!source && (
              <label className="block text-sm font-medium text-slate-900">
                Letter text
                <textarea name="letterText" rows={8} className={input} value={pasted} onChange={(e) => setPasted(e.target.value)} />
              </label>
            )}
            <button type="button" className={primary} onClick={() => void split()}>
              Split into deficiencies
            </button>
          </div>
        ) : (
          <div className="mt-3 space-y-4">
            <p className="text-sm text-slate-700">Check the split against the letter. Nothing is saved until you save it.</p>
            {draft.notes.map((n) => (
              <FormMessage key={n} tone="error">
                {n}
              </FormMessage>
            ))}
            <div className="grid gap-3 sm:grid-cols-4">
              <label className="text-sm font-medium text-slate-900">
                Kind
                <select name="letterKind" className={input} value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as LetterKind })}>
                  <option value="ai_request">{KIND_LABEL.ai_request}</option>
                  <option value="rta_hold">{KIND_LABEL.rta_hold}</option>
                </select>
              </label>
              <label className="text-sm font-medium text-slate-900">
                FDA reference
                <input name="fdaReference" className={input} value={draft.fdaReference} onChange={(e) => setDraft({ ...draft, fdaReference: e.target.value })} />
              </label>
              <label className="text-sm font-medium text-slate-900">
                Letter date
                <input
                  type="date"
                  name="issuedOn"
                  className={input}
                  value={draft.issuedOn}
                  onChange={(e) =>
                    setDraft({ ...draft, issuedOn: e.target.value, dueOn: draft.dueTouched || !e.target.value ? draft.dueOn : addDays(e.target.value, RESPONSE_DAYS) })
                  }
                />
              </label>
              <label className="text-sm font-medium text-slate-900">
                Response due
                <input type="date" name="dueOn" className={input} value={draft.dueOn} onChange={(e) => setDraft({ ...draft, dueOn: e.target.value, dueTouched: true })} />
              </label>
            </div>
            <p className="text-sm text-slate-600">
              {draft.rows.filter((r) => r.keep).length} deficiencies to save
              {draft.dueOn ? ` · response due ${draft.dueOn}` : ''}
            </p>
            {draft.rows.map((r, i) => (
              <div key={i} className={`rounded-md border p-3 ${r.keep ? 'border-slate-200' : 'border-dashed border-slate-300 opacity-60'}`}>
                <div className="grid gap-3 sm:grid-cols-6">
                  <label className="text-sm font-medium text-slate-900">
                    Number
                    <input
                      type="number"
                      min={1}
                      name={`number-${i}`}
                      className={input}
                      value={r.number}
                      onChange={(e) => editRow(i, { number: Number(e.target.value) || r.number })}
                    />
                  </label>
                  <label className="text-sm font-medium text-slate-900 sm:col-span-3">
                    Summary
                    <input name={`summary-${i}`} className={input} value={r.summary} onChange={(e) => editRow(i, { summary: e.target.value })} />
                  </label>
                  <label className="text-sm font-medium text-slate-900 sm:col-span-2">
                    Section
                    {sectionSelect(r.sectionId, (v) => editRow(i, { sectionId: v }), `draftSection-${i}`)}
                  </label>
                </div>
                {r.cues.length > 0 && <p className="mt-1 text-xs text-slate-500">Section suggested from: {r.cues.join(', ')}</p>}
                <label className="mt-2 block text-sm font-medium text-slate-900">
                  FDA&apos;s text
                  <textarea name={`fdaText-${i}`} rows={3} className={input} value={r.fdaText} onChange={(e) => editRow(i, { fdaText: e.target.value })} />
                </label>
                <p className="mt-2 text-sm text-slate-700">
                  Affected: {r.files.length ? r.files.map((f) => f.name).join(', ') : 'no files found'}
                  {r.statements.length ? ` · ${r.statements.length} drafted statements` : ''}
                  {r.files.length > 0 && (
                    <button type="button" className="ml-2 text-xs font-semibold text-brand-700 hover:underline" onClick={() => editRow(i, { files: [], statements: [] })}>
                      Unlink files for deficiency {r.number}
                    </button>
                  )}
                </p>
                <button type="button" className="mt-2 text-xs font-semibold text-brand-700 hover:underline" onClick={() => editRow(i, { keep: !r.keep })}>
                  {r.keep ? `Leave out deficiency ${r.number}` : `Keep deficiency ${r.number}`}
                </button>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <button type="button" className={secondary} onClick={addRow}>
                Add a deficiency
              </button>
              <button type="button" className={primary} onClick={() => void save()}>
                Save letter
              </button>
              <button type="button" className={secondary} onClick={() => setDraft(null)}>
                Discard split
              </button>
            </div>
          </div>
        )}
      </section>
    </section>
  );
}
