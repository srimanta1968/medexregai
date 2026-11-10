import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { FormMessage } from '../../components/auth/AuthUi';
import { usePageMeta } from '../../hooks/usePageMeta';
import { ApiError } from '../../lib/api';
import {
  FileDetail,
  FileSummary,
  filesApi,
  PARSE_LABELS,
  PHI_LABELS,
  PHI_TYPE_LABELS,
  ParseStatus,
  PhiStatus,
  unitLabel,
  VersionDetail,
} from '../../lib/filesApi';
import { ProjectDetail, workspaceApi } from '../../lib/workspaceApi';

const card = 'rounded-2xl border border-slate-200 bg-white p-6 shadow-sm';
const button = 'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:border-brand-400 disabled:opacity-60';
/** While anything is waiting or being read, refresh this often. Live push (SSE) arrives with F8.2. */
const REFRESH_MS = 2500;

const PARSE_TONE: Record<ParseStatus, string> = {
  queued: 'bg-slate-100 text-slate-700',
  parsing: 'bg-sky-50 text-sky-800',
  parsed: 'bg-emerald-50 text-emerald-800',
  failed: 'bg-red-50 text-red-800',
  unsupported: 'bg-amber-50 text-amber-900',
};
const PHI_TONE: Record<PhiStatus, string> = {
  not_scanned: 'text-slate-500',
  clean: 'text-slate-600',
  flagged: 'font-semibold text-red-700',
  redacted: 'text-slate-600',
  accepted: 'text-slate-600',
};

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function Badge({ status }: { status: ParseStatus }): JSX.Element {
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${PARSE_TONE[status]}`}>{PARSE_LABELS[status]}</span>;
}

/** The redaction prompt for one flagged version (NFR-9). */
function PhiPrompt({ version, onDecide, busy }: { version: VersionDetail; onDecide: (d: 'redacted' | 'accepted') => void; busy: boolean }): JSX.Element {
  const high = version.phiFindings.filter((f) => f.confidence === 'high');
  const low = version.phiFindings.filter((f) => f.confidence === 'low');
  return (
    <div role="alert" className="mt-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
      <p className="font-semibold">This file may contain patient data</p>
      <p className="mt-1">
        510(k) evidence should not identify patients. Remove these details and add the redacted copy with the same file name (it becomes a new version), or keep
        the file if this is not patient data.
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        {high.map((f) => (
          <li key={`${f.type}-${f.ordinal}-${f.excerpt}`}>
            {PHI_TYPE_LABELS[f.type] ?? f.type} at {f.where}: <span className="font-mono">{f.excerpt}</span>
          </li>
        ))}
      </ul>
      {low.length > 0 && (
        <p className="mt-2 text-red-800">Also found {low.length} email address(es) or phone number(s); these are often lab or supplier contacts.</p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={button} disabled={busy} onClick={() => onDecide('redacted')}>
          I have redacted it
        </button>
        <button type="button" className={button} disabled={busy} onClick={() => onDecide('accepted')}>
          Keep as is
        </button>
      </div>
    </div>
  );
}

function Profile({ version }: { version: VersionDetail }): JSX.Element | null {
  const p = version.profile;
  if (!p) return null;
  if (p.kind === 'drawing') {
    const t = p.titleBlock;
    return (
      <p className="mt-2 text-sm text-slate-700">
        Title block: part {t.partNumber ?? '—'}, drawing {t.drawingNumber ?? '—'}, revision {t.revision ?? '—'}
        {t.title ? `, “${t.title}”` : ''}
      </p>
    );
  }
  return (
    <div className="mt-2 text-sm text-slate-700">
      {p.sheets.map((s) => (
        <p key={s.sheet}>
          Raw data, sheet {s.sheet}: {s.rowCount} rows;{' '}
          {s.columns
            .filter((c) => c.type === 'number')
            .map((c) => `${c.name}${c.unit ? ` (${c.unit})` : ''} ${c.min}–${c.max}`)
            .join('; ') || 'no numeric columns'}
        </p>
      ))}
    </div>
  );
}

function VersionRow({
  v,
  current,
  onDecide,
  busy,
}: {
  v: VersionDetail;
  current: boolean;
  onDecide: (d: 'redacted' | 'accepted') => void;
  busy: boolean;
}): JSX.Element {
  const units = unitLabel(v.format, v.unitCount);
  return (
    <li className="border-t border-slate-100 py-3 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold text-slate-900">Version {v.versionNo}</span>
        {current && <span className="text-xs font-medium text-brand-700">current</span>}
        <Badge status={v.parseStatus} />
        <span className="text-slate-600">
          {v.format.toUpperCase()} · {bytes(v.sizeBytes)}
          {units ? ` · ${units}` : ''}
          {v.parseStatus === 'parsed' ? ` · ${v.locationCount} passages located` : ''}
        </span>
      </div>
      {v.parseError && <p className="mt-1 text-sm text-red-700">{v.parseError}</p>}
      <p className="mt-1 text-xs text-slate-500">
        SHA-256 <span className="font-mono">{v.sha256.slice(0, 16)}…</span> · added {new Date(v.createdAt).toLocaleString()} ·{' '}
        {v.copyKept ? 'copy kept' : v.discardedAt ? 'copy deleted after reading; text, locations and hash kept' : 'no copy kept'}
      </p>
      <p className={`mt-1 text-sm ${PHI_TONE[v.phiStatus]}`}>{PHI_LABELS[v.phiStatus]}</p>
      {v.phiStatus === 'flagged' && <PhiPrompt version={v} onDecide={onDecide} busy={busy} />}
      <Profile version={v} />
    </li>
  );
}

/** Project files with ingest status, per-file version history and the PHI redaction prompt (F7.2). */
export default function ProjectFilesPage(): JSX.Element {
  const { projectId = '' } = useParams();
  const { session, authedRequest } = useAuth();
  const api = useMemo(() => filesApi(authedRequest), [authedRequest]);
  const workspace = useMemo(() => workspaceApi(authedRequest), [authedRequest]);
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [files, setFiles] = useState<FileSummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [open, setOpen] = useState<FileDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  usePageMeta({ title: project ? `Files · ${project.name}` : 'Files', description: 'Client files in this submission and how they were read.' });

  const load = useCallback(async () => {
    const page = await api.list(projectId);
    setFiles(page.items);
    setNextCursor(page.nextCursor);
    return page.items;
  }, [api, projectId]);

  useEffect(() => {
    workspace
      .getProject(projectId)
      .then(setProject)
      .catch((err: unknown) => setError(err instanceof ApiError && err.status === 404 ? 'This submission was not found.' : 'Could not load this submission.'));
    load().catch(() => setError('Could not load the files.'));
  }, [workspace, projectId, load]);

  const busy = (files ?? []).some((f) => f.latest && (f.latest.parseStatus === 'queued' || f.latest.parseStatus === 'parsing'));
  useEffect(() => {
    if (!busy) return undefined;
    const timer = window.setInterval(() => {
      load()
        .then(async (items) => {
          if (open) {
            const still = items.find((f) => f.id === open.id);
            if (still) setOpen(await api.detail(open.id));
          }
        })
        .catch(() => undefined);
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [busy, load, api, open]);

  const onFiles = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const chosen = Array.from(e.target.files ?? []);
    if (!chosen.length) return;
    setUploading(true);
    setNotice(null);
    const added: string[] = [];
    const same: string[] = [];
    try {
      for (const file of chosen) {
        const r = await api.upload(projectId, file);
        (r.unchanged ? same : added).push(r.versionCount > 1 && !r.unchanged ? `${r.name} (version ${r.versionCount})` : r.name);
      }
      const parts = [added.length && `Added ${added.join(', ')}.`, same.length && `${same.join(', ')} unchanged: already the latest version.`].filter(Boolean);
      setNotice({ tone: 'success', text: parts.join(' ') });
    } catch (err) {
      setNotice({
        tone: 'error',
        text:
          err instanceof ApiError && err.code === 'UPLOADS_DISABLED'
            ? 'Files arrive here from the connected client folder or the client upload link.'
            : err instanceof ApiError
              ? err.message
              : 'The file could not be added.',
      });
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
      await load().catch(() => undefined);
    }
  };

  const toggle = async (file: FileSummary): Promise<void> => {
    if (open?.id === file.id) {
      setOpen(null);
      return;
    }
    try {
      setOpen(await api.detail(file.id));
    } catch {
      setNotice({ tone: 'error', text: 'Could not open this file.' });
    }
  };

  const decide = async (versionId: string, decision: 'redacted' | 'accepted'): Promise<void> => {
    setDeciding(true);
    try {
      await api.decidePhi(versionId, decision);
      setNotice({ tone: 'success', text: decision === 'redacted' ? 'Marked as redacted.' : 'Kept after review.' });
      if (open) setOpen(await api.detail(open.id));
      await load();
    } catch (err) {
      setNotice({ tone: 'error', text: err instanceof ApiError ? err.message : 'Could not save your answer.' });
    } finally {
      setDeciding(false);
    }
  };

  const more = async (): Promise<void> => {
    if (!nextCursor) return;
    const page = await api.list(projectId, nextCursor);
    setFiles((prev) => [...(prev ?? []), ...page.items]);
    setNextCursor(page.nextCursor);
  };

  const flagged = (files ?? []).filter((f) => f.latest?.phiStatus === 'flagged');

  return (
    <section className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6">
      <nav aria-label="Breadcrumb" className="text-sm text-slate-500">
        <Link to="/app" className="hover:underline">
          {session?.org.name}
        </Link>
        {project && (
          <>
            {' '}
            ›{' '}
            <Link to={`/app/projects/${project.id}`} className="hover:underline">
              {project.name}
            </Link>
          </>
        )}{' '}
        › <span aria-current="page">Files</span>
      </nav>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-slate-900">Files</h1>
        <label className={`${button} cursor-pointer ${uploading ? 'opacity-60' : ''}`}>
          {uploading ? 'Adding…' : 'Add files'}
          <input ref={input} type="file" name="files" multiple className="sr-only" disabled={uploading} onChange={(e) => void onFiles(e)} />
        </label>
      </div>
      <p className="mt-1 text-sm text-slate-600">
        Each file is read in an isolated sandbox. A file with the same name becomes a new version; earlier versions are kept.
      </p>

      {error && (
        <div className="mt-4">
          <FormMessage tone="error">{error}</FormMessage>
        </div>
      )}
      <div aria-live="polite" className="mt-4">
        {notice && <FormMessage tone={notice.tone}>{notice.text}</FormMessage>}
      </div>

      {flagged.length > 0 && (
        <div role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
          <p className="font-semibold">{flagged.length === 1 ? '1 file may contain patient data' : `${flagged.length} files may contain patient data`}</p>
          <p className="mt-1">Open {flagged.length === 1 ? 'it' : 'each one'} to see what was found and redact it before it is used in the submission.</p>
        </div>
      )}

      <div className={`${card} mt-6`}>
        {files === null && !error && (
          <p role="status" className="text-slate-500">
            Loading…
          </p>
        )}
        {files && files.length === 0 && <p className="text-slate-600">No files yet. Add the client&apos;s test reports, protocols, raw data and drawings.</p>}
        {files && files.length > 0 && (
          <ul aria-label="Files" className="divide-y divide-slate-100">
            {files.map((f) => (
              <li key={f.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-slate-900">{f.name}</p>
                    <p className="text-sm text-slate-600">
                      {f.versionCount === 1 ? '1 version' : `${f.versionCount} versions`}
                      {f.latest && ` · ${f.latest.format.toUpperCase()}`}
                      {f.latest && unitLabel(f.latest.format, f.latest.unitCount) && ` · ${unitLabel(f.latest.format, f.latest.unitCount)}`}
                      {f.latest && <span className={PHI_TONE[f.latest.phiStatus]}> · {PHI_LABELS[f.latest.phiStatus]}</span>}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    {f.latest && <Badge status={f.latest.parseStatus} />}
                    <button type="button" className={button} aria-expanded={open?.id === f.id} onClick={() => void toggle(f)}>
                      {open?.id === f.id ? 'Hide versions' : 'Versions'}
                    </button>
                  </div>
                </div>
                {open?.id === f.id && (
                  <ul aria-label={`Versions of ${f.name}`} className="mt-3 rounded-xl bg-slate-50 px-4">
                    {open.versions.map((v) => (
                      <VersionRow key={v.id} v={v} current={v.id === open.currentVersionId} busy={deciding} onDecide={(d) => void decide(v.id, d)} />
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
        {nextCursor && (
          <button type="button" className={`${button} mt-4`} onClick={() => void more()}>
            Show more files
          </button>
        )}
      </div>
    </section>
  );
}
