interface PreviewRow {
  file: string;
  section: string;
  version: string;
  status: string;
  tone: 'ok' | 'warn' | 'ask';
}

/** Rows from the UI 2.0 concept screen (fictional client, illustrative only). */
const ROWS: PreviewRow[] = [
  { file: 'EO-09 EO validation report.pdf', section: 'Sterility', version: 'rev A · current', status: 'Read · 38 pp', tone: 'ok' },
  { file: 'SL-22 accelerated ageing report.pdf', section: 'Shelf life', version: 'rev B · current', status: '1 conflict', tone: 'warn' },
  { file: 'BC-114 biocompatibility report.pdf', section: 'Biocompatibility', version: 'rev C or C1?', status: 'Confirm version', tone: 'ask' },
  { file: 'IS-200-SPEC product specification.xlsx', section: 'Device description', version: 'rev F · current', status: 'Read · 4 sheets', tone: 'ok' },
];

const TONE_CLASS: Record<PreviewRow['tone'], string> = {
  ok: 'bg-emerald-50 text-emerald-800',
  warn: 'bg-amber-50 text-amber-800',
  ask: 'bg-sky-50 text-sky-800',
};

/** A static picture of the sorted-folder screen. Decorative content is labelled for screen readers. */
export default function ProductPreview(): JSX.Element {
  return (
    <figure className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
      <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2.5" aria-hidden="true">
        <span className="h-3 w-3 rounded-full bg-slate-300" />
        <span className="h-3 w-3 rounded-full bg-slate-300" />
        <span className="h-3 w-3 rounded-full bg-slate-300" />
        <span className="ml-3 truncate text-xs text-slate-500">northbay-devices / is-200 / files</span>
      </div>
      <div className="px-4 py-4">
        <p className="text-sm font-semibold text-slate-900">212 files read · sorted into 11 eSTAR sections</p>
        <table className="mt-3 w-full table-fixed text-left text-xs">
          <caption className="sr-only">Example of files sorted by eSTAR section</caption>
          <thead className="text-slate-500">
            <tr>
              <th scope="col" className="w-4/12 pb-2 font-medium">File</th>
              <th scope="col" className="w-3/12 pb-2 font-medium">eSTAR section</th>
              <th scope="col" className="hidden w-2/12 pb-2 font-medium sm:table-cell">Version</th>
              <th scope="col" className="w-3/12 pb-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {ROWS.map((row) => (
              <tr key={row.file}>
                <td className="truncate py-2 pr-2 text-slate-800">{row.file}</td>
                <td className="truncate py-2 pr-2 text-slate-600">{row.section}</td>
                <td className="hidden truncate py-2 pr-2 text-slate-600 sm:table-cell">{row.version}</td>
                <td className="py-2">
                  <span className={`block max-w-full truncate rounded px-1.5 py-0.5 ${TONE_CLASS[row.tone]}`} title={row.status}>
                    {row.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <figcaption className="border-t border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-500">
        Illustrative concept screen. Client, files and values are fictional.
      </figcaption>
    </figure>
  );
}
