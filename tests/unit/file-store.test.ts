import { describe, expect, it } from 'vitest';
import {
  FILE_STORES,
  FileStoreClient,
  FileStoreError,
  fileStoreConfig,
  type FetchLike,
} from '../../apps/api/src/services/file-store.js';
import type { AppEnv } from '../../apps/api/src/env.js';

/**
 * The file-store clients.
 *
 * These talk to Google Drive and Microsoft Graph, which this deployment has no
 * credentials for, so what is checked here is everything on this side of the wire: which
 * URL is called, which parameters are on it, how each provider's shape is read back, and
 * which failures are worth retrying. The live handshake is a separate question that only
 * a registered OAuth application can answer.
 */

const DRIVE = FILE_STORES.find((s) => s.kind === 'google_drive')!;
const ONEDRIVE = FILE_STORES.find((s) => s.kind === 'onedrive')!;
const SHAREPOINT = FILE_STORES.find((s) => s.kind === 'sharepoint')!;

function stub(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, ...(init ? { init } : {}) });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('file store availability', () => {
  const env = (over: Partial<AppEnv>) => ({ MICROSOFT_OAUTH_TENANT: 'common', ...over }) as AppEnv;

  it('reports a provider as unavailable until both halves of its credential are set', () => {
    expect(fileStoreConfig(env({}), 'google_drive')).toBeNull();
    expect(fileStoreConfig(env({ GOOGLE_OAUTH_CLIENT_ID: 'id' }), 'google_drive')).toBeNull();
    expect(
      fileStoreConfig(
        env({ GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 'secret' }),
        'google_drive',
      ),
    ).toMatchObject({ clientId: 'id', clientSecret: 'secret' });
  });

  it('shares one Microsoft application between OneDrive and SharePoint', () => {
    const configured = env({
      MICROSOFT_OAUTH_CLIENT_ID: 'id',
      MICROSOFT_OAUTH_CLIENT_SECRET: 'secret',
      MICROSOFT_OAUTH_TENANT: 'contoso',
    });
    expect(fileStoreConfig(configured, 'onedrive')).toMatchObject({ tenant: 'contoso' });
    expect(fileStoreConfig(configured, 'sharepoint')).toMatchObject({ tenant: 'contoso' });
  });

  it('asks for read-only scopes and nothing more', () => {
    for (const store of FILE_STORES) {
      expect(store.scopes.join(' ')).not.toMatch(/write|readwrite|manage/i);
    }
    expect(DRIVE.scopes).toContain('https://www.googleapis.com/auth/drive.readonly');
  });
});

describe('access token exchange', () => {
  const config = { clientId: 'id', clientSecret: 'secret', redirectUri: '' };

  it('trades a refresh token at the right endpoint for each provider', async () => {
    const google = stub(() => json({ access_token: 'at-google' }));
    await FileStoreClient.accessTokenFrom(DRIVE, config, 'refresh', google.fetchImpl);
    expect(google.calls[0]?.url).toBe('https://oauth2.googleapis.com/token');

    const microsoft = stub(() => json({ access_token: 'at-ms' }));
    await FileStoreClient.accessTokenFrom(
      ONEDRIVE,
      { ...config, tenant: 'contoso' },
      'refresh',
      microsoft.fetchImpl,
    );
    expect(microsoft.calls[0]?.url).toContain('/contoso/oauth2/v2.0/token');
  });

  it('treats a refused refresh token as final, not as something to retry', async () => {
    const { fetchImpl } = stub(() => json({ error: 'invalid_grant' }, 400));
    await expect(
      FileStoreClient.accessTokenFrom(DRIVE, config, 'revoked', fetchImpl),
    ).rejects.toMatchObject({ retryable: false });
  });

  it('treats a provider outage as worth retrying', async () => {
    const { fetchImpl } = stub(() => json({}, 503));
    await expect(
      FileStoreClient.accessTokenFrom(DRIVE, config, 'refresh', fetchImpl),
    ).rejects.toMatchObject({ retryable: true });
  });
});

