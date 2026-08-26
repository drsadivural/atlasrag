import type { OAuthConfig, OAuthProvider } from '@uxe/auth';
import type { AppEnv } from '../env.js';
import type { FileStoreKind } from '@uxe/contracts';

/**
 * What each attachable file store is and what it needs.
 *
 * Kept as data rather than as branches so the settings screen, the authorize route and
 * the sync worker all read the same definition; a scope added in one place cannot then
 * disagree with the scope requested in another.
 */
export interface FileStoreDefinition {
  kind: FileStoreKind;
  provider: OAuthProvider;
  label: string;
  description: string;
  /** Requested on top of the sign-in scopes. Read-only by design: this product reads
   *  documents and writes nothing back to the account it was given. */
  scopes: string[];
  requiredEnv: string[];
}

export const FILE_STORES: readonly FileStoreDefinition[] = [
  {
    kind: 'google_drive',
    provider: 'google',
    label: 'Google Drive',
    description: 'Import documents from a Google account or shared drive.',
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    requiredEnv: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'],
  },
  {
    kind: 'onedrive',
    provider: 'microsoft',
    label: 'OneDrive',
    description: "Import documents from a Microsoft 365 account's own drive.",
    scopes: ['Files.Read.All'],
    requiredEnv: ['MICROSOFT_OAUTH_CLIENT_ID', 'MICROSOFT_OAUTH_CLIENT_SECRET'],
  },
  {
    kind: 'sharepoint',
    provider: 'microsoft',
    label: 'SharePoint',
    description: 'Import documents from SharePoint document libraries.',
    scopes: ['Sites.Read.All', 'Files.Read.All'],
    requiredEnv: ['MICROSOFT_OAUTH_CLIENT_ID', 'MICROSOFT_OAUTH_CLIENT_SECRET'],
  },
];

/**
 * The OAuth application for a store, or null when this deployment has none.
 *
 * Null is a first-class answer rather than a thrown error: the settings screen asks this
 * for every provider on every load, and two of the three being unset is an ordinary
 * state, not a failure.
 */
export function fileStoreConfig(env: AppEnv, kind: FileStoreKind): OAuthConfig | null {
  const store = FILE_STORES.find((s) => s.kind === kind);
  if (!store) return null;

  if (store.provider === 'google') {
    if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) return null;
    return {
      clientId: env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirectUri: '',
    };
  }

  if (!env.MICROSOFT_OAUTH_CLIENT_ID || !env.MICROSOFT_OAUTH_CLIENT_SECRET) return null;
  return {
    clientId: env.MICROSOFT_OAUTH_CLIENT_ID,
    clientSecret: env.MICROSOFT_OAUTH_CLIENT_SECRET,
    redirectUri: '',
    ...(env.MICROSOFT_OAUTH_TENANT ? { tenant: env.MICROSOFT_OAUTH_TENANT } : {}),
  };
}

export interface RemoteFile {
  externalId: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  modifiedAt: string | null;
  /** Absent for a Google-native document, which has no byte stream until it is exported. */
  downloadUrl: string | null;
}

export interface FileStorePage {
  files: RemoteFile[];
  /** Opaque; hand it back to continue. Null when the listing is complete. */
  nextPageToken: string | null;
}

/** Injected so the listing logic can be exercised without reaching a provider. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class FileStoreError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'FileStoreError';
  }
}

/**
 * Reads documents out of a connected account.
 *
 * Only the two calls the ingestion pipeline needs: list what is there, and fetch one
 * file's bytes. Nothing writes, and nothing deletes — the grant this holds is read-only,
 * and the class should not be able to exceed it even by mistake.
 */
export class FileStoreClient {
  constructor(
    private readonly store: FileStoreDefinition,
    private readonly accessToken: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  /** Trades the stored refresh token for a short-lived access token. */
  static async accessTokenFrom(
    store: FileStoreDefinition,
    config: OAuthConfig,
    refreshToken: string,
    fetchImpl: FetchLike = fetch,
  ): Promise<string> {
    const endpoint =
      store.provider === 'google'
        ? 'https://oauth2.googleapis.com/token'
        : `https://login.microsoftonline.com/${config.tenant ?? 'common'}/oauth2/v2.0/token`;

    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });

