import { ApiRequest } from './api';

/** Per-project forwarding address (F2.1). */

export interface InboundAddress {
  id: string;
  email: string;
  allowedSenders: string[];
  createdAt: string;
  createdByName: string | null;
}

export interface InboundSettings {
  configured: boolean;
  domain: string | null;
  address: InboundAddress | null;
}

export interface AttachmentOutcome {
  name: string;
  sizeBytes: number;
  outcome: 'stored' | 'unchanged' | 'refused';
  reason?: string;
  fileId?: string;
}

export interface InboundEmail {
  id: string;
  status: 'queued' | 'processing' | 'accepted' | 'rejected' | 'failed';
  reason: string | null;
  fromAddress: string | null;
  subject: string | null;
  sizeBytes: number;
  attachments: AttachmentOutcome[];
  receivedAt: string;
  processedAt: string | null;
}

type Request = <T>(path: string, init?: Omit<ApiRequest, 'token'>) => Promise<T>;

export function inboundApi(request: Request, projectId: string) {
  const base = `/api/projects/${encodeURIComponent(projectId)}`;
  return {
    settings: () => request<InboundSettings>(`${base}/inbound-email`),
    turnOn: () => request<InboundSettings>(`${base}/inbound-email`, { method: 'POST' }),
    setSenders: (allowedSenders: string[]) => request<InboundSettings>(`${base}/inbound-email`, { method: 'PATCH', body: { allowedSenders } }),
    turnOff: () => request<InboundSettings>(`${base}/inbound-email`, { method: 'DELETE' }),
    messages: () => request<{ items: InboundEmail[]; nextCursor: string | null }>(`${base}/inbound-emails?limit=20`),
  };
}
