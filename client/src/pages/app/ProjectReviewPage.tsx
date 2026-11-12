import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { FormMessage } from '../../components/auth/AuthUi';
import { usePageMeta } from '../../hooks/usePageMeta';
import { ApiError } from '../../lib/api';
import { BoardSection, Reviewer, SectionHistoryItem, SectionStatus, sectionsApi } from '../../lib/sectionsApi';
import { ADMIN_DOC_KINDS, AdminDocKind, AdminDocs, SummaryTable, submissionDocsApi } from '../../lib/submissionDocsApi';
import { saveBlob } from '../../lib/trustApi';

const STATUS_LABEL: Record<SectionStatus, string> = { not_started: 'Not started', drafting: 'Drafting', in_review: 'In review', approved: 'Approved' };
const COLUMNS: SectionStatus[] = ['not_started', 'drafting', 'in_review', 'approved'];
/** Where a section may go next, and how the move is worded (server/src/sections/SectionService.ts). */
const MOVES: Record<SectionStatus, { to: SectionStatus; label: string }[]> = {
  not_started: [{ to: 'drafting', label: 'Start drafting' }],
  drafting: [
    { to: 'in_review', label: 'Send for review' },
    { to: 'not_started', label: 'Back to not started' },
  ],
  in_review: [
    { to: 'approved', label: 'Approve' },
    { to: 'drafting', label: 'Send back to drafting' },
  ],
  approved: [{ to: 'drafting', label: 'Reopen' }],
};
const button = 'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:border-brand-400 disabled:opacity-60';
const primary = 'rounded-md bg-brand-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-60';
const message = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

function describe(h: SectionHistoryItem): string {
  if (h.event === 'status_changed') return `${STATUS_LABEL[h.fromStatus ?? 'not_started']} → ${STATUS_LABEL[h.toStatus ?? 'not_started']}`;
  return h.event === 'reviewer_assigned' ? `Reviewer: ${h.reviewer ?? 'someone'}` : `Reviewer removed (${h.reviewer ?? 'someone'})`;
}

