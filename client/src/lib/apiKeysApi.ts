import { ApiRequest } from './api';

/** F6.3 API keys: server routes in server/src/routes/apiKeys.ts. */

export type ApiScope = 'portfolio:read' | 'fda:read';
export const SCOPES: { key: ApiScope; label: string }[] = [
  { key: 'portfolio:read', label: "Read the firm's portfolio" },
  { key: 'fda:read', label: 'Read FDA data' },
];

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  createdAt: string;
  createdBy: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  status: 'active' | 'expired' | 'revoked';
}

type Request = <T>(path: string, init?: Omit<ApiRequest, 'token'>) => Promise<T>;

export function apiKeysApi(request: Request) {
  return {
    list: () => request<{ items: ApiKey[]; nextCursor: string | null }>('/api/api-keys?limit=50'),
    create: (body: { name: string; scopes: ApiScope[]; expiresInDays?: number }) => request<{ key: ApiKey; secret: string }>('/api/api-keys', { method: 'POST', body }),
    revoke: (id: string) => request<void>(`/api/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  };
}

/** F6.3 billing (Stripe): server routes in server/src/routes/billing.ts. */
export interface CatalogItem {
  priceId: string;
  kind: 'plan' | 'credits';
  plan: string | null;
  credits: number | null;
  name: string;
  amount: number | null;
  currency: string;
  interval: string | null;
}

export interface Billing {
  plan: { key: string; priceId: string; status: string | null; currentPeriodEnd: string | null } | null;
  creditBalance: number;
  ledger: { id: string; delta: number; reason: string; note: string | null; createdAt: string }[];
  catalog: CatalogItem[];
  testMode: boolean;
}

export function billingApi(request: Request) {
  return {
    get: () => request<Billing>('/api/billing'),
    checkout: (priceId: string) => request<{ url: string; sessionId: string }>('/api/billing/checkout', { method: 'POST', body: { priceId } }),
  };
}

export const money = (amount: number | null, currency: string) =>
  amount === null ? '' : new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(amount / 100);
