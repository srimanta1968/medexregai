/**
 * SharePoint / OneDrive adapter (Microsoft Graph v1.0). Written against the
 * published API; NOT yet run against a live Microsoft 365 tenant (see types.ts).
 *
 *   OAuth:   login.microsoftonline.com/<tenant>/oauth2/v2.0/{authorize,token} (PKCE S256)
 *            scopes Files.Read.All (delegated, read-only), User.Read, offline_access
 *   Account: GET /me
 *   Listing: GET /drives/:d/items/:i/children (walked recursively)
 *   Changes: GET /drives/:d/root/delta. Graph supports delta on non-root folders only
 *            in personal OneDrive, so the drive root is tracked and filtered to the
 *            linked folder by parentReference.path.
 *   Bytes:   GET /drives/:d/items/:i/content
 *   Hash:    quickXorHash (business) or sha1Hash (personal)
 *
 * Microsoft has no endpoint that revokes one app's delegated grant (revokeSignInSessions
 * would sign the user out everywhere). Disconnecting erases our tokens; the user removes
 * the app at myapps.microsoft.com (or an admin in Entra ID) to withdraw consent.
 *
 * Folder and file ids are stored as "<driveId>!<itemId>" because SharePoint libraries are separate drives.
 */

import { config } from '../../config/env';
import { expiry, getBytes, getJson, postForm } from './http';
import { FolderChanges, FolderProvider, FolderRef, OAuthTokens, READ_ONLY_SCOPES, RemoteFile } from './types';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const REQUESTED = ['offline_access', 'Files.Read.All', 'User.Read'];

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

interface DriveItem {
  id: string;
  name: string;
  size?: number;
  lastModifiedDateTime?: string;
  file?: { mimeType?: string; hashes?: { quickXorHash?: string; sha1Hash?: string; sha256Hash?: string } };
  folder?: { childCount?: number };
  deleted?: { state?: string };
  parentReference?: { driveId?: string; id?: string; path?: string };
}

