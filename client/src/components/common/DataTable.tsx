import { ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

/**
 * F8.1 shared table for cursor-paged lists (NFR scale rules: virtualised lists, cursor paging).
 *
 * - Pages: `load(cursor)` returns `{ items, nextCursor }` (every list API in this app). The next page
 *   loads by itself when the end of the table scrolls into view; a visible button does the same for
 *   keyboard and screen-reader users (WCAG 2.1 AA: no scroll-only interaction).
 * - Virtual rows: past `virtualizeAbove` rows, only the rows near the browser window are rendered,
 *   with spacer rows keeping the scroll height. Rows are measured once drawn, so rows of different
 *   heights work. The table scrolls with the page (no nested scroll box).
 * - Accessibility: a real <table> with caption and column headers; aria-rowcount / aria-rowindex
 *   tell assistive technology the full size while rows are virtual; loading and errors are announced.
 * - Reloads from the first page whenever `resetKey` changes (filters, search).
 */
export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

interface Props<T, P extends CursorPage<T>> {
  columns: Column<T>[];
  rowKey: (row: T) => string;
  load: (cursor?: string) => Promise<P>;
  caption: string;
  /** Reload from the first page when this changes. */
  resetKey?: string;
  /** Called with the first page's whole response (e.g. totals sent beside the items). */
  onFirstPage?: (page: P) => void;
  empty?: ReactNode;
  moreLabel?: string;
  errorText?: string;
  minWidth?: string;
  estimatedRowHeight?: number;
  virtualizeAbove?: number;
}

const OVERSCAN_PX = 800;
const cellPad = 'py-3 pr-3';

export default function DataTable<T, P extends CursorPage<T> = CursorPage<T>>({
  columns,
  rowKey,
  load,
  caption,
  resetKey = '',
  onFirstPage,
  empty = 'Nothing here yet.',
  moreLabel = 'Load more',
  errorText = 'Could not load this list.',
  minWidth = '640px',
  estimatedRowHeight = 56,
  virtualizeAbove = 100,
}: Props<T, P>): JSX.Element {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Latest callbacks without making them effect dependencies (callers often pass inline functions).
  const loadRef = useRef(load);
  loadRef.current = load;
  const firstRef = useRef(onFirstPage);
  firstRef.current = onFirstPage;
  const requestId = useRef(0);
  const busy = useRef(false);

  const fetchPage = useCallback(
    async (after?: string) => {
      if (busy.current && after) return;
      const id = ++requestId.current;
      busy.current = true;
      setLoading(true);
      setError(null);
      try {
        const page = await loadRef.current(after);
        if (id !== requestId.current) return; // a newer reset superseded this request
        setItems((prev) => (after ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
        if (!after) firstRef.current?.(page);
      } catch (err) {
        if (id === requestId.current) setError(err instanceof Error && err.message ? err.message : errorText);
      } finally {
        if (id === requestId.current) {
          busy.current = false;
          setLoading(false);
          setStarted(true);
        }
      }
    },
    [errorText],
  );

  useEffect(() => {
    setItems([]);
    setCursor(null);
    setStarted(false);
    void fetchPage();
  }, [resetKey, fetchPage]);

  const loadMore = useCallback(() => {
    if (cursor && !busy.current) void fetchPage(cursor);
  }, [cursor, fetchPage]);

  // Infinite scroll: load the next page as the end of the table nears the window.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !cursor || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && loadMore(), { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, loadMore]);

  // ---- Virtual rows ---------------------------------------------------------------------------
  const virtual = items.length > virtualizeAbove;
  const tableRef = useRef<HTMLTableSectionElement>(null);
  const heights = useRef(new Map<string, number>());
  const [measureTick, setMeasureTick] = useState(0);
  const [view, setView] = useState({ top: 0, bottom: typeof window === 'undefined' ? 1000 : window.innerHeight });

  const keys = useMemo(() => items.map(rowKey), [items, rowKey]);
  const offsets = useMemo(() => {
    const out = new Array<number>(keys.length + 1);
    out[0] = 0;
    for (let i = 0; i < keys.length; i += 1) out[i + 1] = out[i] + (heights.current.get(keys[i]) ?? estimatedRowHeight);
    return out;
    // measureTick: re-run after rows are measured
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, estimatedRowHeight, measureTick]);

  useEffect(() => {
    if (!virtual) return undefined;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const body = tableRef.current;
        if (!body) return;
        const rect = body.getBoundingClientRect();
        setView({ top: -rect.top - OVERSCAN_PX, bottom: -rect.top + window.innerHeight + OVERSCAN_PX });
      });
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [virtual]);

  let start = 0;
  let end = items.length;
  if (virtual) {
    // Binary search the first row whose bottom is below the top of the window.
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid + 1] <= view.top) lo = mid + 1;
      else hi = mid;
    }
    start = lo;
    end = start;
    while (end < items.length && offsets[end] < view.bottom) end += 1;
  }

  // Measure drawn rows; re-measure when they resize (wrapping text, fonts loading).
  const observer = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    if (!virtual || typeof ResizeObserver === 'undefined') return undefined;
    let frame = 0;
    observer.current = new ResizeObserver((entries) => {
      let changed = false;
      for (const e of entries) {
        const key = (e.target as HTMLElement).dataset.rowKey;
        const h = Math.round((e.target as HTMLElement).getBoundingClientRect().height);
        if (key && h > 0 && heights.current.get(key) !== h) {
          heights.current.set(key, h);
          changed = true;
        }
      }
      if (changed) {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => setMeasureTick((t) => t + 1));
      }
    });
    return () => {
      cancelAnimationFrame(frame);
      observer.current?.disconnect();
      observer.current = null;
    };
  }, [virtual]);
  useLayoutEffect(() => {
    const ro = observer.current;
    const body = tableRef.current;
    if (!ro || !body) return;
    body.querySelectorAll<HTMLElement>('tr[data-row-key]').forEach((tr) => ro.observe(tr));
  });

  const hasMore = Boolean(cursor);
  const topSpace = virtual ? offsets[start] : 0;
  const bottomSpace = virtual ? offsets[items.length] - offsets[end] : 0;

  return (
    <div>
      <div aria-live="polite" className="text-sm">
        {error && (
          <p role="alert" className="mt-2 text-red-700">
            {error}
          </p>
        )}
      </div>
      {started && items.length === 0 && !loading && !error && <div className="mt-4 text-sm text-slate-600">{empty}</div>}
      {items.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm" style={{ minWidth }} aria-rowcount={hasMore ? -1 : items.length + 1}>
            <caption className="sr-only">{caption}</caption>
            <thead className="text-xs uppercase text-slate-500">
              <tr aria-rowindex={1}>
                {columns.map((c) => (
                  <th key={c.key} scope="col" className="py-2 pr-3">
                    {c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody ref={tableRef} className="divide-y divide-slate-100 align-top">
              {topSpace > 0 && (
                <tr aria-hidden="true" style={{ height: topSpace }}>
                  <td colSpan={columns.length} />
                </tr>
              )}
              {items.slice(start, end).map((row, i) => (
                <tr key={keys[start + i]} data-row-key={keys[start + i]} aria-rowindex={start + i + 2}>
                  {columns.map((c) => (
                    <td key={c.key} className={c.className ?? `${cellPad} text-slate-800`}>
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>
              ))}
              {bottomSpace > 0 && (
                <tr aria-hidden="true" style={{ height: bottomSpace }}>
                  <td colSpan={columns.length} />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <div ref={sentinel} aria-hidden="true" />
      {hasMore && (
        <button
          type="button"
          disabled={loading}
          className="mt-4 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:border-brand-400 disabled:opacity-60"
          onClick={loadMore}
        >
          {moreLabel}
        </button>
      )}
      {loading && (
        <p role="status" className="mt-4 text-sm text-slate-500">
          Loading…
        </p>
      )}
      {virtual && <p className="sr-only">{`${items.length} rows loaded${hasMore ? ', more available' : ''}.`}</p>}
    </div>
  );
}
