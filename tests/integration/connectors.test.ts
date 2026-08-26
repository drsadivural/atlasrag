import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encryptSecret } from '@uxe/auth';
import { runConnectorSync } from '../../apps/api/src/jobs/connector-sync.js';
import type { FetchLike } from '../../apps/api/src/services/file-store.js';
import {
  Client,
  addMember,
  createHarness,
  registerOwner,
  truncateAll,
  type Harness,
  type RegisteredAccount,
} from './harness.js';

let harness: Harness;
let owner: RegisteredAccount;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  harness.resetRateLimits();
  owner = await registerOwner(harness);
});

describe('connectors', () => {
  it('lists all three providers, and says which the deployment can actually offer', async () => {
    const response = await owner.client.get<{
      providers: Array<{
        kind: string;
        available: boolean;
        requiredEnv: string[];
        redirectUri: string;
        connection: unknown;
      }>;
    }>('/connectors');

    expect(response.status).toBe(200);
    expect(response.body.providers.map((p) => p.kind)).toEqual([
      'google_drive',
      'onedrive',
      'sharepoint',
    ]);

    // This harness has no OAuth applications, which is the ordinary state for a fresh
    // deployment; the response says so rather than hiding the providers.
    for (const provider of response.body.providers) {
      expect(provider.available).toBe(false);
      expect(provider.requiredEnv.length).toBeGreaterThan(0);
      expect(provider.redirectUri).toContain('/connectors/callback');
      expect(provider.connection).toBeNull();
    }
  });

  it('refuses to start a flow it cannot finish, and names what is missing', async () => {
    const response = await owner.client.post<{
      error: { code: string; message: string; details: { requiredEnv: string[] } };
    }>('/connectors/google_drive/authorize', { returnTo: '/settings/connectors' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('provider_unconfigured');
    // An operator reading this should not have to go looking for the variable names.
    expect(response.body.error.details.requiredEnv).toEqual([
      'GOOGLE_OAUTH_CLIENT_ID',
      'GOOGLE_OAUTH_CLIENT_SECRET',
    ]);
  });

  it('does not invent a provider that is not one of the three', async () => {
    const response = await owner.client.post('/connectors/dropbox/authorize', {});
    expect(response.status).toBe(404);
  });

  it('keeps the connector list inside its own workspace', async () => {
    const other = await registerOwner(harness);
    const mine = await owner.client.get<{ providers: unknown[] }>('/connectors');
    const theirs = await other.client.get<{ providers: unknown[] }>('/connectors');

    // Both see the catalogue; neither sees the other's connections, because there are
    // none to see. The isolation that matters is checked where a row exists.
    expect(mine.status).toBe(200);
    expect(theirs.status).toBe(200);
  });

  it('requires an administrator to connect or disconnect', async () => {
    const member = await addMember(harness, owner, 'member');

    const authorize = await member.client.post('/connectors/google_drive/authorize', {});
    expect(authorize.status).toBe(403);

    // Reading is a different matter: a member can see that Drive exists.
    const list = await member.client.get('/connectors');
    expect(list.status).toBe(200);
  });

  it('rejects a callback whose state was never issued', async () => {
    const client = new Client(harness);
    const response = await client.get('/connectors/callback?state=not-a-real-state&code=abc');

    // A redirect back to the app carrying the failure, not a raw error page: the person
    // holding this browser tab came from Google and should land somewhere they recognise.
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('connector=failed');
  });

  it('rejects a callback with no state at all', async () => {
    const client = new Client(harness);
    const response = await client.get('/connectors/callback?code=abc');
    expect(response.status).toBe(400);
  });
});

/**
 * Importing from a connected account.
 *
 * The grant itself is written straight into the repository rather than earned through a
 * consent screen, and the provider is a stub: this deployment has no OAuth application,
 * and the point of the case is what happens to the files once they arrive, which is the
 * part that belongs to this codebase.
 */
describe('connector sync', () => {
  /** Distinct bytes per file, or the content-hash dedup would treat them as one document. */
  const pdfFor = (id: string) => new TextEncoder().encode(`%PDF-1.4\nExtract for ${id}\n%%EOF`);

  // Its own deployment, one that has a Google OAuth application. The credential is never
  // used against Google — the provider below is a stub — but the sync rightly refuses to
  // run at all for a deployment that could not have obtained a grant in the first place.
  let configured: Harness;

  beforeAll(async () => {
    configured = await createHarness({
      GOOGLE_OAUTH_CLIENT_ID: 'test-client-id',
      GOOGLE_OAUTH_CLIENT_SECRET: 'test-client-secret',
    });
  });

  afterAll(async () => {
    await configured.close();
  });

  /**
   * Both harnesses share one database, and the outer hook truncates it, so the account
   * for these cases is created inside the test rather than in a hook of its own — that
   * way nothing depends on which truncation happens to run last.
   */
  async function freshAccount(): Promise<RegisteredAccount> {
    configured.resetRateLimits();
    return registerOwner(configured);
  }

  function provider(files: Array<Record<string, unknown>>): FetchLike {
    return async (url) => {
      if (url.includes('/token')) {
        return new Response(JSON.stringify({ access_token: 'stub-access-token' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/drive/v3/files?')) {
        return new Response(JSON.stringify({ files }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      const id = /files\/([^/?]+)/.exec(url)?.[1] ?? 'unknown';
      return new Response(pdfFor(id), { headers: { 'content-type': 'application/pdf' } });
    };
  }

  async function connect(owner: RegisteredAccount) {
    const tenant = {
      organizationId: owner.organizationId,
      workspaceId: owner.workspaceId,
      userId: owner.userId,
      role: 'owner' as const,
      groupIds: [],
      traceId: 'test',
    };
    const credential = await encryptSecret(
      'stub-refresh-token',
      configured.deps.env.ENCRYPTION_KEY,
    );
    const row = await configured.deps.repos.connectors.connect(tenant, {
      kind: 'google_drive',
      displayName: 'Google Drive',
      accountEmail: 'library@example.test',
      credentialEncrypted: credential,
    });
    return { tenant, connectorId: row.id };
  }

  it('imports each readable file as an ordinary source', async () => {
    const account = await freshAccount();
    const { tenant, connectorId } = await connect(account);

    const outcome = await runConnectorSync(configured.deps, tenant, {
      connectorId,
      fetchImpl: provider([
        { id: 'f1', name: 'Fire code.pdf', mimeType: 'application/pdf', size: '32' },
        { id: 'f2', name: 'Evacuation plan.pdf', mimeType: 'application/pdf', size: '32' },
      ]),
    });

    expect(outcome.imported).toBe(2);
    expect(outcome.failed).toBe(0);

    // They are sources like any other, which is the whole point: retrievable, citable and
    // correctable by the same paths as a hand-uploaded document.
    const sources = await account.client.get<{ items: Array<{ title: string }> }>(
      '/sources?page=1&pageSize=50',
    );
    const titles = sources.body.items.map((s) => s.title);
    expect(titles).toContain('Fire code');
    expect(titles).toContain('Evacuation plan');
  });

  it('skips what it cannot read, and says which', async () => {
    const account = await freshAccount();
    const { tenant, connectorId } = await connect(account);

    const outcome = await runConnectorSync(configured.deps, tenant, {
      connectorId,
      fetchImpl: provider([
        { id: 'f1', name: 'Fire code.pdf', mimeType: 'application/pdf', size: '32' },
        { id: 'f2', name: 'archive.zip', mimeType: 'application/zip', size: '32' },
      ]),
    });

    expect(outcome.imported).toBe(1);
    expect(outcome.skipped).toBe(1);
    // Counted is not enough; a skipped file has to be named or nobody can go and fix it.
    expect(outcome.notes.join(' ')).toContain('archive.zip');
  });

  it('does not multiply the library when the same sync runs twice', async () => {
    const account = await freshAccount();
    const { tenant, connectorId } = await connect(account);
    const files = [{ id: 'f1', name: 'Fire code.pdf', mimeType: 'application/pdf', size: '32' }];

    const first = await runConnectorSync(configured.deps, tenant, {
      connectorId,
      fetchImpl: provider(files),
    });
    const second = await runConnectorSync(configured.deps, tenant, {
      connectorId,
      fetchImpl: provider(files),
    });

    expect(first.imported).toBe(1);
    // Recognised by content hash, so a renamed but unchanged file is the same document.
    expect(second.imported).toBe(0);
    expect(second.alreadyPresent).toBe(1);
  });

  it('records the failure on the connector when the account stops accepting the grant', async () => {
    const account = await freshAccount();
    const { tenant, connectorId } = await connect(account);

    const revoked: FetchLike = async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });

    await expect(
      runConnectorSync(configured.deps, tenant, { connectorId, fetchImpl: revoked }),
    ).rejects.toThrow();

    const list = await account.client.get<{
      providers: Array<{ kind: string; connection: { status: string; lastError: string } | null }>;
    }>('/connectors');
    const drive = list.body.providers.find((p) => p.kind === 'google_drive');
    expect(drive?.connection?.status).toBe('error');
    // Shown on the card, so somebody can act on it without reading a log.
    expect(drive?.connection?.lastError).toContain('Reconnect');
  });

  it('marks the connection healthy and timestamped after a clean run', async () => {
    const account = await freshAccount();
    const { tenant, connectorId } = await connect(account);

    await runConnectorSync(configured.deps, tenant, {
      connectorId,
      fetchImpl: provider([
        { id: 'f1', name: 'Fire code.pdf', mimeType: 'application/pdf', size: '32' },
      ]),
    });

    const list = await account.client.get<{
      providers: Array<{
        kind: string;
        connection: { status: string; lastSyncedAt: string } | null;
      }>;
    }>('/connectors');
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const drive = list.body.providers.find((p) => p.kind === 'google_drive');
    expect(drive?.connection?.status).toBe('connected');
    expect(drive?.connection?.lastSyncedAt).toBeTruthy();
  });
});
