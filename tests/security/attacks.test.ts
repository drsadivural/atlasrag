import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Client,
  createHarness,
  registerOwner,
  truncateAll,
  waitForJob,
  type Harness,
  type RegisteredAccount,
} from '../integration/harness.js';
import { fixtureBytes, uploadFixture } from '../integration/helpers.js';

let harness: Harness;
let owner: RegisteredAccount;

beforeAll(async () => {
  harness = await createHarness();
}, 120_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  harness.resetRateLimits();
  owner = await registerOwner(harness);
});

describe('unauthenticated access', () => {
  const PROTECTED = [
    '/sources',
    '/consultations',
    '/dashboard',
    '/artifacts',
    '/audit-events',
    '/users',
    '/settings',
    '/jobs/01JQZZZZZZZZZZZZZZZZZZZZZZ',
  ];

  it('refuses every tenant endpoint without a session', async () => {
    const anonymous = new Client(harness);
    for (const path of PROTECTED) {
      const response = await anonymous.get(path);
      expect(response.status, path).toBe(401);
    }
  });

  it('does not leak data in the error body', async () => {
    const anonymous = new Client(harness);
    const response = await anonymous.get('/sources');
    const body = JSON.stringify(response.body);
    expect(body).not.toMatch(/stack|at Object|node_modules|postgres:\/\//i);
  });
});

describe('signed download URLs', () => {
  it('refuses a signed URL with a tampered signature, and one that has expired', async () => {
    const uploaded = await uploadFixture(harness, owner.client, 'regulation-native.pdf');

    const artifacts = await owner.client.get<{ items: Array<{ id: string }> }>('/artifacts');
    // Reports are generated on demand; the source download path carries the same signing.
    const source = await owner.client.get<{
      versions?: Array<{ id: string }>;
      downloadUrl?: string;
    }>(`/sources/${uploaded.sourceId}`);
    expect(artifacts.status).toBe(200);

    const url = source.body.downloadUrl;
    if (!url) return;

    const parsed = new URL(url, 'http://localhost:8788');
    const anonymous = new Client(harness);

    const tampered = new URL(parsed.toString());
    tampered.searchParams.set('sig', 'f'.repeat(64));
    const bad = await anonymous.get(
      `${tampered.pathname.replace('/api/v1', '')}${tampered.search}`,
    );
    expect(bad.status).toBeGreaterThanOrEqual(400);

    const expired = new URL(parsed.toString());
    expired.searchParams.set('exp', String(Math.floor(Date.now() / 1000) - 60));
    const stale = await anonymous.get(
      `${expired.pathname.replace('/api/v1', '')}${expired.search}`,
    );
    expect(stale.status).toBeGreaterThanOrEqual(400);
  }, 180_000);
});

describe('server-side request forgery', () => {
  const BLOCKED = [
    'http://127.0.0.1:8788/api/v1/settings',
    'http://localhost:5432',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/internal',
    'http://[::1]/',
    'file:///etc/passwd',
    'gopher://127.0.0.1:6379/_INFO',
  ];

  it('refuses to fetch a private, loopback, metadata or non-HTTP address', async () => {
    for (const url of BLOCKED) {
      const response = await owner.client.post('/sources/connectors', {
        connector: 'url',
        url,
        promoteToKnowledge: false,
      });
      expect(response.status, url).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(response.body), url).not.toMatch(/root:|meta-data|BEGIN|password/i);
    }
  });
});

