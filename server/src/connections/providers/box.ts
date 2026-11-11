/**
 * Box adapter (API 2.0). Written against the published API; NOT yet run against a
 * live Box account (see types.ts).
 *
 *   OAuth:   account.box.com/api/oauth2/authorize, api.box.com/oauth2/token
 *            (scope root_readonly; the refresh token rotates on every refresh)
 *   Account: GET /2.0/users/me
 *   Revoke:  POST /oauth2/revoke
 *   Listing: GET /2.0/folders/:id/items (marker paging, walked recursively)
 *   Changes: GET /2.0/events?stream_type=changes (cursor = next_stream_position)
 *   Bytes:   GET /2.0/files/:id/content
 *   Hash:    sha1
 *
 * Box's documentation does not list PKCE for its OAuth 2.0 flow, so the code
 * challenge is not sent; the one-time state still binds the callback.
 */

import { config } from '../../config/env';
import { expiry, getBytes, getJson, postForm } from './http';
import { FolderChanges, FolderProvider, FolderRef, OAuthTokens, READ_ONLY_SCOPES, RemoteFile } from './types';

const API = 'https://api.box.com';
const SCOPES = READ_ONLY_SCOPES.box;

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

interface PathEntry {
  id: string;
  name: string;
}

interface Item {
  type: 'file' | 'folder' | 'web_link';
  id: string;
  name: string;
  size?: number;
  sha1?: string;
  modified_at?: string;
  item_status?: 'active' | 'trashed' | 'deleted';
  path_collection?: { entries: PathEntry[] };
}

interface Event {
  event_type: string;
  source?: Item | null;
}

const app = () => config.connections.providers.box;
const FIELDS = 'id,type,name,size,sha1,modified_at,item_status,path_collection';

async function token(form: Record<string, string>): Promise<OAuthTokens> {
  const a = app();
  if (!a) throw new Error('Box is not configured');
  const r = await postForm<TokenResponse>(`${API}/oauth2/token`, { ...form, client_id: a.clientId, client_secret: a.clientSecret }, 'Box token');
  return { accessToken: r.access_token, refreshToken: r.refresh_token ?? null, expiresAt: expiry(r.expires_in) };
}

/** Path of an item inside the linked folder, from Box's path_collection. */
function pathInside(item: Item, folder: FolderRef): string | null {
  const entries = item.path_collection?.entries ?? [];
  const at = entries.findIndex((e) => e.id === folder.id);
  if (at < 0) return null;
  return [...entries.slice(at + 1).map((e) => e.name), item.name].join('/');
}

function toFile(item: Item, path: string): RemoteFile {
  return {
    id: item.id,
    name: item.name,
    path,
    sizeBytes: item.size ?? null,
    providerHash: item.sha1 ? { algorithm: 'sha1', value: item.sha1 } : null,
    modifiedAt: item.modified_at ?? null,
    mimeType: null,
  };
}

const REMOVAL_EVENTS = new Set(['ITEM_TRASH', 'ITEM_DELETE']);
const CHANGE_EVENTS = new Set(['ITEM_UPLOAD', 'ITEM_CREATE', 'ITEM_MOVE', 'ITEM_RENAME', 'ITEM_COPY', 'ITEM_UNDELETE_VIA_TRASH']);