    if (!response.ok) {
      // A refused refresh token means the account holder revoked the grant or changed
      // their password. Retrying will not help; the connection has to be made again.
      throw new FileStoreError(
        'The connected account no longer accepts this authorisation. Reconnect it in Settings.',
        response.status,
        response.status >= 500,
      );
    }

    const payload = (await response.json()) as { access_token?: string };
    if (!payload.access_token) {
      throw new FileStoreError('The provider returned no access token.', 502, true);
    }
    return payload.access_token;
  }

  async listFiles(pageToken?: string | null): Promise<FileStorePage> {
    return this.store.provider === 'google' ? this.listDrive(pageToken) : this.listGraph(pageToken);
  }

  async download(file: RemoteFile): Promise<Uint8Array> {
    if (!file.downloadUrl) {
      throw new FileStoreError(`${file.name} has no downloadable content.`, 400, false);
    }
    const response = await this.fetchImpl(file.downloadUrl, {
      headers: { authorization: `Bearer ${this.accessToken}` },
    });
    if (!response.ok) {
      throw new FileStoreError(
        `Could not download ${file.name}.`,
        response.status,
        response.status >= 500 || response.status === 429,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  private async listDrive(pageToken?: string | null): Promise<FileStorePage> {
    const params = new URLSearchParams({
      // Folders are traversed by the listing itself, so they are excluded here; trashed
      // files are excluded because importing something the owner deleted is a surprise.
      q: "mimeType != 'application/vnd.google-apps.folder' and trashed = false",
      fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime)',
      pageSize: '100',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const payload = await this.json<{
      nextPageToken?: string;
      files?: Array<{
        id: string;
        name: string;
        mimeType: string;
        size?: string;
        modifiedTime?: string;
      }>;
    }>(`https://www.googleapis.com/drive/v3/files?${params}`);

    return {
      files: (payload.files ?? []).map((file) => ({
        externalId: file.id,
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.size ? Number(file.size) : null,
        modifiedAt: file.modifiedTime ?? null,
        // A Google-native document is exported rather than downloaded, and the export is
        // a different endpoint with a different format, so it is named as such here.
        downloadUrl: file.mimeType.startsWith('application/vnd.google-apps.')
          ? `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=application/pdf`
          : `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
      })),
      nextPageToken: payload.nextPageToken ?? null,
    };
  }

  private async listGraph(pageToken?: string | null): Promise<FileStorePage> {
    const url =
      pageToken ??
      (this.store.kind === 'sharepoint'
        ? 'https://graph.microsoft.com/v1.0/sites/root/drive/root/children?$top=100'
        : 'https://graph.microsoft.com/v1.0/me/drive/root/children?$top=100');

    const payload = await this.json<{
      '@odata.nextLink'?: string;
      value?: Array<{
        id: string;
        name: string;
        size?: number;
        lastModifiedDateTime?: string;
        folder?: unknown;
        file?: { mimeType?: string };
        '@microsoft.graph.downloadUrl'?: string;
      }>;
    }>(url);

    return {
      files: (payload.value ?? [])
        .filter((item) => !item.folder)
        .map((item) => ({
          externalId: item.id,
          name: item.name,
          mimeType: item.file?.mimeType ?? 'application/octet-stream',
          sizeBytes: item.size ?? null,
          modifiedAt: item.lastModifiedDateTime ?? null,
          downloadUrl: item['@microsoft.graph.downloadUrl'] ?? null,
        })),
      nextPageToken: payload['@odata.nextLink'] ?? null,
    };
  }

  private async json<T>(url: string): Promise<T> {
    const response = await this.fetchImpl(url, {
      headers: { authorization: `Bearer ${this.accessToken}`, accept: 'application/json' },
    });
    if (!response.ok) {
      throw new FileStoreError(
        `${this.store.label} refused the request.`,
        response.status,
        // 429 and 5xx are the provider asking for patience; everything else is this
        // application asking for something it may not have.
        response.status >= 500 || response.status === 429,
      );
    }
    return (await response.json()) as T;
  }
}
