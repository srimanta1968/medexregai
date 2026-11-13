import { ApiRequest } from './api';

/** F5.1 FDA letters: server routes in server/src/routes/fdaLetters.ts. */

export type LetterKind = 'ai_request' | 'rta_hold';
export type LetterStatus = 'open' | 'responded' | 'closed';
export type DeficiencyStatus = 'open' | 'requested' | 'drafting' | 'ready' | 'answered';
export type Owner = 'consultant' | 'client';

export interface Deficiency {
  id: string;
  number: number;
  summary: string;
  fdaText: string;
  sectionId: string | null;
  sectionTitle: string | null;
  owner: Owner;
  status: DeficiencyStatus;
  dueOn: string | null;
  files: { id: string; name: string }[];
  statements: { id: string; text: string }[];
}

export interface LetterSummary {
  id: string;
  projectId: string;
  kind: LetterKind;
  fdaReference: string | null;
  issuedOn: string;
  receivedOn: string | null;
  dueOn: string;
  status: LetterStatus;
  respondedOn: string | null;
  daysLeft: number | null;
  deficiencyCount: number;
  answeredCount: number;
  fileVersionId: string | null;
  notes: string | null;
  createdAt: string;
}

export interface Letter extends LetterSummary {
  deficiencies: Deficiency[];
}

export interface ProposedDeficiency {
  number: number;
  summary: string;
  fdaText: string;
  sectionId: string | null;
  sectionTitle: string | null;
  sectionCues: string[];
  files: { id: string; name: string }[];
  statements: { id: string; text: string; sectionTitle: string }[];
}

export interface Proposal {
  kind: LetterKind;
  fdaReference: string | null;
  issuedOn: string | null;
  dueOn: string | null;
  deficiencies: ProposedDeficiency[];
  notes: string[];
}

export interface NewLetter {
  kind: LetterKind;
  fdaReference?: string | null;
  issuedOn: string;
  receivedOn?: string | null;
  dueOn?: string | null;
  fileVersionId?: string | null;
  deficiencies: { number: number; summary: string; fdaText: string; sectionId?: string | null; owner?: Owner; fileIds?: string[]; statementIds?: string[] }[];
}

type Request = <T>(path: string, init?: Omit<ApiRequest, 'token'>) => Promise<T>;

export function fdaLettersApi(request: Request, projectId: string) {
  const p = `/api/projects/${encodeURIComponent(projectId)}/fda-letters`;
  const l = (id: string) => `/api/fda-letters/${encodeURIComponent(id)}`;
  const d = (id: string) => `/api/fda-deficiencies/${encodeURIComponent(id)}`;
  return {
    list: () => request<{ items: LetterSummary[] }>(p),
    split: (body: { text?: string; fileVersionId?: string }) => request<Proposal>(`${p}/split`, { method: 'POST', body }),
    create: (body: NewLetter) => request<Letter>(p, { method: 'POST', body }),
    get: (id: string) => request<Letter>(l(id)),
    update: (id: string, body: { status?: LetterStatus; dueOn?: string; receivedOn?: string | null; notes?: string | null }) => request<Letter>(l(id), { method: 'PATCH', body }),
    remove: (id: string) => request<void>(l(id), { method: 'DELETE' }),
    skeleton: (id: string) => request<Blob>(`${l(id)}/response-skeleton`, { responseType: 'blob' }),
    updateDeficiency: (id: string, body: { status?: DeficiencyStatus; owner?: Owner; sectionId?: string | null }) => request<Deficiency>(d(id), { method: 'PATCH', body }),
  };
}

export const KIND_LABEL: Record<LetterKind, string> = { ai_request: 'Additional Information request', rta_hold: 'RTA hold' };
export const STATUS_LABEL: Record<DeficiencyStatus, string> = { open: 'Open', requested: 'Requested from client', drafting: 'Drafting', ready: 'Ready', answered: 'Answered' };

/** A YYYY-MM-DD date plus a number of calendar days. */
export function addDays(isoDate: string, days: number): string {
  const dt = new Date(`${isoDate}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** "17 days left", "due today", "overdue by 3 days". */
export function clock(daysLeft: number | null): string {
  if (daysLeft === null) return '';
  if (daysLeft === 0) return 'due today';
  if (daysLeft < 0) return `overdue by ${-daysLeft} day${daysLeft === -1 ? '' : 's'}`;
  return `${daysLeft} day${daysLeft === 1 ? '' : 's'} left`;
}
