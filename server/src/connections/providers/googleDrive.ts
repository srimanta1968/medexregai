/**
 * Google Drive adapter (Drive API v3). Written against the published API; NOT yet
 * run against a live Google account (see types.ts).
 *
 *   OAuth:   accounts.google.com/o/oauth2/v2/auth (PKCE S256, access_type=offline),
 *            oauth2.googleapis.com/token; scope drive.readonly
 *   Account: GET /drive/v3/about?fields=user
 *   Revoke:  POST oauth2.googleapis.com/revoke
 *   Listing: GET /drive/v3/files?q='<id>' in parents (walked recursively; shared drives included)
 *   Changes: GET /drive/v3/changes (cursor = page token from changes/startPageToken);
 *            a change is in scope when its parent chain reaches the linked folder
 *   Bytes:   files/:id?alt=media, or files/:id/export for native Docs/Sheets/Slides
 *            (exported as .docx/.xlsx/.pptx; Google caps exports at 10 MB)
 *   Hash:    sha256Checksum, else md5Checksum (native Google files have neither)
 */

import { config } from '../../config/env';
import { expiry, getBytes, getJson, postForm } from './http';
import { FolderChanges, FolderProvider, OAuthTokens, READ_ONLY_SCOPES, RemoteFile } from './types';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const REQUESTED = ['https://www.googleapis.com/auth/drive.readonly'];
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const EXPORTS: Record<string, string> = {
  'application/vnd.google-apps.document': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.google-apps.spreadsheet': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.google-apps.presentation': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const FILE_FIELDS = 'id,name,mimeType,size,md5Checksum,sha256Checksum,modifiedTime,parents,trashed';
const ALL_DRIVES = 'supportsAllDrives=true&includeItemsFromAllDrives=true';

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  md5Checksum?: string;
  sha256Checksum?: string;
  modifiedTime?: string;
  parents?: string[];
  trashed?: boolean;
}

const app = () => config.connections.providers.google_drive;

function toFile(f: DriveFile, path: string): RemoteFile | null {
  if (f.mimeType === FOLDER_MIME) return null;
  // Other native types (forms, drawings, sites) have no usable export.
  if (f.mimeType.startsWith('application/vnd.google-apps.') && !EXPORTS[f.mimeType]) return null;
  return {
    id: f.id,
    name: f.name,
    path,
    sizeBytes: f.size ? Number(f.size) : null,
    providerHash: f.sha256Checksum ? { algorithm: 'sha256', value: f.sha256Checksum } : f.md5Checksum ? { algorithm: 'md5', value: f.md5Checksum } : null,
    modifiedAt: f.modifiedTime ?? null,
    mimeType: f.mimeType,
    ...(EXPORTS[f.mimeType] ? { exportAs: EXPORTS[f.mimeType] } : {}),
  };
}

async function token(form: Record<string, string>): Promise<{ tokens: OAuthTokens; scopes: string[] }> {
  const a = app();
  if (!a) throw new Error('Google Drive is not configured');
  const r = await postForm<TokenResponse>('https://oauth2.googleapis.com/token', { ...form, client_id: a.clientId, client_secret: a.clientSecret }, 'Google token');
  return {
    tokens: { accessToken: r.access_token, refreshToken: r.refresh_token ?? null, expiresAt: expiry(r.expires_in) },
    scopes: (r.scope ?? REQUESTED.join(' ')).split(/\s+/).filter(Boolean),
  };
}

