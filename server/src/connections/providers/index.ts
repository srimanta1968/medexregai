import { createHash, randomBytes } from 'crypto';
import { config } from '../../config/env';
import { AppError, ErrorCodes } from '../../utils/AppError';
import { CONNECTION_PROVIDERS, ConnectionProvider } from '../ConnectionStore';
import { box } from './box';
import { dropbox } from './dropbox';
import { googleDrive } from './googleDrive';
import { onedrive } from './onedrive';
import { FolderProvider, READ_ONLY_SCOPES } from './types';

export * from './types';
export { ProviderAuthError, ProviderError, ProviderRateLimited } from './http';

const PROVIDERS: Record<ConnectionProvider, FolderProvider> = { dropbox, box, onedrive, google_drive: googleDrive };

export const isConnectionProvider = (v: unknown): v is ConnectionProvider =>
  typeof v === 'string' && (CONNECTION_PROVIDERS as readonly string[]).includes(v);

/** Every provider, configured or not (the Connect screen shows which are available). */
export const listProviders = (): FolderProvider[] => CONNECTION_PROVIDERS.map((p) => PROVIDERS[p]);

/** A provider ready to use, or a clear refusal when its OAuth app is not configured. */
export function getProvider(id: string): FolderProvider {
  if (!isConnectionProvider(id)) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Unknown folder provider');
  const p = PROVIDERS[id];
  if (!p.configured) {
    throw new AppError(503, ErrorCodes.CONNECTION_PROVIDER_NOT_CONFIGURED, `${p.label} is not set up on this server yet. Ask your administrator to add its OAuth app.`);
  }
  return p;
}

/** The redirect URI registered with every provider (same origin as the web app, as with SSO). */
export const redirectUri = (provider: ConnectionProvider): string => `${config.appBaseUrl}/api/connections/oauth/${provider}/callback`;

/** RFC 7636 PKCE pair (S256). */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/**
 * Refuse a grant wider than read-only. Returns the granted scopes that are outside
 * the provider's read-only list (empty when the grant is acceptable).
 */
export function scopesBeyondReadOnly(provider: ConnectionProvider, granted: string[]): string[] {
  const allowed = new Set(READ_ONLY_SCOPES[provider].map((s) => s.toLowerCase()));
  return granted.filter((s) => !allowed.has(s.toLowerCase()));
}
