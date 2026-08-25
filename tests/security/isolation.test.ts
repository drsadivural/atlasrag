import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Client,
  createHarness,
  registerOwner,
  truncateAll,
  type Harness,
  type RegisteredAccount,
} from '../integration/harness.js';
import { uploadFixture } from '../integration/helpers.js';

/**
 * Cross-tenant isolation.
 *
 * Every case is written from the attacker's side: tenant B holds a valid session and knows
 * tenant A's identifiers. Nothing here relies on the UI hiding a button.
 */

let harness: Harness;
let alice: RegisteredAccount;
let bob: RegisteredAccount;
let aliceSourceId: string;
let aliceConsultationId: string;

beforeAll(async () => {
  harness = await createHarness();
}, 120_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  harness.resetRateLimits();

  alice = await registerOwner(harness, { organizationName: 'Alice Consulting' });
  bob = await registerOwner(harness, { organizationName: 'Bob Advisory' });

  const uploaded = await uploadFixture(harness, alice.client, 'regulation-native.pdf', {
    title: 'Alice private regulation',
  });
  aliceSourceId = uploaded.sourceId;

  const consultation = await alice.client.post<{ id: string }>('/consultations', {
    title: 'Alice private consultation',
    taskMode: 'ask',
    sourceIds: [aliceSourceId],
  });
  aliceConsultationId = consultation.body.id;
}, 300_000);

describe('reading another tenant’s data', () => {
  it('does not leak a source by direct identifier', async () => {
    const response = await bob.client.get(`/sources/${aliceSourceId}`);
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain('Alice private regulation');
  });

  it('does not leak a source through the list endpoint', async () => {
    const response = await bob.client.get<{ items: Array<{ id: string }> }>('/sources');
    expect(response.body.items.map((s) => s.id)).not.toContain(aliceSourceId);
    expect(response.body.items).toHaveLength(0);
  });

  it('does not leak a source through search, which takes a different query path', async () => {
    const response = await bob.client.get<{ items: Array<{ id: string }> }>(
      '/sources?q=regulation',
    );
    expect(response.body.items).toHaveLength(0);
  });

  it('does not leak version history', async () => {
    const response = await bob.client.get(`/sources/${aliceSourceId}/versions`);
    expect(response.status).toBe(404);
  });

  it('does not leak a consultation or its messages', async () => {
    const response = await bob.client.get(`/consultations/${aliceConsultationId}`);
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain('Alice private consultation');
  });

  it('returns 404 rather than 403, so identifiers cannot be probed for existence', async () => {
    const real = await bob.client.get(`/sources/${aliceSourceId}`);
    const invented = await bob.client.get('/sources/01JQZZZZZZZZZZZZZZZZZZZZZZ');
    expect(real.status).toBe(invented.status);
  });
});

