import { ApiRequest } from './api';

/** F5.2 predicates and SE comparisons: server routes in server/src/routes/predicates.ts. */

export type SearchMode = 'product_code' | 'keyword' | 'semantic';
export type Level = 'high' | 'medium' | 'low' | 'unknown';
export type FlagStatus = 'clean' | 'recall_linked' | 'unknown';
export type Comparison = 'same' | 'different' | 'review';

export interface Candidate {
  kNumber: string;
  deviceName: string | null;
  applicant: string | null;
  productCode: string | null;
  decisionDate: string | null;
  clearanceType: string | null;
  matched: { ref: string; text: string } | null;
  similarity: { ifu: Level; ifuScore: number | null; tech: Level; techScore: number | null };
  flags: { status: FlagStatus; recalls: number | null; openRecalls: number | null; note: string | null };
}

export interface SearchResult {
  mode: SearchMode;
  query: string | null;
  productCode: string | null;
  subject: { deviceName: string; productCode: string | null; hasIfuText: boolean; hasTechText: boolean };
  items: Candidate[];
  nextCursor: string | null;
}

export interface Citation {
  marker: string | null;
  label: string;
}

export interface SeCell {
  text: string;
  citations: Citation[];
}

export interface SeRow {
  key: string;
  attribute: string;
  subject: SeCell;
  predicate: SeCell;
  comparison: Comparison;
  note: string | null;
  edited: boolean;
}

export interface SeComparison {
  id: string;
  projectId: string;
  predicateKNumber: string;
  predicateDeviceName: string | null;
  predicateApplicant: string | null;
  rows: SeRow[];
  counts: { rows: number; same: number; different: number; review: number; edited: number };
  builtAt: string;
  updatedAt: string;
}

type Request = <T>(path: string, init?: Omit<ApiRequest, 'token'>) => Promise<T>;

export function predicatesApi(request: Request, projectId: string) {
  const p = `/api/projects/${encodeURIComponent(projectId)}`;
  const c = (id: string) => `/api/se-comparisons/${encodeURIComponent(id)}`;
  return {
    search: (params: { mode: SearchMode; q?: string; productCode?: string; cursor?: string }) => {
      const qs = new URLSearchParams({ mode: params.mode, limit: '10' });
      if (params.q) qs.set('q', params.q);
      if (params.productCode) qs.set('productCode', params.productCode);
      if (params.cursor) qs.set('cursor', params.cursor);
      return request<SearchResult>(`${p}/predicates/search?${qs.toString()}`);
    },
    comparisons: () => request<{ items: SeComparison[] }>(`${p}/se-comparisons`),
    compare: (kNumber: string) => request<SeComparison>(`${p}/se-comparisons`, { method: 'POST', body: { kNumber } }),
    get: (id: string) => request<SeComparison>(c(id)),
    rebuild: (id: string) => request<SeComparison>(`${c(id)}/rebuild`, { method: 'POST', body: {} }),
    editRow: (id: string, key: string, body: { comparison?: Comparison; note?: string | null; subjectText?: string; predicateText?: string }) =>
      request<SeComparison>(`${c(id)}/rows/${encodeURIComponent(key)}`, { method: 'PATCH', body }),
    remove: (id: string) => request<void>(c(id), { method: 'DELETE' }),
    exportFile: (id: string, format: 'docx' | 'xlsx') => request<Blob>(`${c(id)}/export?format=${format}`, { responseType: 'blob' }),
  };
}

export const LEVEL_LABEL: Record<Level, string> = { high: 'high', medium: 'medium', low: 'low', unknown: 'not known' };
export const COMPARISON_LABEL: Record<Comparison, string> = { same: 'Same', different: 'Different', review: 'To review' };

export function flagLabel(f: Candidate['flags']): string {
  if (f.status === 'recall_linked') return `Recall linked (${f.recalls ?? 0})`;
  if (f.status === 'unknown') return 'Recalls not checked';
  return 'Clean';
}
