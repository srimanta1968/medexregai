/**
 * Dropbox adapter (HTTP API v2). Written against the published API; NOT yet run
 * against a live Dropbox account (see types.ts).
 *
 *   OAuth:   /oauth2/authorize (PKCE S256, token_access_type=offline), /oauth2/token
 *   Account: POST /2/users/get_current_account
 *   Revoke:  POST /2/auth/token/revoke
 *   Listing: POST /2/files/list_folder (recursive) + /list_folder/continue (the change feed)
 *   Bytes:   POST content.dropboxapi.com/2/files/download (Dropbox-API-Arg header)
 *   Hash:    content_hash (Dropbox's block SHA-256)
 */

import { config } from '../../config/env';
import { expiry, getBytes, postForm, postJson, relPath } from './http';
import { FolderChanges, FolderProvider, FolderRef, OAuthTokens, READ_ONLY_SCOPES, RemoteFile } from './types';

const API = 'https://api.dropboxapi.com';
const CONTENT = 'https://content.dropboxapi.com';
const SCOPES = READ_ONLY_SCOPES.dropbox;

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

interface Entry {
  '.tag': 'file' | 'folder' | 'deleted';
  id?: string;
  name: string;
  path_display?: string;
  path_lower?: string;
  size?: number;
  content_hash?: string;
  server_modified?: string;
}

interface ListResult {
  entries: Entry[];
  cursor: string;
  has_more: boolean;
}

const app = () => config.connections.providers.dropbox;

function toFile(e: Entry, folder: FolderRef): RemoteFile | null {
  if (e['.tag'] !== 'file' || !e.id) return null;
  return {
    id: e.id,
    name: e.name,
    path: relPath(e.path_display ?? e.name, folder.path),
    sizeBytes: e.size ?? null,
    providerHash: e.content_hash ? { algorithm: 'dropbox_content_hash', value: e.content_hash } : null,
    modifiedAt: e.server_modified ?? null,
    mimeType: null,
  };
}

function collect(entries: Entry[], folder: FolderRef, out: FolderChanges): void {
  for (const e of entries) {
    if (e['.tag'] === 'deleted') out.removed.push({ path: relPath(e.path_display ?? e.path_lower ?? e.name, folder.path) });
    else {
      const f = toFile(e, folder);
      if (f) out.changed.push(f);
    }
  }
}

async function token(form: Record<string, string>): Promise<{ tokens: OAuthTokens; scopes: string[] }> {
  const a = app();
  if (!a) throw new Error('Dropbox is not configured');
  const r = await postForm<TokenResponse>(`${API}/oauth2/token`, { ...form, client_id: a.clientId, client_secret: a.clientSecret }, 'Dropbox token');
  return {
    tokens: { accessToken: r.access_token, refreshToken: r.refresh_token ?? null, expiresAt: expiry(r.expires_in) },
    scopes: r.scope ? r.scope.split(/\s+/).filter(Boolean) : [...SCOPES],
  };
}

export const dropbox: FolderProvider = {
  id: 'dropbox',
  label: 'Dropbox',
  get configured() {
    return app() !== null;
  },
  scopes: SCOPES,
  canRevokeAtProvider: true,

  authorizeUrl({ state, codeChallenge, redirectUri }) {
    const q = new URLSearchParams({
      client_id: app()?.clientId ?? '',
      response_type: 'code',
      redirect_uri: redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      token_access_type: 'offline',
      scope: SCOPES.join(' '),
    });
    return `https://www.dropbox.com/oauth2/authorize?${q}`;
  },

  exchangeCode({ code, codeVerifier, redirectUri }) {
    return token({ grant_type: 'authorization_code', code, code_verifier: codeVerifier, redirect_uri: redirectUri });
  },

  async refresh(refreshToken) {
    const { tokens } = await token({ grant_type: 'refresh_token', refresh_token: refreshToken });
    // Dropbox keeps the same refresh token.
    return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
  },

  async account(accessToken) {
    const r = await postJson<{ account_id: string; email: string }>(`${API}/2/users/get_current_account`, accessToken, null, 'Dropbox account');
    return { externalAccountId: r.account_id, label: r.email };
  },

  async revoke({ accessToken }) {
    try {
      await postJson(`${API}/2/auth/token/revoke`, accessToken, null, 'Dropbox revoke');
      return { revoked: true, note: null };
    } catch (err) {
      return { revoked: false, note: `Dropbox did not confirm the revocation (${(err as Error).message}).` };
    }
  },

  async folder(accessToken, idOrPath) {
    const r = await postJson<Entry>(`${API}/2/files/get_metadata`, accessToken, { path: idOrPath }, 'Dropbox folder');
    if (r['.tag'] !== 'folder' || !r.id) throw new Error('That Dropbox item is not a folder');
    return { id: r.id, path: r.path_display ?? r.name };
  },

  async listAll(accessToken, folder) {
    const out: FolderChanges = { changed: [], removed: [], cursor: '' };
    let page = await postJson<ListResult>(
      `${API}/2/files/list_folder`,
      accessToken,
      { path: folder.id, recursive: true, include_deleted: false, include_non_downloadable_files: false, limit: 2000 },
      'Dropbox list',
    );
    collect(page.entries, folder, out);
    while (page.has_more) {
      page = await postJson<ListResult>(`${API}/2/files/list_folder/continue`, accessToken, { cursor: page.cursor }, 'Dropbox list');
      collect(page.entries, folder, out);
    }
    return { files: out.changed, cursor: page.cursor };
  },

  async changes(accessToken, folder, cursor) {
    const out: FolderChanges = { changed: [], removed: [], cursor };
    let page: ListResult;
    do {
      page = await postJson<ListResult>(`${API}/2/files/list_folder/continue`, accessToken, { cursor: out.cursor }, 'Dropbox changes');
      collect(page.entries, folder, out);
      out.cursor = page.cursor;
    } while (page.has_more);
    return out;
  },

  download(accessToken, file, maxBytes) {
    return getBytes(`${CONTENT}/2/files/download`, accessToken, maxBytes, 'Dropbox download', { 'Dropbox-API-Arg': JSON.stringify({ path: file.id }) }, 'POST');
  },
};
