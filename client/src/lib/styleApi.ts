import { ApiRequest } from './api';

/** F3.6 firm style sources: server routes in server/src/routes/styleSources.ts. */

export interface StyleSettings {
  enabled: boolean;
  updatedAt: string | null;
  updatedByName: string | null;
}

export interface FirmTemplate {
  id: string;
  sectionId: string;
  sectionTitle: string;
  name: string;
  body: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Precedent {
  id: string;
  sectionId: string;
  sectionTitle: string;
  sourceLabel: string;
  text: string;
  enabled: boolean;
  createdAt: string;
}

export interface SectionStyle {
  enabled: boolean;
  sectionId: string;
  template: { id: string; name: string; enabled: boolean; inUse: boolean } | null;
  precedents: { id: string; sourceLabel: string; text: string }[];
  precedentCount: number;
}

interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

type Request = <T>(path: string, init?: Omit<ApiRequest, 'token'>) => Promise<T>;

const page = (path: string, cursor?: string | null, extra: Record<string, string> = {}): string => {
  const q = new URLSearchParams({ limit: '50', ...extra });
  if (cursor) q.set('cursor', cursor);
  return `${path}?${q.toString()}`;
};

/** Calls for the firm's templates and past wording. */
export function styleApi(request: Request) {
  return {
    settings: () => request<StyleSettings>('/api/style-sources'),
    setEnabled: (enabled: boolean) => request<StyleSettings>('/api/style-sources', { method: 'PUT', body: { enabled } }),
    templates: (cursor?: string | null) => request<Page<FirmTemplate>>(page('/api/templates', cursor)),
    createTemplate: (body: { sectionId: string; name: string; body: string }) => request<FirmTemplate>('/api/templates', { method: 'POST', body }),
    updateTemplate: (id: string, body: { name?: string; body?: string; enabled?: boolean }) =>
      request<FirmTemplate>(`/api/templates/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    deleteTemplate: (id: string) => request<void>(`/api/templates/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    precedents: (cursor?: string | null) => request<Page<Precedent>>(page('/api/precedents', cursor)),
    createPrecedent: (body: { sectionId: string; sourceLabel: string; text: string }) => request<Precedent>('/api/precedents', { method: 'POST', body }),
    updatePrecedent: (id: string, body: { sourceLabel?: string; text?: string; enabled?: boolean }) =>
      request<Precedent>(`/api/precedents/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    deletePrecedent: (id: string) => request<void>(`/api/precedents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    forSection: (projectSectionId: string) => request<SectionStyle>(`/api/project-sections/${encodeURIComponent(projectSectionId)}/precedents`),
  };
}
