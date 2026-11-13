import { apiRequest, ApiRequest } from './api';

/** F6.2 opt-in introductions: server routes in server/src/routes/introductions.ts. */

export type Pathway = '510k' | 'de_novo' | 'pma';
export type RequestPathway = Pathway | 'unsure';

/** FDA medical specialty (review panel) codes, as in FDA's eSTAR and classification data. */
export const SPECIALTIES: { code: string; label: string }[] = [
  { code: 'AN', label: 'Anesthesiology' },
  { code: 'CV', label: 'Cardiovascular' },
  { code: 'CH', label: 'Clinical Chemistry' },
  { code: 'TX', label: 'Clinical Toxicology' },
  { code: 'DE', label: 'Dental' },
  { code: 'EN', label: 'Ear, Nose, & Throat' },
  { code: 'GU', label: 'Gastroenterology & Urology' },
  { code: 'SU', label: 'General & Plastic Surgery' },
  { code: 'HO', label: 'General Hospital & Personal Use' },
  { code: 'HE', label: 'Hematology' },
  { code: 'IM', label: 'Immunology' },
  { code: 'MI', label: 'Microbiology' },
  { code: 'NE', label: 'Neurology' },
  { code: 'OB', label: 'Obstetrics/Gynecology' },
  { code: 'OP', label: 'Ophthalmic' },
  { code: 'OR', label: 'Orthopedic' },
  { code: 'PA', label: 'Pathology' },
  { code: 'PM', label: 'Physical Medicine' },
  { code: 'RA', label: 'Radiology' },
];
export const PATHWAYS: { key: Pathway; label: string }[] = [
  { key: '510k', label: '510(k)' },
  { key: 'de_novo', label: 'De Novo' },
  { key: 'pma', label: 'PMA' },
];

export interface IntroSettings {
  optedIn: boolean;
  specialties: string[];
  pathways: Pathway[];
  profile: string | null;
  updatedAt: string | null;
}

export interface Introduction {
  id: string;
  status: 'offered' | 'accepted' | 'declined';
  offeredAt: string;
  decidedAt: string | null;
  brief: string;
  pathway: RequestPathway;
  pathwayLabel: string;
  specialty: string | null;
  specialtyLabel: string | null;
  productCode: string | null;
  company: { name: string; contactName: string; contactEmail: string } | null;
}

export interface RequestBody {
  companyName: string;
  contactName: string;
  contactEmail: string;
  brief: string;
  productCode?: string;
  specialty?: string;
  pathway: RequestPathway;
  consent: boolean;
  website?: string;
}

type Request = <T>(path: string, init?: Omit<ApiRequest, 'token'>) => Promise<T>;

export const submitIntroductionRequest = (body: RequestBody) => apiRequest<{ id: string }>('/api/public/introduction-requests', { method: 'POST', body });

export function introductionsApi(request: Request) {
  return {
    settings: () => request<IntroSettings>('/api/introductions/settings'),
    saveSettings: (body: { optedIn: boolean; specialties: string[]; pathways: Pathway[]; profile: string | null }) =>
      request<IntroSettings>('/api/introductions/settings', { method: 'PUT', body }),
    list: (cursor?: string) => request<{ items: Introduction[]; nextCursor: string | null }>(`/api/introductions?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
    decide: (id: string, decision: 'accept' | 'decline') => request<Introduction>(`/api/introductions/${encodeURIComponent(id)}/${decision}`, { method: 'POST', body: {} }),
  };
}
