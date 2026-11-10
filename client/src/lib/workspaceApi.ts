/** Typed client for the clients / devices / projects API (server/src/routes/workspace.ts). */

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Client {
  id: string;
  name: string;
  status: 'active' | 'archived';
  createdAt: string;
}

export interface Device {
  id: string;
  clientId: string;
  name: string;
  modelNames: string[];
  udiDi: string | null;
  productCode: string | null;
  deviceClass: 'I' | 'II' | 'III' | null;
  createdAt: string;
}

export type SubmissionType = 'traditional' | 'special' | 'abbreviated';
export type ProjectStatus = 'active' | 'submitted' | 'cleared' | 'archived';

export interface Project {
  id: string;
  clientId: string;
  deviceId: string;
  name: string;
  submissionType: SubmissionType;
  status: ProjectStatus;
  targetDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDetail extends Project {
  client: Client;
  device: Device;
}

export const SUBMISSION_TYPE_LABELS: Record<SubmissionType, string> = {
  traditional: 'Traditional 510(k)',
  special: 'Special 510(k)',
  abbreviated: 'Abbreviated 510(k)',
};

type Request = <T>(path: string, init?: { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown }) => Promise<T>;

const qs = (params: Record<string, string | undefined>): string => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][];
  return entries.length ? `?${new URLSearchParams(entries).toString()}` : '';
};

/** Bind the API to an authenticated request function (useAuth().authedRequest). */
export function workspaceApi(request: Request) {
  return {
    listClients: (cursor?: string) => request<Page<Client>>(`/api/clients${qs({ limit: '50', cursor, status: 'active' })}`),
    createClient: (name: string) => request<Client>('/api/clients', { method: 'POST', body: { name } }),
    listDevices: (clientId: string, cursor?: string) =>
      request<Page<Device>>(`/api/clients/${encodeURIComponent(clientId)}/devices${qs({ limit: '20', cursor })}`),
    createDevice: (clientId: string, body: { name: string; modelNames: string[]; udiDi?: string; productCode?: string; deviceClass?: string }) =>
      request<Device>(`/api/clients/${encodeURIComponent(clientId)}/devices`, { method: 'POST', body }),
    listProjects: (clientId: string, cursor?: string) =>
      request<Page<Project>>(`/api/clients/${encodeURIComponent(clientId)}/projects${qs({ limit: '20', cursor })}`),
    createProject: (deviceId: string, body: { name: string; submissionType: SubmissionType; targetDate?: string }) =>
      request<Project>(`/api/devices/${encodeURIComponent(deviceId)}/projects`, { method: 'POST', body }),
    getProject: (projectId: string) => request<ProjectDetail>(`/api/projects/${encodeURIComponent(projectId)}`),
    updateProject: (projectId: string, body: { status?: ProjectStatus; name?: string; targetDate?: string | null }) =>
      request<Project>(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body }),
  };
}
