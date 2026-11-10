import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';

interface ActivityItem {
  seq: number;
  action: string;
  targetType: string;
  actor: { id: string | null; name: string | null };
  metadata: Record<string, unknown>;
  createdAt: string;
}

/** Plain-language text for each recorded action (unknown actions fall back to the code). */
const ACTION_TEXT: Record<string, (m: Record<string, unknown>) => string> = {
  'project.created': () => 'created this submission',
  'project.viewed': () => 'opened this submission',
  'project.updated': (m) => `updated ${Array.isArray(m.fields) && m.fields.length ? (m.fields as string[]).join(', ') : 'the submission'}`,
  'draft.accepted': () => 'accepted a draft statement',
  'draft.rejected': () => 'rejected a draft statement',
  'export.created': (m) => `exported ${typeof m.format === 'string' ? m.format.toUpperCase() : 'a file'}`,
};

const describe = (item: ActivityItem): string => (ACTION_TEXT[item.action] ?? (() => item.action))(item.metadata);

const when = (iso: string): string => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Recent activity for a submission, from the firm's tamper-evident audit log. */
export default function ActivityPanel({ projectId }: { projectId: string }): JSX.Element {
  const { authedRequest } = useAuth();
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (after?: string) => {
      setLoading(true);
      try {
        const qs = new URLSearchParams({ limit: '20', ...(after ? { cursor: after } : {}) });
        const page = await authedRequest<{ items: ActivityItem[]; nextCursor: string | null }>(
          `/api/projects/${encodeURIComponent(projectId)}/activity?${qs.toString()}`
        );
        setItems((prev) => (after ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
        setError(null);
      } catch {
        setError('Could not load recent activity.');
      } finally {
        setLoading(false);
      }
    },
    [authedRequest, projectId]
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section aria-labelledby="activity-title" className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="activity-title" className="text-lg font-semibold text-slate-900">
          Recent activity
        </h2>
        <button type="button" onClick={() => void load()} className="text-sm font-semibold text-brand-700 hover:underline">
          Refresh
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-500">Every view, decision and export is recorded in a tamper-evident log.</p>
      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
      {!error && items.length === 0 && !loading && <p className="mt-3 text-sm text-slate-600">No activity yet.</p>}
      <ol className="mt-3 divide-y divide-slate-100" aria-label="Recent activity">
        {items.map((item) => (
          <li key={item.seq} className="flex flex-wrap justify-between gap-2 py-2 text-sm">
            <span className="text-slate-800">
              <strong className="font-semibold">{item.actor.name ?? 'A former member'}</strong> {describe(item)}
            </span>
            <time dateTime={item.createdAt} className="text-slate-500">
              {when(item.createdAt)}
            </time>
          </li>
        ))}
      </ol>
      {cursor && (
        <button type="button" onClick={() => void load(cursor)} disabled={loading} className="mt-3 text-sm font-semibold text-brand-700 hover:underline">
          {loading ? 'Loading…' : 'Show older'}
        </button>
      )}
    </section>
  );
}
