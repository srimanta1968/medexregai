import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { EstarXmlSection } from '../../components/app/EstarXmlSection';
import { FormMessage } from '../../components/auth/AuthUi';
import { usePageMeta } from '../../hooks/usePageMeta';
import { ApiError } from '../../lib/api';
import { EstarTemplate, formatBytes, Readiness, readinessApi, RECORD_LABEL, RecordExport, RecordFormat, RecordKind } from '../../lib/readinessApi';
import { saveBlob } from '../../lib/trustApi';

const card = 'rounded-2xl border border-slate-200 bg-white p-5 shadow-sm';
const secondary = 'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:border-brand-400 disabled:opacity-60';
const message = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);
const KINDS: RecordKind[] = ['project_record', 'problem_log', 'request_log'];

/**
 * F3.4 Readiness and records (UI 2.0 §5.4): eSTAR attachment checks against the project's
 * template (rules quoted from FDA's eSTAR page), the running total against the 4 GB limit,
 * and dated records (project record, problem log, client request log) for the firm's eQMS.
 */
export default function ProjectReadinessPage(): JSX.Element {
  const { projectId = '' } = useParams();
  const { authedRequest } = useAuth();
  const api = useMemo(() => readinessApi(authedRequest, projectId), [authedRequest, projectId]);
  usePageMeta({ title: 'Readiness and records', description: 'eSTAR attachment checks and dated records for the eQMS.' });
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [templates, setTemplates] = useState<EstarTemplate[]>([]);
  const [history, setHistory] = useState<RecordExport[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([api.check(), api.templates(), api.history()])
      .then(([r, t, h]) => {
        setReadiness(r);
        setTemplates(t);
        setHistory(h);
      })
      .catch((err: unknown) => setError(message(err, 'Could not load the readiness checks.')));
  }, [api]);
  useEffect(load, [load]);

  const changeTemplate = async (key: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.setTemplate(key);
      setReadiness(r);
      setNotice(`Checked against ${r.template.label}.`);
    } catch (err) {
      setError(message(err, 'Could not change the template.'));
    } finally {
      setBusy(false);
    }
  };
  const download = async (kind: RecordKind, format: RecordFormat) => {
    setBusy(true);
    setError(null);
    try {
      const name = `${RECORD_LABEL[kind]} ${new Date().toISOString().slice(0, 10)}.${format}`;
      saveBlob(await api.record(kind, format), name);
      setHistory(await api.history());
      setNotice(`${RECORD_LABEL[kind]} (${format.toUpperCase()}) generated and logged.`);
    } catch (err) {
      setError(message(err, 'Could not generate the record.'));
    } finally {
      setBusy(false);
    }
  };

  const pct = readiness ? Math.min(100, readiness.totalPercent) : 0;
  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
      <nav aria-label="Breadcrumb" className="text-sm text-slate-500">
        <Link to={`/app/projects/${projectId}`} className="hover:underline">
          Project
        </Link>{' '}
        › <span aria-current="page">Readiness</span>
      </nav>
      <h1 className="mt-1 text-2xl font-bold text-slate-900">Readiness and records</h1>
      <div aria-live="polite" className="mt-3 space-y-2">
        {notice && <FormMessage tone="success">{notice}</FormMessage>}
        {error && <FormMessage tone="error">{error}</FormMessage>}
      </div>
      {!readiness ? (
        <p role="status" className="mt-6 text-slate-500">
          Loading…
        </p>
      ) : (
        <div className="mt-6 space-y-6">
          <section className={card} aria-labelledby="checks-title">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="checks-title" className="text-lg font-semibold text-slate-900">
                eSTAR attachment checks
              </h2>
              <label className="text-sm">
                <span className="mr-2 text-slate-600">eSTAR template</span>
                <select
                  name="estarTemplate"
                  className="rounded-md border border-slate-300 px-2 py-1.5"
                  value={readiness.template.key}
                  disabled={busy}
                  onChange={(e) => void changeTemplate(e.target.value)}
                >
                  {templates.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="mt-2 text-sm text-slate-700">
              {readiness.counts.attachments} attachment{readiness.counts.attachments === 1 ? '' : 's'} ·{' '}
              <strong className={readiness.counts.errors ? 'text-rose-800' : 'text-emerald-800'}>
                {readiness.counts.errors} error{readiness.counts.errors === 1 ? '' : 's'}
              </strong>{' '}
              · {readiness.counts.warnings} warning{readiness.counts.warnings === 1 ? '' : 's'} · {readiness.ready ? 'Ready to attach' : 'Not ready'}
            </p>
            <div className="mt-3">
              <p className="text-sm text-slate-700">
                Total {formatBytes(readiness.totalBytes)} of {formatBytes(readiness.totalLimitBytes)} ({readiness.totalPercent}%)
              </p>
              <div
                className="mt-1 h-2 w-full rounded-full bg-slate-100"
                role="progressbar"
                aria-label="Total size against the eSTAR limit"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
              >
                <div className={`h-2 rounded-full ${readiness.totalPercent > 100 ? 'bg-rose-600' : 'bg-brand-600'}`} style={{ width: `${pct}%` }} />
              </div>
            </div>
            {readiness.attachments.length === 0 ? (
              <p className="mt-3 text-sm text-slate-600">No files are filed under an eSTAR section yet, so there is nothing to check.</p>
            ) : (
              <table className="mt-4 w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="pb-1 pr-3 font-medium">Attachment</th>
                    <th className="pb-1 pr-3 font-medium">Section</th>
                    <th className="pb-1 pr-3 font-medium">Name</th>
                    <th className="pb-1 pr-3 font-medium">Size</th>
                    <th className="pb-1 font-medium">Checks</th>
                  </tr>
                </thead>
                <tbody>
                  {readiness.attachments.map((a) => (
                    <tr key={a.fileId} className="border-t border-slate-100 align-top">
                      <td className="max-w-xs break-words py-2 pr-3 text-slate-900">{a.name}</td>
                      <td className="py-2 pr-3 text-slate-600">{a.sectionTitle}</td>
                      <td className="py-2 pr-3 text-slate-600">{a.nameLength} chars</td>
                      <td className="py-2 pr-3 text-slate-600">{formatBytes(a.sizeBytes)}</td>
                      <td className="py-2">
                        {a.issues.length === 0 ? (
                          <span className="text-emerald-800">OK</span>
                        ) : (
                          <ul className="space-y-1">
                            {a.issues.map((i) => (
                              <li key={i.code} className={i.severity === 'error' ? 'text-rose-800' : 'text-amber-800'}>
                                <span className="font-medium">{i.severity === 'error' ? 'Error' : 'Warning'}:</span> {i.message}{' '}
                                <span className="text-xs text-slate-500">({i.basis === 'fda' ? 'FDA rule' : 'our reading'})</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="mt-3 text-xs text-slate-500">
              Rules from{' '}
              <a href={readiness.rules.source.url} target="_blank" rel="noreferrer" className="underline">
                FDA’s eSTAR page
              </a>{' '}
              (content current as of {readiness.rules.source.contentAsOf}): names over {readiness.rules.maxNameChars} characters are not accepted; {formatBytes(readiness.rules.maxAttachmentBytes)} per attachment and{' '}
              {formatBytes(readiness.rules.maxTotalBytes)} in total via the CDRH Portal; zip files are rejected. We read GB as 10⁹ bytes, the stricter reading.
            </p>
          </section>

          <EstarXmlSection projectId={projectId} templateKey={readiness.template.key} />

          <section className={card} aria-labelledby="records-title">
            <h2 id="records-title" className="text-lg font-semibold text-slate-900">
              Records for your eQMS
            </h2>
            <p className="mt-1 text-sm text-slate-600">Dated records made from the project data now. Each is logged with its SHA-256 so the copy you file can be matched later.</p>
            <ul className="mt-3 space-y-2">
              {KINDS.map((k) => (
                <li key={k} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 p-3">
                  <span className="font-medium text-slate-900">{RECORD_LABEL[k]}</span>
                  <span className="flex gap-2">
                    <button type="button" className={secondary} disabled={busy} aria-label={`${RECORD_LABEL[k]} as PDF`} onClick={() => void download(k, 'pdf')}>
                      PDF
                    </button>
                    <button type="button" className={secondary} disabled={busy} aria-label={`${RECORD_LABEL[k]} as Word`} onClick={() => void download(k, 'docx')}>
                      DOCX
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            <h3 className="mt-4 text-sm font-semibold text-slate-900">Generated so far · {history.length}</h3>
            {history.length === 0 ? (
              <p className="text-sm text-slate-600">No records yet.</p>
            ) : (
              <ul className="mt-1 space-y-1 text-sm text-slate-700">
                {history.slice(0, 20).map((r) => (
                  <li key={r.id}>
                    {RECORD_LABEL[r.kind]} ({r.format.toUpperCase()}) · {new Date(r.createdAt).toLocaleString()} · {r.createdBy ?? 'someone'} ·{' '}
                    <span className="font-mono text-xs" title={r.sha256}>
                      SHA-256 {r.sha256.slice(0, 16)}…
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
