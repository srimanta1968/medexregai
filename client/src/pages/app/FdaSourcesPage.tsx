import { useEffect, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import FdaDataAsOf, { FdaMeta, fdaDateLabel, loadFdaMeta } from '../../components/app/FdaDataAsOf';
import { FormMessage } from '../../components/auth/AuthUi';
import { usePageMeta } from '../../hooks/usePageMeta';

const LABELS: Record<string, { name: string; what: string }> = {
  classification: { name: 'Device classification', what: 'Product codes, device class and regulation numbers' },
  '510k': { name: '510(k) clearances', what: 'K-numbers, applicants, decisions and dates' },
  recall: { name: 'Recalls', what: 'Device recalls and the K-numbers they affect' },
  udi: { name: 'UDI (GUDID)', what: 'Device identifiers, brands and models' },
  event_counts: { name: 'Adverse events (MAUDE)', what: 'Report counts per product code and day' },
};

const STATUS: Record<string, string> = { succeeded: 'Up to date', running: 'Syncing now', failed: 'Last sync failed' };

/** Where our FDA data comes from and how current each part is (UI 2.0 §9 Sources). */
export default function FdaSourcesPage(): JSX.Element {
  usePageMeta({ title: 'FDA data sources', description: 'Where MedexRegAI’s FDA data comes from and when it was last updated.' });
  const { authedRequest } = useAuth();
  const [meta, setMeta] = useState<FdaMeta | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadFdaMeta(authedRequest, true)
      .then(setMeta)
      .catch(() => setError('Could not load the FDA data status.'));
  }, [authedRequest]);

  return (
    <section className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-slate-900">FDA data sources</h1>
        <FdaDataAsOf />
      </div>
      <p className="mt-2 max-w-3xl text-sm text-slate-600">
        MedexRegAI keeps its own copy of public openFDA device data and refreshes it daily, so your work never waits on the FDA website. Every check shows
        the date of the data it used. The overall date is the oldest of the sources below.
      </p>
      {error && (
        <div className="mt-4">
          <FormMessage tone="error">{error}</FormMessage>
        </div>
      )}
      {meta && (
        <div className="mt-6 overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">FDA datasets and how current they are</caption>
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-3">
                  Source
                </th>
                <th scope="col" className="px-4 py-3">
                  Data as of
                </th>
                <th scope="col" className="px-4 py-3">
                  Records
                </th>
                <th scope="col" className="px-4 py-3">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {meta.datasets.map((d) => (
                <tr key={d.dataset}>
                  <th scope="row" className="px-4 py-3 font-medium text-slate-900">
                    {LABELS[d.dataset]?.name ?? d.dataset}
                    <span className="block text-xs font-normal text-slate-500">{LABELS[d.dataset]?.what}</span>
                  </th>
                  <td className="px-4 py-3 text-slate-700">{d.sourceLastUpdated ? fdaDateLabel(d.sourceLastUpdated) : 'Not loaded yet'}</td>
                  <td className="px-4 py-3 text-slate-700">{d.records.toLocaleString()}</td>
                  <td className="px-4 py-3 text-slate-700">
                    {d.lastRunStatus ? STATUS[d.lastRunStatus] : 'Not synced yet'}
                    {d.lastSyncedAt && <span className="block text-xs text-slate-500">checked {new Date(d.lastSyncedAt).toLocaleString()}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-4 text-xs text-slate-500">Source: openFDA (open.fda.gov), U.S. Food and Drug Administration. MedexRegAI is not affiliated with the FDA.</p>
    </section>
  );
}