export const googleDrive: FolderProvider = {
  id: 'google_drive',
  label: 'Google Drive',
  get configured() {
    return app() !== null;
  },
  scopes: READ_ONLY_SCOPES.google_drive,
  canRevokeAtProvider: true,

  authorizeUrl({ state, codeChallenge, redirectUri }) {
    const q = new URLSearchParams({
      client_id: app()?.clientId ?? '',
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: REQUESTED.join(' '),
      access_type: 'offline',
      // Google only returns a refresh token on consent; ask for it every time.
      prompt: 'consent',
      include_granted_scopes: 'false',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  },

  exchangeCode({ code, codeVerifier, redirectUri }) {
    return token({ grant_type: 'authorization_code', code, code_verifier: codeVerifier, redirect_uri: redirectUri });
  },

  async refresh(refreshToken) {
    const { tokens } = await token({ grant_type: 'refresh_token', refresh_token: refreshToken });
    return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
  },

  async account(accessToken) {
    const r = await getJson<{ user: { permissionId: string; emailAddress: string } }>(`${DRIVE}/about?fields=user(permissionId,emailAddress)`, accessToken, 'Google account');
    return { externalAccountId: r.user.permissionId, label: r.user.emailAddress };
  },

  async revoke({ accessToken, refreshToken }) {
    try {
      await postForm('https://oauth2.googleapis.com/revoke', { token: refreshToken ?? accessToken }, 'Google revoke');
      return { revoked: true, note: null };
    } catch (err) {
      return { revoked: false, note: `Google did not confirm the revocation (${(err as Error).message}).` };
    }
  },

  async folder(accessToken, idOrPath) {
    if (!/^[A-Za-z0-9_-]{10,}$/.test(idOrPath)) throw new Error('Pick the Google Drive folder by its id');
    const f = await getJson<DriveFile>(`${DRIVE}/files/${idOrPath}?fields=${FILE_FIELDS}&supportsAllDrives=true`, accessToken, 'Google folder');
    if (f.mimeType !== FOLDER_MIME) throw new Error('That Google Drive item is not a folder');
    // Display path: walk up to 10 parents (My Drive / shared drive roots end the walk).
    const names = [f.name];
    let parent = f.parents?.[0];
    for (let i = 0; parent && i < 10; i++) {
      const p = await getJson<DriveFile>(`${DRIVE}/files/${parent}?fields=id,name,parents&supportsAllDrives=true`, accessToken, 'Google folder');
      if (!p.parents?.length) break;
      names.unshift(p.name);
      parent = p.parents[0];
    }
    return { id: f.id, path: `/${names.join('/')}` };
  },

  async listAll(accessToken, folder) {
    const { startPageToken } = await getJson<{ startPageToken: string }>(`${DRIVE}/changes/startPageToken?supportsAllDrives=true`, accessToken, 'Google changes');
    const files: RemoteFile[] = [];
    const queue: Array<{ id: string; prefix: string }> = [{ id: folder.id, prefix: '' }];
    while (queue.length) {
      const dir = queue.shift()!;
      let pageToken = '';
      do {
        const q = encodeURIComponent(`'${dir.id}' in parents and trashed = false`);
        const page = await getJson<{ files: DriveFile[]; nextPageToken?: string }>(
          `${DRIVE}/files?q=${q}&fields=nextPageToken,files(${FILE_FIELDS})&pageSize=1000&${ALL_DRIVES}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
          accessToken,
          'Google list',
        );
        for (const f of page.files) {
          const path = dir.prefix ? `${dir.prefix}/${f.name}` : f.name;
          if (f.mimeType === FOLDER_MIME) queue.push({ id: f.id, prefix: path });
          else {
            const rf = toFile(f, path);
            if (rf) files.push(rf);
          }
        }
        pageToken = page.nextPageToken ?? '';
      } while (pageToken);
    }
    return { files, cursor: startPageToken };
  },

  async changes(accessToken, folder, cursor) {
    const out: FolderChanges = { changed: [], removed: [], cursor };
    // Ancestry cache for this call: folder id -> path inside the linked folder, or null when outside it.
    const inside = new Map<string, string | null>([[folder.id, '']]);
    const resolve = async (id: string, depth = 0): Promise<string | null> => {
      if (inside.has(id)) return inside.get(id)!;
      if (depth > 30) return null;
      const p = await getJson<DriveFile>(`${DRIVE}/files/${id}?fields=id,name,parents&supportsAllDrives=true`, accessToken, 'Google changes').catch(() => null);
      const up = p?.parents?.[0];
      const base = up ? await resolve(up, depth + 1) : null;
      const path = base === null || !p ? null : base ? `${base}/${p.name}` : p.name;
      inside.set(id, path);
      return path;
    };
    let pageToken: string | undefined = cursor;
    while (pageToken) {
      const page: { changes: Array<{ fileId: string; removed?: boolean; file?: DriveFile }>; nextPageToken?: string; newStartPageToken?: string } = await getJson(
        `${DRIVE}/changes?pageToken=${encodeURIComponent(pageToken)}&fields=nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))&pageSize=1000&includeRemoved=true&${ALL_DRIVES}`,
        accessToken,
        'Google changes',
      );
      for (const ch of page.changes) {
        const f = ch.file;
        if (ch.removed || !f || f.trashed) {
          out.removed.push({ id: ch.fileId });
          continue;
        }
        if (f.mimeType === FOLDER_MIME) continue;
        const base = f.parents?.[0] ? await resolve(f.parents[0]) : null;
        const rf = base === null ? null : toFile(f, base ? `${base}/${f.name}` : f.name);
        if (rf) out.changed.push(rf);
        else out.removed.push({ id: f.id });
      }
      if (page.newStartPageToken) out.cursor = page.newStartPageToken;
      pageToken = page.nextPageToken;
    }
    return out;
  },

  download(accessToken, file, maxBytes) {
    const id = encodeURIComponent(file.id);
    return file.exportAs
      ? getBytes(`${DRIVE}/files/${id}/export?mimeType=${encodeURIComponent(file.exportAs)}`, accessToken, maxBytes, 'Google export')
      : getBytes(`${DRIVE}/files/${id}?alt=media&supportsAllDrives=true`, accessToken, maxBytes, 'Google download');
  },
};