/** The open section: move it along, assign its reviewer, see what happened to it. */
function SectionPanel({
  projectId,
  section,
  reviewers,
  history,
  busy,
  onChange,
}: {
  projectId: string;
  section: BoardSection;
  reviewers: Reviewer[];
  history: SectionHistoryItem[];
  busy: boolean;
  onChange: (change: { status?: SectionStatus; reviewerId?: string | null }) => void;
}): JSX.Element {
  return (
    <section aria-labelledby="panel-title" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 id="panel-title" className="text-lg font-semibold text-slate-900">
        {section.title}
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        {STATUS_LABEL[section.status]} · {section.fileCount} file{section.fileCount === 1 ? '' : 's'}
        {section.openProblems > 0 && ` · ${section.openProblems} open problem${section.openProblems === 1 ? '' : 's'}`}
        {section.approvedBy && ` · approved by ${section.approvedBy}`}
      </p>
      <Link to={`/app/projects/${projectId}/sections/${section.id}/draft`} className="mt-3 inline-block text-sm font-semibold text-brand-700 hover:underline">
        Open draft
      </Link>
      <div className="mt-3 flex flex-wrap gap-2">
        {MOVES[section.status].map((m, i) => (
          <button key={m.to} type="button" className={i === 0 ? primary : button} disabled={busy} onClick={() => onChange({ status: m.to })}>
            {m.label}
          </button>
        ))}
      </div>
      <label className="mt-4 block text-sm">
        <span className="font-medium text-slate-900">Reviewer</span>
        <select
          name="sectionReviewer"
          className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5"
          value={section.reviewer?.id ?? ''}
          disabled={busy}
          onChange={(e) => onChange({ reviewerId: e.target.value || null })}
        >
          <option value="">No reviewer</option>
          {reviewers.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      <p className="mt-1 text-xs text-slate-500">Only someone whose role can review drafts can approve a section or send it back.</p>
      <h3 className="mt-4 text-sm font-semibold text-slate-900">History</h3>
      {history.length === 0 ? (
        <p className="text-sm text-slate-500">No changes yet.</p>
      ) : (
        <ol className="mt-1 space-y-1 text-sm text-slate-700">
          {history.map((h, i) => (
            <li key={`${h.at}-${i}`}>
              {describe(h)} · {h.actor ?? 'someone'} · {new Date(h.at).toLocaleString()}
              {h.note && <span className="block text-slate-500">{h.note}</span>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const RESULT_LABEL = { pass: 'Pass', fail: 'Fail', not_stated: 'Not stated' } as const;

/**
 * F3.6 documents drafted from the project: the summary of testing (with its mismatches against
 * the drafts) and the four administrative documents, each downloadable, signatures left blank.
 */
function SubmissionDocsPanel({ projectId }: { projectId: string }): JSX.Element {
  const { authedRequest } = useAuth();
  const api = useMemo(() => submissionDocsApi(authedRequest, projectId), [authedRequest, projectId]);
  const [table, setTable] = useState<SummaryTable | null>(null);
  const [docs, setDocs] = useState<AdminDocs | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMismatches, setShowMismatches] = useState(false);
  useEffect(() => {
    Promise.all([api.summaryTable(), api.adminDocs()])
      .then(([t, d]) => {
        setTable(t);
        setDocs(d);
      })
      .catch((err: unknown) => setError(message(err, 'Could not prepare the documents.')));
  }, [api]);
  const download = async (work: () => Promise<Blob>, fileName: string) => {
    setBusy(true);
    setError(null);
    try {
      saveBlob(await work(), fileName);
    } catch (err) {
      setError(message(err, 'Could not download the document.'));
    } finally {
      setBusy(false);
    }
  };
  const mismatches = table?.rows.flatMap((r) => r.mismatches.map((m) => ({ report: r.report, ...m }))) ?? [];
  return (
    <section aria-labelledby="docs-title" className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 id="docs-title" className="text-lg font-semibold text-slate-900">
        Documents drafted from the project
      </h2>
      <p className="mt-1 max-w-3xl text-sm text-slate-600">
        Built from the filed test reports, the drafts and the project details. What the project does not hold is marked “To be completed”, and every signature field is
        left blank for the submitter.
      </p>
      {error && <FormMessage tone="error">{error}</FormMessage>}
      {table === null || docs === null ? (
        <p role="status" className="mt-3 text-sm text-slate-500">
          Preparing…
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-slate-100">
          <li className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div>
              <p className="font-medium text-slate-900">Summary of testing</p>
              <p className="text-sm text-slate-600">
                {table.reportCount} test report{table.reportCount === 1 ? '' : 's'} · {table.mismatchCount} mismatch{table.mismatchCount === 1 ? '' : 'es'} with the drafts
                {table.rows.length > 0 && ` · ${table.rows.map((r) => `${r.report}: ${RESULT_LABEL[r.result]}`).join('; ')}`}
              </p>
              {mismatches.length > 0 && (
                <button type="button" className="mt-1 text-sm font-semibold text-brand-700 hover:underline" onClick={() => setShowMismatches((v) => !v)}>
                  {showMismatches ? 'Hide mismatches' : 'Show mismatches'}
                </button>
              )}
              {showMismatches && (
                <ul className="mt-2 space-y-1 text-sm">
                  {mismatches.map((m, i) => (
                    <li key={i} className="rounded-lg bg-amber-50 p-2">
                      <span className="block font-medium text-amber-900">
                        {m.report} · {m.section}
                      </span>
                      <span className="block text-slate-700">{m.detail}</span>
                      <span className="block text-xs text-slate-500">“{m.statement}”</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <button type="button" className={button} disabled={busy} onClick={() => void download(api.summaryTableXlsx, 'Summary of testing.xlsx')}>
              Download Excel
            </button>
          </li>
          {ADMIN_DOC_KINDS.map((k: AdminDocKind) => {
            const d = docs.docs[k];
            return (
              <li key={k} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="font-medium text-slate-900">{d.title}</p>
                  <p className="text-sm text-slate-600">
                    {d.openItemCount === 0 ? 'Nothing to complete' : `${d.openItemCount} item${d.openItemCount === 1 ? '' : 's'} to complete`}
                    {d.signatureFields.length > 0 && (d.signaturesBlank ? ' · signature fields left blank' : ' · check the signature fields')}
                  </p>
                  {k === 'fda_3601' && <p className="text-xs text-slate-500">Form FDA 3601 itself is created in FDA&apos;s online user fee system; this sheet gathers what it asks for.</p>}
                  {k === 'truthful_accurate' && <p className="text-xs text-slate-500">FDA: signed by a responsible person of the submitting firm, not a consultant.</p>}
                </div>
                <button type="button" className={button} disabled={busy} aria-label={`Download ${d.title} in Word`} onClick={() => void download(() => api.adminDocDocx(k), `${d.title}.docx`)}>
                  Download Word
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * F3.1 Review board (UI 2.0 §5.1): the submission's eSTAR sections by status. Opening a
 * section shows how to move it along, its reviewer and its history. Approving or sending
 * a section back needs a role that can review drafts; the server enforces it and says so.
 */
export default function ProjectReviewPage(): JSX.Element {
  const { projectId = '' } = useParams();
  const { authedRequest } = useAuth();
  const api = useMemo(() => sectionsApi(authedRequest, projectId), [authedRequest, projectId]);
  usePageMeta({ title: 'Review board', description: 'Section status and reviewers for this submission.' });
  const [sections, setSections] = useState<BoardSection[] | null>(null);
  const [reviewers, setReviewers] = useState<Reviewer[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [history, setHistory] = useState<SectionHistoryItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .board()
      .then((b) => {
        setSections(b.sections);
        setReviewers(b.reviewers);
      })
      .catch((err: unknown) => setError(message(err, 'Could not load the review board.')));
  }, [api]);
  useEffect(load, [load]);
  useEffect(() => {
    if (!openId) return;
    api
      .history(openId)
      .then(setHistory)
      .catch(() => setHistory([]));
  }, [api, openId, sections]);

  const open = sections?.find((s) => s.id === openId) ?? null;
  const change = async (c: { status?: SectionStatus; reviewerId?: string | null }) => {
    if (!open) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await api.update(open.id, c);
      setSections((list) => (list ?? []).map((x) => (x.id === updated.id ? updated : x)));
      setNotice(
        c.status
          ? `${open.title} moved to ${STATUS_LABEL[updated.status]}.`
          : updated.reviewer
            ? `${updated.reviewer.name} will review ${open.title}.`
            : `${open.title} has no reviewer now.`,
      );
    } catch (err) {
      setError(message(err, 'Could not update the section.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6">
      <nav aria-label="Breadcrumb" className="text-sm text-slate-500">
        <Link to={`/app/projects/${projectId}`} className="hover:underline">
          Project
        </Link>{' '}
        › <span aria-current="page">Review</span>
      </nav>
      <h1 className="mt-1 text-2xl font-bold text-slate-900">Review board</h1>
      <p className="mt-1 max-w-3xl text-sm text-slate-600">
        Every eSTAR section of this submission, from not started to approved. Open a section to move it along and assign its reviewer.
      </p>
      <div aria-live="polite" className="mt-3 space-y-2">
        {notice && <FormMessage tone="success">{notice}</FormMessage>}
        {error && <FormMessage tone="error">{error}</FormMessage>}
      </div>
      {sections === null ? (
        <p role="status" className="mt-6 text-slate-500">
          Loading…
        </p>
      ) : (
        <div className="mt-6 grid gap-6 xl:grid-cols-[3fr_1fr]">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {COLUMNS.map((col) => {
              const list = sections.filter((s) => s.status === col);
              return (
                <section key={col} aria-labelledby={`col-${col}`} className="rounded-2xl bg-slate-50 p-3">
                  <h2 id={`col-${col}`} className="text-sm font-semibold text-slate-900">
                    {STATUS_LABEL[col]} · {list.length}
                  </h2>
                  <ul className="mt-2 space-y-2">
                    {list.map((s) => (
                      <li key={s.id}>
                        <button
                          type="button"
                          aria-pressed={openId === s.id}
                          onClick={() => setOpenId(s.id)}
                          className={`w-full rounded-xl border bg-white p-3 text-left text-sm shadow-sm hover:border-brand-400 ${openId === s.id ? 'border-brand-500' : 'border-slate-200'}`}
                        >
                          <span className="block font-medium text-slate-900">{s.title}</span>
                          <span className="block text-xs text-slate-600">
                            {s.reviewer ? `Reviewer: ${s.reviewer.name}` : 'No reviewer'} · {s.fileCount} file{s.fileCount === 1 ? '' : 's'}
                            {s.openProblems > 0 && ` · ${s.openProblems} open problem${s.openProblems === 1 ? '' : 's'}`}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
          {open ? (
            <SectionPanel projectId={projectId} section={open} reviewers={reviewers} history={history} busy={busy} onChange={(c) => void change(c)} />
          ) : (
            <p className="text-sm text-slate-600">Open a section to move it along or assign its reviewer.</p>
          )}
        </div>
      )}
      <SubmissionDocsPanel projectId={projectId} />
    </section>
  );
}