describe('writing to another tenant’s data', () => {
  it('cannot rename a source', async () => {
    // A complete, well-formed request: the refusal must come from tenancy, not validation.
    const response = await bob.client.patch(`/sources/${aliceSourceId}`, {
      title: 'Owned',
      version: 0,
    });
    expect(response.status).toBe(404);

    const stillMine = await alice.client.get<{ title: string }>(`/sources/${aliceSourceId}`);
    expect(stillMine.body.title).toBe('Alice private regulation');
  });

  it('cannot delete a source', async () => {
    expect((await bob.client.delete(`/sources/${aliceSourceId}`)).status).toBe(404);
    expect((await alice.client.get(`/sources/${aliceSourceId}`)).status).toBe(200);
  });

  it('cannot reprocess a source, which would consume the victim’s quota', async () => {
    expect((await bob.client.post(`/sources/${aliceSourceId}/reprocess`)).status).toBe(404);
  });

  it('cannot bulk-act on identifiers it does not own', async () => {
    const response = await bob.client.post('/sources/bulk', {
      action: 'archive',
      sourceIds: [aliceSourceId],
    });
    // Either refused outright, or accepted while touching nothing.
    const source = await alice.client.get<{ status: string }>(`/sources/${aliceSourceId}`);
    expect(source.body.status).toBe('ready');
    expect([200, 207, 400, 403, 404]).toContain(response.status);
  });

  it('cannot post a message into another tenant’s consultation', async () => {
    const response = await bob.client.post(`/consultations/${aliceConsultationId}/messages`, {
      text: 'Whose consultation is this?',
      taskMode: 'ask',
      answerStyle: 'optimal',
      attachmentIds: [],
      parentMessageId: null,
      idempotencyKey: `attack-${Date.now()}`,
    });
    expect(response.status).toBe(404);
  });

  it('cannot attach another tenant’s source to its own consultation', async () => {
    const mine = await bob.client.post<{ id: string }>('/consultations', {
      title: 'Bob consultation',
      taskMode: 'ask',
      sourceIds: [],
    });

    const response = await bob.client.patch(`/consultations/${mine.body.id}`, {
      sourceIds: [aliceSourceId],
    });

    if (response.status < 300) {
      const detail = await bob.client.get<{ sources: Array<{ sourceId: string }> }>(
        `/consultations/${mine.body.id}`,
      );
      // Accepting the request is tolerable; silently attaching the document is not.
      expect(detail.body.sources.map((s) => s.sourceId)).not.toContain(aliceSourceId);
    } else {
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
  });
});

describe('retrieval', () => {
  it('never retrieves another tenant’s passages, even when the question matches them exactly', async () => {
    const mine = await bob.client.post<{ id: string }>('/consultations', {
      title: 'Bob probing consultation',
      taskMode: 'ask',
      sourceIds: [],
    });

    const posted = await bob.client.post<{ job: { id: string } }>(
      `/consultations/${mine.body.id}/messages`,
      {
        text: 'What illuminance does emergency lighting require, and what is the maximum travel distance?',
        taskMode: 'ask',
        answerStyle: 'details',
        attachmentIds: [],
        parentMessageId: null,
        idempotencyKey: `leak-${Date.now()}`,
      },
    );

    const deadline = Date.now() + 90_000;
    let status = 'queued';
    while (Date.now() < deadline && !['succeeded', 'failed'].includes(status)) {
      const job = await bob.client.get<{ status: string }>(`/jobs/${posted.body.job.id}`);
      status = job.body.status;
      if (['succeeded', 'failed'].includes(status)) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const detail = await bob.client.get<{
      messages: Array<{
        answer: { citations: Array<{ sourceId: string; supportingExcerpt: string }> } | null;
      }>;
    }>(`/consultations/${mine.body.id}`);
    const answer = detail.body.messages
      .map((m) => m.answer)
      .filter(Boolean)
      .at(-1);

    // Zero cross-tenant leakage is the acceptance threshold, not a low rate.
    for (const citation of answer?.citations ?? []) {
      expect(citation.sourceId).not.toBe(aliceSourceId);
    }
    const text = JSON.stringify(answer ?? {});
    expect(text).not.toMatch(/10 lux/);
    expect(text).not.toMatch(/Alice private regulation/);
  }, 180_000);
});

describe('artifacts and jobs', () => {
  it('does not expose another tenant’s job, which would leak progress and file names', async () => {
    const uploaded = await uploadFixture(harness, alice.client, 'policy.docx', { wait: true });
    const response = await bob.client.get(`/jobs/${uploaded.jobId}`);
    expect(response.status).toBe(404);
  }, 180_000);

  it('does not list another tenant’s activity', async () => {
    const response = await bob.client.get<{ items: Array<{ targetLabel: string | null }> }>(
      '/audit-events?pageSize=50',
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const labels = response.body.items.map((event) => event.targetLabel ?? '').join(' ');
    expect(labels).not.toContain('Alice private regulation');
    expect(labels).not.toContain(alice.email);
  });

  it('does not list another tenant’s members', async () => {
    const response = await bob.client.get<Array<{ email: string }>>('/users');
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.map((u) => u.email)).not.toContain(alice.email);
    // Bob sees exactly one member: himself.
    expect(response.body).toHaveLength(1);
  });

  it('does not return another tenant’s settings', async () => {
    const response = await bob.client.get<{ settings: { general: { workspaceName: string } } }>(
      '/settings',
    );
    expect(response.body.settings.general.workspaceName).not.toBe('Alice Consulting');
  });
});

describe('claimed identity', () => {
  it('ignores a client-supplied workspace header and uses the session’s workspace', async () => {
    const response = await bob.client.get<{ items: Array<{ id: string }> }>('/sources', {
      headers: {
        'x-workspace-id': alice.workspaceId,
        'x-organization-id': alice.organizationId,
        'x-tenant-id': alice.workspaceId,
      },
    });
    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(0);
  });

  it('refuses to switch into a workspace the user is not a member of', async () => {
    const response = await bob.client.post('/auth/switch-workspace', {
      workspaceId: alice.workspaceId,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);

    const session = await bob.client.get<{ workspace: { id: string } }>('/auth/session');
    expect(session.body.workspace.id).toBe(bob.workspaceId);
  });

  it('rejects a forged session cookie', async () => {
    const forged = new Client(harness);
    forged.setCookie('uxe_session', 'a'.repeat(43));
    expect((await forged.get('/sources')).status).toBe(401);
  });

  it('rejects another user’s session cookie value once that session is revoked', async () => {
    await alice.client.post('/auth/logout');
    expect((await alice.client.get('/sources')).status).toBe(401);
  });
});
