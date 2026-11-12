import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import { ApiError } from "../../lib/api";
import {
  Coverage,
  EstarSection,
  SortedFile,
  sortingApi,
} from "../../lib/sortingApi";
import { FormMessage } from "../auth/AuthUi";

const card = "rounded-2xl border border-slate-200 bg-white p-6 shadow-sm";
const SOURCE_LABEL: Record<string, string> = {
  rules: "by rule",
  embedding: "like your filed files",
  llm: "by AI",
  consultant: "by you",
};
const message = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.message : fallback;

/**
 * F2.2 (UI 2.0 §4.2): the getting-started checklist, the eSTAR coverage panel and the
 * sorted folder. Files are grouped by eSTAR section; each shows the sorter's confidence
 * and can be moved to another section (the sorter learns from it, for this firm only).
 */
export function SortedFolder({
  projectId,
  refreshKey,
}: {
  projectId: string;
  refreshKey: string;
}): JSX.Element {
  const { authedRequest } = useAuth();
  const api = useMemo(
    () => sortingApi(authedRequest, projectId),
    [authedRequest, projectId],
  );
  const [sections, setSections] = useState<EstarSection[]>([]);
  const [files, setFiles] = useState<SortedFile[] | null>(null);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .files()
      .then((p) => setFiles(p.items))
      .catch((err: unknown) =>
        setError(message(err, "Could not load the sorted folder.")),
      );
    api
      .coverage()
      .then(setCoverage)
      .catch(() => undefined);
  }, [api]);
  useEffect(() => {
    api
      .sections()
      .then(setSections)
      .catch(() => undefined);
  }, [api]);
  useEffect(load, [load, refreshKey]);
  // Files are sorted shortly after they are read: refresh while any is still waiting.
  useEffect(() => {
    if (!files?.some((f) => !f.assignment && !f.unreadable)) return;
    const t = setTimeout(load, 3000);
    return () => clearTimeout(t);
  }, [files, load]);

  const evidence = useMemo(
    () => sections.filter((s) => s.takesEvidence),
    [sections],
  );
  const grouped = useMemo(() => {
    const by = new Map<string, SortedFile[]>();
    for (const f of files ?? []) {
      const key = f.assignment?.sectionId ?? "";
      by.set(key, [...(by.get(key) ?? []), f]);
    }
    const order = (id: string) =>
      id === "" ? -1 : (sections.find((s) => s.id === id)?.ordinal ?? 999);
    return [...by.entries()].sort((a, b) => order(a[0]) - order(b[0]));
  }, [files, sections]);

  const move = async (f: SortedFile, sectionId: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await api.assign(f.id, sectionId === "" ? null : sectionId);
      setNotice(
        r.assignment.sectionTitle
          ? `Filed ${f.name} under ${r.assignment.sectionTitle}. Similar files will be sorted the same way.`
          : `${f.name} marked as not evidence for any section.`,
      );
      load();
    } catch (err) {
      setError(message(err, "Could not move the file."));
    } finally {
      setBusy(false);
    }
  };

  const noFiles = files !== null && files.length === 0;
  const empty = coverage?.sections.filter((s) => s.empty) ?? [];
  return (
    <div
      className={`mt-6 grid gap-6 ${noFiles ? "lg:grid-cols-2" : "lg:grid-cols-[2fr_1fr]"}`}
    >
      {!noFiles && (
        <section className={card} aria-labelledby="sorted-title">
          <h2
            id="sorted-title"
            className="text-lg font-semibold text-slate-900"
          >
            Sorted into eSTAR sections
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Wrong section? Pick the right one. Corrections teach the sorter for
            this firm only.
          </p>
          <div aria-live="polite" className="mt-3 space-y-2">
            {notice && <FormMessage tone="success">{notice}</FormMessage>}
            {error && <FormMessage tone="error">{error}</FormMessage>}
          </div>
          {files === null ? (
            <p role="status" className="mt-3 text-slate-500">
              Loading…
            </p>
          ) : (
            grouped.map(([sectionId, list]) => (
              <div key={sectionId || "unsorted"} className="mt-4">
                <h3 className="text-sm font-semibold text-slate-900">
                  {sectionId
                    ? (sections.find((s) => s.id === sectionId)?.title ??
                      sectionId)
                    : "Not sorted yet"}{" "}
                  · {list.length} file{list.length === 1 ? "" : "s"}
                </h3>
                <ul className="mt-1 divide-y divide-slate-100">
                  {list.map((f) => (
                    <li
                      key={f.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-slate-900">
                          {f.name}
                        </span>
                        <span className="text-slate-600">
                          {f.assignment
                            ? `${Math.round(f.assignment.confidence * 100)}% · ${SOURCE_LABEL[f.assignment.source] ?? f.assignment.source}`
                            : f.unreadable
                              ? "Could not be read"
                              : "Waiting to be read"}
                          {f.assignment?.needsReview && (
                            <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-amber-900">
                              Please confirm
                            </span>
                          )}
                        </span>
                      </span>
                      <label className="text-sm">
                        <span className="sr-only">Section for {f.name}</span>
                        <select
                          name={`section-${f.name}`}
                          aria-label={`Section for ${f.name}`}
                          className="rounded-md border border-slate-300 px-2 py-1"
                          value={f.assignment?.sectionId ?? ""}
                          disabled={busy}
                          onChange={(e) => void move(f, e.target.value)}
                        >
                          <option value="">No section</option>
                          {evidence.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.title}
                            </option>
                          ))}
                        </select>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </section>
      )}

      <div className={noFiles ? "contents" : "space-y-6"}>
        {coverage && (
          <section className={card} aria-labelledby="checklist-title">
            <h2
              id="checklist-title"
              className="text-lg font-semibold text-slate-900"
            >
              Getting started
            </h2>
            <ol className="mt-2 space-y-2 text-sm">
              {coverage.checklist.map((s) => (
                <li key={s.key} className="flex gap-2">
                  <span
                    aria-hidden="true"
                    className={s.done ? "text-emerald-700" : "text-slate-400"}
                  >
                    {s.done ? "✓" : "○"}
                  </span>
                  <span>
                    <span className="font-medium text-slate-900">
                      {s.label}
                    </span>
                    <span className="sr-only">
                      {s.done ? " (done)" : " (to do)"}
                    </span>
                    <span className="block text-slate-600">{s.detail}</span>
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}
        {coverage && (
          <section className={card} aria-labelledby="coverage-title">
            <h2
              id="coverage-title"
              className="text-lg font-semibold text-slate-900"
            >
              eSTAR coverage
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              {empty.length} of {coverage.sections.length} sections have no
              evidence yet. Some may not apply to this device.
            </p>
            <ul className="mt-2 space-y-1 text-sm" aria-label="eSTAR coverage">
              {coverage.sections.map((s) => (
                <li key={s.id} className="flex justify-between gap-2">
                  <span
                    className={s.empty ? "text-amber-800" : "text-slate-900"}
                  >
                    {s.title}
                  </span>
                  <span
                    className={s.empty ? "text-amber-800" : "text-slate-600"}
                  >
                    {s.empty
                      ? "No evidence yet"
                      : `${s.fileCount} file${s.fileCount === 1 ? "" : "s"}`}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-slate-500">
              Sections from FDA&apos;s eSTAR 510(k) guidance (October 2, 2023),
              Table 1.
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
