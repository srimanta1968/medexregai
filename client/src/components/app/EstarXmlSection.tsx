import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/api';
import { saveBlob } from '../../lib/trustApi';

/** F5.4 eSTAR XML data file (ADR-019): server route in server/src/routes/estarXml.ts. */
interface EstarXmlReport {
  fileName: string;
  templateKey: string;
  templateDataVersion: string;
  mappingVersion: string;
  importChecked: boolean;
  filled: { path: string; field: string; value: string; source: string }[];
  fillByHand: { section: string; what: string; why: string }[];
  warnings: string[];
}

const card = 'rounded-2xl border border-slate-200 bg-white p-5 shadow-sm';
const primary = 'rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60';

/**
 * The eSTAR XML export on the readiness screen. Hidden entirely while the export is turned off
 * (ESTAR_XML_EXPORT, until the Acrobat Pro import check passes). Shows what will be filled and
 * from where, what the consultant fills by hand, and downloads the file for Import Data in Acrobat Pro.
 */
export function EstarXmlSection({ projectId, templateKey }: { projectId: string; templateKey: string }): JSX.Element | null {
  const { authedRequest } = useAuth();
  const base = useMemo(() => `/api/projects/${encodeURIComponent(projectId)}/estar-xml`, [projectId]);
  const [report, setReport] = useState<EstarXmlReport | null>(null);
  const [hidden, setHidden] = useState(false);
  const [unsupported, setUnsupported] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setReport(null);
    setUnsupported(null);
    setError(null);
    authedRequest<EstarXmlReport>(`${base}?format=json`)
      .then(setReport)
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.code === 'ESTAR_XML_DISABLED') setHidden(true);
        else if (err instanceof ApiError && err.code === 'TEMPLATE_NOT_SUPPORTED') setUnsupported(err.message);
        else setError(err instanceof ApiError ? err.message : 'Could not prepare the eSTAR XML.');
      });
  }, [authedRequest, base, templateKey]);

  const download = async () => {
    if (!report) return;
    setBusy(true);
    setError(null);
    try {
      saveBlob(await authedRequest<Blob>(`${base}?format=xml`, { responseType: 'blob' }), report.fileName);
      setNotice('eSTAR XML downloaded. Open a blank eSTAR of the same version in Adobe Acrobat Pro and click Import Data.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not download the eSTAR XML.');
    } finally {
      setBusy(false);
    }
  };

  if (hidden) return null;
  return (
    <section className={card} aria-labelledby="estar-xml-title">
      <h2 id="estar-xml-title" className="text-lg font-semibold text-slate-900">
        eSTAR data file (XML)
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        Fills the parts of the eSTAR that MedexRegAI already knows. Open a blank eSTAR of the same version in Adobe Acrobat Pro and use its Import Data
        button; other PDF readers cannot import. Attachments are never in the file (FDA), and you still complete, sign and file the eSTAR yourself.
      </p>
      <div aria-live="polite" className="mt-2 space-y-1 text-sm">
        {notice && <p className="text-emerald-800">{notice}</p>}
        {error && <p className="text-rose-800">{error}</p>}
        {unsupported && <p className="text-amber-800">{unsupported}</p>}
      </div>
      {report && (
        <>
          {!report.importChecked && (
            <p className="mt-3 rounded-md bg-amber-50 p-3 text-sm text-amber-900">
              Not yet proven in Acrobat Pro: check each imported field against your records before you rely on it.
            </p>
          )}
          <p className="mt-3 text-sm text-slate-700">
            Template {report.templateKey} (form data version {report.templateDataVersion}) · mapping {report.mappingVersion} · {report.filled.length} fields filled
          </p>
          {report.warnings.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-800">
              {report.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer font-medium text-slate-900">What will be filled</summary>
            <table className="mt-2 w-full text-left">
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="pb-1 pr-3 font-medium">eSTAR field</th>
                  <th className="pb-1 pr-3 font-medium">Value</th>
                  <th className="pb-1 font-medium">From</th>
                </tr>
              </thead>
              <tbody>
                {report.filled.map((f, i) => (
                  <tr key={`${f.path}-${i}`} className="border-t border-slate-100 align-top">
                    <td className="py-1 pr-3 text-slate-900">{f.field}</td>
                    <td className="py-1 pr-3 text-slate-700">{f.value}</td>
                    <td className="py-1 text-slate-600">{f.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
          <h3 className="mt-4 text-sm font-semibold text-slate-900">You fill these in the eSTAR</h3>
          <ul className="mt-1 space-y-1 text-sm text-slate-700">
            {report.fillByHand.map((f) => (
              <li key={`${f.section}-${f.what}`}>
                <span className="font-medium">{f.section}:</span> {f.what}. <span className="text-slate-500">{f.why}</span>
              </li>
            ))}
          </ul>
          <button type="button" className={`${primary} mt-4`} disabled={busy} onClick={() => void download()}>
            Download eSTAR XML
          </button>
        </>
      )}
    </section>
  );
}
