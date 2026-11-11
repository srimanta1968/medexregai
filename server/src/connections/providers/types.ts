/**
 * The contract every read-only folder provider adapter implements (F2.1).
 *
 * Adapters are written against each provider's PUBLISHED API (Dropbox HTTP API v2,
 * Box API 2.0, Microsoft Graph v1.0, Google Drive API v3) and exercised with stubbed
 * responses. They have NOT yet been run against live provider accounts: that needs
 * an OAuth app per provider (client id + secret), which this environment does not
 * have. Treat any behaviour as unverified against the real service until it has been.
 *
 * Read-only by construction: every scope requested is a read scope, the granted
 * scopes are checked on connect, and no adapter has a write call.
 */

import type { ConnectionProvider } from '../ConnectionStore';

export interface OAuthTokens {
  accessToken: string;
  /** Null when the provider issues none (then the user must reconnect on expiry). */
  refreshToken: string | null;
  expiresAt: Date | null;
}

export interface ConnectedAccount {
  /** The provider's stable id for the account (one connection per account). */
  externalAccountId: string;
  /** Shown to the firm: usually the account email. */
  label: string;
}

export interface RemoteFile {
  /** Provider's stable file id. */
  id: string;
  name: string;
  /** Path for display, relative to the linked folder ("V&V/Bench report.docx"). */
  path: string;
  sizeBytes: number | null;
  /** The provider's own content hash, compared by the nightly sweep. */
  providerHash: { algorithm: 'dropbox_content_hash' | 'sha1' | 'quickxor' | 'sha256' | 'md5'; value: string } | null;
  modifiedAt: string | null;
  mimeType: string | null;
  /** Native Google Docs/Sheets/Slides: downloaded as an Office export. */
  exportAs?: string;
}

export interface FolderChanges {
  /** Files added or changed under the linked folder since the cursor. */
  changed: RemoteFile[];
  /**
   * Files removed (deleted, trashed or moved out of the folder). Dropbox reports a
   * deletion by path only, so an entry carries the id, the path, or both; ids that
   * do not match a linked file are ignored by the sync job.
   */
  removed: Array<{ id?: string; path?: string }>;
  /** Pass this back next time. */
  cursor: string;
}

export interface FolderRef {
  /** Provider folder id as stored in project_folder_links.folder_id. */
  id: string;
  path: string;
}

export interface FolderProvider {
  readonly id: ConnectionProvider;
  readonly label: string;
  /** False until the OAuth app (client id + secret) is configured. */
  readonly configured: boolean;
  /** Read scopes requested; the granted set must stay within READ_ONLY_SCOPES. */
  readonly scopes: readonly string[];
  /** True when the provider lets us revoke the grant itself on disconnect. */
  readonly canRevokeAtProvider: boolean;

  authorizeUrl(p: { state: string; codeChallenge: string; redirectUri: string }): string;
  exchangeCode(p: { code: string; codeVerifier: string; redirectUri: string }): Promise<{ tokens: OAuthTokens; scopes: string[] }>;
  refresh(refreshToken: string): Promise<OAuthTokens>;
  account(accessToken: string): Promise<ConnectedAccount>;
  /** Revoke the grant at the provider. Never throws: disconnecting must go ahead regardless. */
  revoke(tokens: { accessToken: string; refreshToken: string | null }): Promise<{ revoked: boolean; note: string | null }>;

  /** Resolve a folder the user picked (id or path) to its stable id and display path. */
  folder(accessToken: string, idOrPath: string): Promise<FolderRef>;
  /** Every file under the folder (recursive) plus a cursor for changes(). */
  listAll(accessToken: string, folder: FolderRef): Promise<{ files: RemoteFile[]; cursor: string }>;
  /** What changed under the folder since the cursor (the provider's change feed). */
  changes(accessToken: string, folder: FolderRef, cursor: string): Promise<FolderChanges>;
  /** The file's bytes (an Office export for native Google files). Capped at maxBytes. */
  download(accessToken: string, file: RemoteFile, maxBytes: number): Promise<Buffer>;
}

/** Every scope any adapter may hold. A grant wider than this is refused on connect. */
export const READ_ONLY_SCOPES: Readonly<Record<ConnectionProvider, readonly string[]>> = {
  dropbox: ['files.metadata.read', 'files.content.read', 'account_info.read'],
  box: ['root_readonly'],
  onedrive: ['Files.Read.All', 'User.Read', 'offline_access', 'openid', 'profile', 'email'],
  google_drive: [
    'https://www.googleapis.com/auth/drive.readonly',
    'openid',
    'email',
    'https://www.googleapis.com/auth/userinfo.email',
  ],
};