describe('Google Drive listing', () => {
  it('excludes folders and trashed files, and spans shared drives', async () => {
    const { fetchImpl, calls } = stub(() => json({ files: [] }));
    await new FileStoreClient(DRIVE, 'token', fetchImpl).listFiles();

    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('q')).toContain('trashed = false');
    expect(url.searchParams.get('q')).toContain("mimeType != 'application/vnd.google-apps.folder'");
    // Without both of these a document in a shared drive is invisible, which is exactly
    // where a consultancy keeps its client material.
    expect(url.searchParams.get('supportsAllDrives')).toBe('true');
    expect(url.searchParams.get('includeItemsFromAllDrives')).toBe('true');
  });

  it('reads the response shape, and routes a native document to export', async () => {
    const { fetchImpl } = stub(() =>
      json({
        nextPageToken: 'page-2',
        files: [
          { id: '1', name: 'Fire code.pdf', mimeType: 'application/pdf', size: '2048' },
          { id: '2', name: 'Notes', mimeType: 'application/vnd.google-apps.document' },
        ],
      }),
    );

    const page = await new FileStoreClient(DRIVE, 'token', fetchImpl).listFiles();
    expect(page.nextPageToken).toBe('page-2');
    expect(page.files[0]).toMatchObject({ externalId: '1', sizeBytes: 2048 });
    expect(page.files[0]?.downloadUrl).toContain('alt=media');
    // A Google-native document has no bytes to download; it has to be exported.
    expect(page.files[1]?.downloadUrl).toContain('/export?mimeType=application/pdf');
    expect(page.files[1]?.sizeBytes).toBeNull();
  });

  it('passes a page token back when continuing', async () => {
    const { fetchImpl, calls } = stub(() => json({ files: [] }));
    await new FileStoreClient(DRIVE, 'token', fetchImpl).listFiles('page-2');
    expect(new URL(calls[0]!.url).searchParams.get('pageToken')).toBe('page-2');
  });
});

describe('Microsoft Graph listing', () => {
  it('reads a personal drive for OneDrive and the site drive for SharePoint', async () => {
    const one = stub(() => json({ value: [] }));
    await new FileStoreClient(ONEDRIVE, 'token', one.fetchImpl).listFiles();
    expect(one.calls[0]?.url).toContain('/me/drive/root/children');

    const site = stub(() => json({ value: [] }));
    await new FileStoreClient(SHAREPOINT, 'token', site.fetchImpl).listFiles();
    expect(site.calls[0]?.url).toContain('/sites/root/drive/root/children');
  });

  it('drops folders and carries the pre-signed download link', async () => {
    const { fetchImpl } = stub(() =>
      json({
        '@odata.nextLink': 'https://graph.microsoft.com/next',
        value: [
          { id: 'a', name: 'Reports', folder: { childCount: 3 } },
          {
            id: 'b',
            name: 'Policy.docx',
            size: 4096,
            file: {
              mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            },
            '@microsoft.graph.downloadUrl': 'https://download.example/b',
          },
        ],
      }),
    );

    const page = await new FileStoreClient(ONEDRIVE, 'token', fetchImpl).listFiles();
    expect(page.files).toHaveLength(1);
    expect(page.files[0]).toMatchObject({ externalId: 'b', sizeBytes: 4096 });
    expect(page.files[0]?.downloadUrl).toBe('https://download.example/b');
    // Graph hands back a whole URL rather than a cursor, and it is followed verbatim.
    expect(page.nextPageToken).toBe('https://graph.microsoft.com/next');
  });

  it('follows the next link exactly as given', async () => {
    const { fetchImpl, calls } = stub(() => json({ value: [] }));
    await new FileStoreClient(ONEDRIVE, 'token', fetchImpl).listFiles(
      'https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=abc',
    );
    expect(calls[0]?.url).toContain('$skiptoken=abc');
  });
});

describe('failures', () => {
  it('separates the provider asking for patience from this application asking wrongly', async () => {
    for (const [status, retryable] of [
      [429, true],
      [503, true],
      [403, false],
      [404, false],
    ] as const) {
      const { fetchImpl } = stub(() => json({}, status));
      await expect(
        new FileStoreClient(DRIVE, 'token', fetchImpl).listFiles(),
      ).rejects.toMatchObject({ retryable });
    }
  });

  it('refuses to download something with no content rather than guessing at a URL', async () => {
    const { fetchImpl, calls } = stub(() => json({}));
    await expect(
      new FileStoreClient(ONEDRIVE, 'token', fetchImpl).download({
        externalId: 'a',
        name: 'Folder shortcut',
        mimeType: 'application/octet-stream',
        sizeBytes: null,
        modifiedAt: null,
        downloadUrl: null,
      }),
    ).rejects.toBeInstanceOf(FileStoreError);
    expect(calls).toHaveLength(0);
  });

  it('sends the bearer token on every call', async () => {
    const { fetchImpl, calls } = stub(() => json({ files: [] }));
    await new FileStoreClient(DRIVE, 'secret-token', fetchImpl).listFiles();
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer secret-token');
  });
});