export const box: FolderProvider = {
  id: 'box',
  label: 'Box',
  get configured() {
    return app() !== null;
  },
  scopes: SCOPES,
  canRevokeAtProvider: true,

  authorizeUrl({ state, redirectUri }) {
    const q = new URLSearchParams({ response_type: 'code', client_id: app()?.clientId ?? '', redirect_uri: redirectUri, state, scope: SCOPES.join(' ') });
    return `https://account.box.com/api/oauth2/authorize?${q}`;
  },

  async exchangeCode({ code, redirectUri }) {
    // Box does not echo the granted scopes; the app's configuration and the scope
    // parameter above limit it to root_readonly.
    return { tokens: await token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }), scopes: [...SCOPES] };
  },

  refresh(refreshToken) {
    return token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  },

  async account(accessToken) {
    const r = await getJson<{ id: string; login: string }>(`${API}/2.0/users/me?fields=id,login`, accessToken, 'Box account');
    return { externalAccountId: r.id, label: r.login };
  },

  async revoke({ accessToken, refreshToken }) {
    const a = app();
    if (!a) return { revoked: false, note: 'Box is not configured, so the grant could not be revoked there.' };
    try {
      await postForm(`${API}/oauth2/revoke`, { client_id: a.clientId, client_secret: a.clientSecret, token: refreshToken ?? accessToken }, 'Box revoke');
      return { revoked: true, note: null };
    } catch (err) {
      return { revoked: false, note: `Box did not confirm the revocation (${(err as Error).message}).` };
    }
  },

  async folder(accessToken, idOrPath) {
    if (!/^\d+$/.test(idOrPath)) throw new Error('Pick the Box folder by its id');
    const r = await getJson<Item>(`${API}/2.0/folders/${idOrPath}?fields=${FIELDS}`, accessToken, 'Box folder');
    const parents = (r.path_collection?.entries ?? []).filter((e) => e.id !== '0').map((e) => e.name);
    return { id: r.id, path: `/${[...parents, r.name].join('/')}` };
  },

  async listAll(accessToken, folder) {
    // Take the stream position first, so a change made while we walk is not missed.
    const { next_stream_position } = await getJson<{ next_stream_position: number | string }>(
      `${API}/2.0/events?stream_type=changes&stream_position=now`,
      accessToken,
      'Box events',
    );
    const files: RemoteFile[] = [];
    const queue: Array<{ id: string; prefix: string }> = [{ id: folder.id, prefix: '' }];
    while (queue.length) {
      const dir = queue.shift()!;
      let marker = '';
      do {
        const page = await getJson<{ entries: Item[]; next_marker?: string | null }>(
          `${API}/2.0/folders/${dir.id}/items?fields=${FIELDS}&limit=1000&usemarker=true${marker ? `&marker=${encodeURIComponent(marker)}` : ''}`,
          accessToken,
          'Box list',
        );
        for (const it of page.entries) {
          const path = dir.prefix ? `${dir.prefix}/${it.name}` : it.name;
          if (it.type === 'folder') queue.push({ id: it.id, prefix: path });
          else if (it.type === 'file') files.push(toFile(it, path));
        }
        marker = page.next_marker ?? '';
      } while (marker);
    }
    return { files, cursor: String(next_stream_position) };
  },

  async changes(accessToken, folder, cursor) {
    const out: FolderChanges = { changed: [], removed: [], cursor };
    for (;;) {
      const page = await getJson<{ entries: Event[]; next_stream_position: number | string; chunk_size: number }>(
        `${API}/2.0/events?stream_type=changes&limit=500&stream_position=${encodeURIComponent(out.cursor)}`,
        accessToken,
        'Box changes',
      );
      for (const ev of page.entries) {
        const src = ev.source;
        if (!src || src.type !== 'file') continue;
        const path = pathInside(src, folder);
        if (REMOVAL_EVENTS.has(ev.event_type) || src.item_status === 'trashed' || src.item_status === 'deleted') out.removed.push({ id: src.id });
        else if (CHANGE_EVENTS.has(ev.event_type)) {
          // A move out of the linked folder is a removal from our point of view.
          if (path === null) out.removed.push({ id: src.id });
          else out.changed.push(toFile(src, path));
        }
      }
      out.cursor = String(page.next_stream_position);
      if (page.chunk_size < 500) break;
    }
    return out;
  },

  download(accessToken, file, maxBytes) {
    return getBytes(`${API}/2.0/files/${encodeURIComponent(file.id)}/content`, accessToken, maxBytes, 'Box download');
  },
};