interface Page {
  value: DriveItem[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

const app = () => config.connections.providers.onedrive;
const authority = () => `https://login.microsoftonline.com/${encodeURIComponent(config.connections.microsoftTenant)}/oauth2/v2.0`;
const SELECT = 'id,name,size,file,folder,deleted,parentReference,lastModifiedDateTime';

/** "https://graph.microsoft.com/Files.Read.All" -> "Files.Read.All". */
const normaliseScope = (s: string): string => s.replace(/^https:\/\/graph\.microsoft\.com\//i, '');

function split(folderId: string): { drive: string; item: string } {
  const at = folderId.indexOf('!');
  if (at < 1) throw new Error('Malformed OneDrive folder id');
  return { drive: folderId.slice(0, at), item: folderId.slice(at + 1) };
}

/** Graph's parentReference.path for children of the folder: "/drives/<d>/root:/A/B". */
const childPathPrefix = (folder: FolderRef, drive: string): string => `/drives/${drive}/root:${folder.path === '/' ? '' : folder.path}`;

function toFile(it: DriveItem, drive: string, path: string): RemoteFile {
  const h = it.file?.hashes;
  return {
    id: `${drive}!${it.id}`,
    name: it.name,
    path,
    sizeBytes: it.size ?? null,
    providerHash: h?.quickXorHash
      ? { algorithm: 'quickxor', value: h.quickXorHash }
      : h?.sha256Hash
        ? { algorithm: 'sha256', value: h.sha256Hash }
        : h?.sha1Hash
          ? { algorithm: 'sha1', value: h.sha1Hash }
          : null,
    modifiedAt: it.lastModifiedDateTime ?? null,
    mimeType: it.file?.mimeType ?? null,
  };
}

async function token(form: Record<string, string>): Promise<{ tokens: OAuthTokens; scopes: string[] }> {
  const a = app();
  if (!a) throw new Error('OneDrive/SharePoint is not configured');
  const r = await postForm<TokenResponse>(
    `${authority()}/token`,
    { ...form, client_id: a.clientId, client_secret: a.clientSecret, scope: REQUESTED.join(' ') },
    'Microsoft token',
  );
  return {
    tokens: { accessToken: r.access_token, refreshToken: r.refresh_token ?? null, expiresAt: expiry(r.expires_in) },
    scopes: (r.scope ?? REQUESTED.join(' ')).split(/\s+/).filter(Boolean).map(normaliseScope),
  };
}

export const onedrive: FolderProvider = {
  id: 'onedrive',
  label: 'SharePoint / OneDrive',
  get configured() {
    return app() !== null;
  },
  scopes: READ_ONLY_SCOPES.onedrive,
  canRevokeAtProvider: false,

  authorizeUrl({ state, codeChallenge, redirectUri }) {
    const q = new URLSearchParams({
      client_id: app()?.clientId ?? '',
      response_type: 'code',
      response_mode: 'query',
      redirect_uri: redirectUri,
      scope: REQUESTED.join(' '),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return `${authority()}/authorize?${q}`;
  },

  exchangeCode({ code, codeVerifier, redirectUri }) {
    return token({ grant_type: 'authorization_code', code, code_verifier: codeVerifier, redirect_uri: redirectUri });
  },

  async refresh(refreshToken) {
    const { tokens } = await token({ grant_type: 'refresh_token', refresh_token: refreshToken });
    return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
  },

  async account(accessToken) {
    const r = await getJson<{ id: string; userPrincipalName?: string; mail?: string | null }>(`${GRAPH}/me?$select=id,userPrincipalName,mail`, accessToken, 'Microsoft account');
    return { externalAccountId: r.id, label: r.mail || r.userPrincipalName || r.id };
  },

  async revoke() {
    return {
      revoked: false,
      note: 'Microsoft does not let an app revoke its own access. Our copy of the tokens is erased; remove "MedexRegAI" at https://myapps.microsoft.com (or ask your Microsoft 365 admin) to withdraw consent.',
    };
  },

  async folder(accessToken, idOrPath) {
    const url = idOrPath.includes('!')
      ? (() => {
          const { drive, item } = split(idOrPath);
          return `${GRAPH}/drives/${encodeURIComponent(drive)}/items/${encodeURIComponent(item)}?$select=${SELECT}`;
        })()
      : `${GRAPH}/me/drive/root:${encodeURI(idOrPath.startsWith('/') ? idOrPath : `/${idOrPath}`)}?$select=${SELECT}`;
    const it = await getJson<DriveItem>(url, accessToken, 'Microsoft folder');
    if (!it.folder) throw new Error('That OneDrive/SharePoint item is not a folder');
    const drive = it.parentReference?.driveId;
    if (!drive) throw new Error('Microsoft did not say which drive the folder is in');
    // "/drives/<d>/root:" -> "", "/drives/<d>/root:/Clients" -> "/Clients"
    const parent = decodeURIComponent((it.parentReference?.path ?? '').replace(/^\/drives\/[^/]+\/root:?/, ''));
    return { id: `${drive}!${it.id}`, path: `${parent}/${it.name}` };
  },

  async listAll(accessToken, folder) {
    const { drive, item } = split(folder.id);
    // The cursor comes first (token=latest returns a deltaLink with no items), so a
    // change made during the walk shows up in the next changes() call.
    let latest = await getJson<Page>(`${GRAPH}/drives/${encodeURIComponent(drive)}/root/delta?token=latest`, accessToken, 'Microsoft delta');
    while (!latest['@odata.deltaLink'] && latest['@odata.nextLink']) latest = await getJson<Page>(latest['@odata.nextLink'], accessToken, 'Microsoft delta');
    const files: RemoteFile[] = [];
    const queue: Array<{ id: string; prefix: string }> = [{ id: item, prefix: '' }];
    while (queue.length) {
      const dir = queue.shift()!;
      let next: string | undefined = `${GRAPH}/drives/${encodeURIComponent(drive)}/items/${encodeURIComponent(dir.id)}/children?$select=${SELECT}&$top=999`;
      while (next) {
        const page: Page = await getJson<Page>(next, accessToken, 'Microsoft list');
        for (const it of page.value) {
          const path = dir.prefix ? `${dir.prefix}/${it.name}` : it.name;
          if (it.folder) queue.push({ id: it.id, prefix: path });
          else if (it.file) files.push(toFile(it, drive, path));
        }
        next = page['@odata.nextLink'];
      }
    }
    return { files, cursor: latest['@odata.deltaLink'] ?? '' };
  },

  async changes(accessToken, folder, cursor) {
    const { drive } = split(folder.id);
    if (!cursor.startsWith(`${GRAPH}/`)) throw new Error('Malformed Microsoft delta cursor');
    const prefix = childPathPrefix(folder, drive);
    const out: FolderChanges = { changed: [], removed: [], cursor };
    let next: string | undefined = cursor;
    while (next) {
      const page: Page = await getJson<Page>(next, accessToken, 'Microsoft changes');
      for (const it of page.value) {
        if (it.deleted) {
          out.removed.push({ id: `${drive}!${it.id}` });
          continue;
        }
        if (!it.file) continue;
        const parent = it.parentReference?.path ?? '';
        if (parent === prefix || parent.startsWith(`${prefix}/`)) {
          const sub = parent.slice(prefix.length).replace(/^\//, '');
          out.changed.push(toFile(it, drive, sub ? `${decodeURIComponent(sub)}/${it.name}` : it.name));
        } else {
          // Moved out of the linked folder (or never in it): unknown ids are ignored by sync.
          out.removed.push({ id: `${drive}!${it.id}` });
        }
      }
      if (page['@odata.deltaLink']) out.cursor = page['@odata.deltaLink'];
      next = page['@odata.nextLink'];
    }
    return out;
  },

  download(accessToken, file, maxBytes) {
    const { drive, item } = split(file.id);
    return getBytes(`${GRAPH}/drives/${encodeURIComponent(drive)}/items/${encodeURIComponent(item)}/content`, accessToken, maxBytes, 'Microsoft download');
  },
};