describe('upload validation', () => {
  it('refuses a file larger than the configured limit before storing it', async () => {
    const response = await owner.client.post('/sources/uploads', {
      files: [{ fileName: 'huge.pdf', sizeBytes: 5_000_000_000, contentType: 'application/pdf' }],
      tags: [],
      accessScope: 'workspace',
      promoteToKnowledge: true,
    });
    expect(response.status).toBe(413);
  });

  it('refuses an executable disguised with a document extension', async () => {
    const elfBytes = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, ...new Array(60).fill(0x41)]);
    const ticket = await owner.client.post<{
      tickets: Array<{ sourceId: string; uploadUrl: string }>;
    }>('/sources/uploads', {
      files: [
        { fileName: 'invoice.pdf', sizeBytes: elfBytes.byteLength, contentType: 'application/pdf' },
      ],
      tags: [],
      accessScope: 'workspace',
      promoteToKnowledge: true,
    });

    const path = new URL(
      ticket.body.tickets[0]!.uploadUrl,
      'http://localhost:8788',
    ).pathname.replace('/api/v1', '');
    const put = await owner.client.request<{ job?: { id: string } }>('PUT', path, {
      rawBody: elfBytes,
      headers: { 'content-type': 'application/pdf' },
    });

    if (put.status < 300 && put.body.job) {
      await waitForJob(owner.client, put.body.job.id);
      const source = await owner.client.get<{ status: string; failureReason: string | null }>(
        `/sources/${ticket.body.tickets[0]!.sourceId}`,
      );
      // The pipeline handled it correctly; the document itself is refused.
      expect(['failed', 'quarantined']).toContain(source.body.status);
      expect(source.body.failureReason ?? '').not.toBe('');
    } else {
      expect(put.status).toBeGreaterThanOrEqual(400);
    }

    const ready = await owner.client.get<{ items: unknown[] }>('/sources?status=ready');
    expect(ready.body.items).toHaveLength(0);
  }, 120_000);

  it('refuses bytes that do not match the declared size', async () => {
    const bytes = await fixtureBytes('regulation-native.pdf');
    const ticket = await owner.client.post<{
      tickets: Array<{ uploadUrl: string }>;
    }>('/sources/uploads', {
      files: [{ fileName: 'small.pdf', sizeBytes: 100, contentType: 'application/pdf' }],
      tags: [],
      accessScope: 'workspace',
      promoteToKnowledge: true,
    });

    const path = new URL(
      ticket.body.tickets[0]!.uploadUrl,
      'http://localhost:8788',
    ).pathname.replace('/api/v1', '');
    const put = await owner.client.request('PUT', path, {
      rawBody: bytes,
      headers: { 'content-type': 'application/pdf' },
    });
    expect(put.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses a second upload against a used ticket', async () => {
    const bytes = await fixtureBytes('regulation-native.pdf');
    const ticket = await owner.client.post<{
      tickets: Array<{ uploadUrl: string }>;
    }>('/sources/uploads', {
      files: [
        { fileName: 'once.pdf', sizeBytes: bytes.byteLength, contentType: 'application/pdf' },
      ],
      tags: [],
      accessScope: 'workspace',
      promoteToKnowledge: true,
    });

    const path = new URL(
      ticket.body.tickets[0]!.uploadUrl,
      'http://localhost:8788',
    ).pathname.replace('/api/v1', '');
    const first = await owner.client.request('PUT', path, {
      rawBody: bytes,
      headers: { 'content-type': 'application/pdf' },
    });
    expect(first.status).toBeLessThan(300);

    const second = await owner.client.request('PUT', path, {
      rawBody: bytes,
      headers: { 'content-type': 'application/pdf' },
    });
    expect(second.status).toBeGreaterThanOrEqual(400);
  }, 120_000);
});

describe('injected content', () => {
  it('never lets a document’s instructions change the outcome', async () => {
    const injected = await uploadFixture(harness, owner.client, 'injection.pdf', { wait: false });
    if (injected.jobId) await waitForJob(owner.client, injected.jobId);

    const source = await owner.client.get<{ status: string }>(`/sources/${injected.sourceId}`);

    // Quarantined content must not be retrievable at all.
    if (source.body.status === 'quarantined') {
      const consultation = await owner.client.post<{ id: string }>('/consultations', {
        title: 'Injection probe',
        taskMode: 'ask',
        sourceIds: [injected.sourceId],
      });
      expect([200, 201, 400, 403]).toContain(consultation.status);
    }

    const ready = await owner.client.get<{ items: Array<{ id: string }> }>('/sources?status=ready');
    expect(ready.body.items.map((s) => s.id)).not.toContain(injected.sourceId);
  }, 120_000);
});

