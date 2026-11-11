import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/api';
import { filesApi, PassageView } from '../../lib/filesApi';

/**
 * Citation chips and the source viewer (F7.3). Any text that carries citation markers
 * ([C:<file_version_id>#<from>] or [C:<id>#<from>-<to>]) renders through <CitedText>;
 * each marker becomes a chip that opens the cited passages with their location.
 * Reused by the drafting screens (F2.3, F3.2).
 */

const MARKER = /\[C:([0-9a-f-]{36})#(\d+)(?:-(\d+))?\]/gi;

export interface ParsedCitation {
  versionId: string;
  from: number;
  to: number;
  marker: string;
}

export function parseCitation(marker: string): ParsedCitation | null {
  MARKER.lastIndex = 0;
  const m = MARKER.exec(marker);
  if (!m) return null;
  return { versionId: m[1], from: Number(m[2]), to: m[3] ? Number(m[3]) : Number(m[2]), marker: m[0] };
}

function SourceViewer({ citation, onClose }: { citation: ParsedCitation; onClose: () => void }): JSX.Element {
  const { authedRequest } = useAuth();
  const api = useMemo(() => filesApi(authedRequest), [authedRequest]);
  const [view, setView] = useState<PassageView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    close.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    api
      .passages(citation.versionId, citation.from, citation.to)
      .then(setView)
      .catch((err: unknown) => setError(err instanceof ApiError && err.status === 404 ? 'This source is no longer available.' : 'Could not open the source.'));
  }, [api, citation]);

  const cited = view?.passages.filter((p) => p.cited) ?? [];
  const where = cited.length ? (cited.length > 1 ? `${cited[0].where} to ${cited[cited.length - 1].where}` : cited[0].where) : '';
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 sm:items-center sm:p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="source-title"
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl bg-white p-6 shadow-xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="source-title" className="truncate text-lg font-semibold text-slate-900">
              {view ? view.fileName : 'Source'}
            </h2>
            {view && (
              <p className="text-sm text-slate-600">
                Version {view.versionNo} · {where}
              </p>
            )}
          </div>
          <button
            ref={close}
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-800 hover:border-brand-400"
          >
            Close
          </button>
        </div>
        {error && <p className="mt-4 text-sm text-red-700">{error}</p>}
        {!view && !error && (
          <p role="status" className="mt-4 text-sm text-slate-500">
            Opening the source…
          </p>
        )}
        {view && !view.current && (
          <p role="alert" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            This cites version {view.versionNo}; the file is now at version {view.currentVersionNo ?? '?'}. Check the statement against the newer version.
          </p>
        )}
        {view && (
          <ol className="mt-4 space-y-3">
            {view.passages.map((p) => (
              <li key={p.ordinal} className={p.cited ? 'rounded-lg border-l-4 border-brand-600 bg-brand-50 p-3' : 'px-3 text-slate-500'}>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  {p.where}
                  {p.cited ? ' · cited' : ''}
                </p>
                <p className={`mt-1 whitespace-pre-wrap text-sm ${p.cited ? 'text-slate-900' : ''}`}>{p.text}</p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

/** A citation as a small button; opens the source viewer. */
export function CitationChip({ marker, label }: { marker: string; label?: string }): JSX.Element | null {
  const citation = useMemo(() => parseCitation(marker), [marker]);
  const [open, setOpen] = useState(false);
  if (!citation) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Open source${label ? `: ${label}` : ''}`}
        className="mx-0.5 inline-flex items-center rounded-full border border-brand-100 bg-brand-50 px-2 py-0.5 align-baseline text-xs font-semibold text-brand-700 hover:border-brand-600"
      >
        {label ?? 'Source'}
      </button>
      {open && <SourceViewer citation={citation} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Text with its citation markers turned into chips. */
export function CitedText({ text }: { text: string }): JSX.Element {
  const parts: (string | ParsedCitation)[] = [];
  let last = 0;
  MARKER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER.exec(text)) !== null) {
    parts.push(text.slice(last, m.index));
    parts.push({ versionId: m[1], from: Number(m[2]), to: m[3] ? Number(m[3]) : Number(m[2]), marker: m[0] });
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  let n = 0;
  return (
    <>{parts.map((p, i) => (typeof p === 'string' ? <Fragment key={i}>{p}</Fragment> : <CitationChip key={i} marker={p.marker} label={`Source ${++n}`} />))}</>
  );
}