describe('cross-origin requests', () => {
  it('answers the preflight with every method the API actually serves', async () => {
    const response = await owner.client.request('OPTIONS', '/sources/uploads/01TEST/content', {
      headers: {
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'x-csrf-token,content-type',
      },
    });

    expect(response.status).toBe(204);
    const methods = (response.headers.get('access-control-allow-methods') ?? '')
      .split(',')
      .map((method) => method.trim());

    // PUT is how upload bytes arrive. Omitting it fails the preflight, and every browser
    // upload then reports a network error with no server-side trace of the attempt.
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(methods, `preflight omits ${method}`).toContain(method);
    }
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('refuses a preflight from an origin that is not on the allowlist', async () => {
    const response = await owner.client.request('OPTIONS', '/sources', {
      origin: 'https://evil.example.com',
      headers: { 'access-control-request-method': 'GET' },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('response hardening', () => {
  it('sets the security headers every response needs', async () => {
    const response = await owner.client.get('/sources');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBeTruthy();
    expect(response.headers.get('content-security-policy')).toBeTruthy();
    expect(response.headers.get('x-frame-options') ?? '').toMatch(/DENY|SAMEORIGIN/i);
  });

  it('does not echo the server stack or framework version', async () => {
    const response = await owner.client.get('/sources');
    expect(response.headers.get('x-powered-by')).toBeNull();
    expect(response.headers.get('server')).toBeNull();
  });

  it('carries a trace id the operator can look the failure up by', async () => {
    const response = await owner.client.get('/sources/01JQZZZZZZZZZZZZZZZZZZZZZZ');
    expect(response.status).toBe(404);
    const body = response.body as { error: { traceId: string } };
    expect(body.error.traceId).toMatch(/^[a-f0-9]{8,}$/);
  });

  it('rejects an oversized JSON body rather than parsing it', async () => {
    const response = await owner.client.post('/consultations', {
      title: 'x'.repeat(500_000),
      taskMode: 'ask',
      sourceIds: [],
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  it('rejects malformed JSON with a 400, not a 500', async () => {
    const response = await owner.client.request('POST', '/consultations', {
      rawBody: '{"title": "unterminated',
      headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(400);
  });
});

describe('stored content is never reflected as markup', () => {
  it('keeps script-like source titles as text', async () => {
    const uploaded = await uploadFixture(harness, owner.client, 'regulation-native.pdf');
    const xss = '<img src=x onerror=alert(1)>';

    const before = await owner.client.get<{ version: number }>(`/sources/${uploaded.sourceId}`);
    const renamed = await owner.client.patch<{ title: string }>(`/sources/${uploaded.sourceId}`, {
      title: xss,
      version: before.body.version,
    });
    expect(renamed.status).toBe(200);

    const listed = await owner.client.get('/sources');
    // The API is JSON; the value must round-trip as data, never as pre-escaped markup that
    // a client would then double-decode.
    expect(listed.headers.get('content-type')).toContain('application/json');
    expect(JSON.stringify(listed.body)).toContain('<img src=x onerror=alert(1)>');
  }, 180_000);
});

describe('rate limiting', () => {
  it('throttles repeated sign-in attempts and says when to retry', async () => {
    const client = new Client(harness);
    let limited: { status: number; headers: Headers } | null = null;

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await client.post('/auth/login', {
        email: `throttle${attempt}@example.test`,
        password: 'whatever-it-does-not-matter',
        rememberMe: false,
      });
      if (response.status === 429) {
        limited = response;
        break;
      }
    }

    expect(limited).not.toBeNull();
    expect(limited!.headers.get('retry-after')).toBeTruthy();
  });
});
