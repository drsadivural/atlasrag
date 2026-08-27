import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Client,
  addMember,
  createHarness,
  login,
  registerOwner,
  truncateAll,
  type Harness,
  type RegisteredAccount,
} from './harness.js';
import { uploadFixture } from './helpers.js';

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

describe('members and roles', () => {
  it('invites a member, who then has exactly their role’s permissions', async () => {
    const member = await addMember(harness, owner, 'read_only');

    const session = await member.client.get<{
      workspace: { role: string };
      permissions: string[];
    }>('/auth/session');

    expect(session.body.workspace.role).toBe('read_only');
    expect(session.body.permissions).toContain('source:read');
    expect(session.body.permissions).not.toContain('source:create');
    expect(session.body.permissions).not.toContain('consultation:create');
  }, 120_000);

  it('enforces the role in the repository, not just in the UI', async () => {
    const member = await addMember(harness, owner, 'read_only');

    // A read-only member has a valid session and knows the endpoint; the server still refuses.
    const upload = await member.client.post('/sources/uploads', {
      files: [{ fileName: 'x.pdf', sizeBytes: 100, contentType: 'application/pdf' }],
      tags: [],
      accessScope: 'workspace',
      promoteToKnowledge: true,
    });
    expect(upload.status).toBe(403);

    const consultation = await member.client.post('/consultations', {
      title: 'Not allowed',
      taskMode: 'ask',
      sourceIds: [],
    });
    expect(consultation.status).toBe(403);
  }, 120_000);

  it('lets a knowledge manager manage sources but not run reviews', async () => {
    const manager = await addMember(harness, owner, 'knowledge_manager');

    const uploaded = await uploadFixture(harness, manager.client, 'regulation-native.pdf');
    expect(uploaded.status).toBeLessThan(300);

    const consultation = await manager.client.post<{ id: string }>('/consultations', {
      title: 'Manager consultation',
      taskMode: 'check_compliance',
      sourceIds: [uploaded.sourceId],
    });

    const review = await manager.client.post(`/consultations/${consultation.body.id}/reviews`, {
      projectSourceIds: [uploaded.sourceId],
      governingSourceIds: [uploaded.sourceId],
      answerStyle: 'details',
      idempotencyKey: `km-${Date.now()}`,
    });
    expect(review.status).toBe(403);
  }, 300_000);

  it('refuses to let an admin promote anybody to owner', async () => {
    const admin = await addMember(harness, owner, 'admin');
    const target = await addMember(harness, owner, 'member');

    const escalate = await admin.client.patch(`/users/${target.userId}`, { role: 'owner' });
    expect(escalate.status).toBe(403);

    const promoteSelf = await admin.client.patch(`/users/${admin.userId}`, { role: 'owner' });
    expect(promoteSelf.status).toBe(403);
  }, 180_000);

  it('refuses to let a member change anyone’s role at all', async () => {
    const member = await addMember(harness, owner, 'member');
    const target = await addMember(harness, owner, 'read_only');

    const response = await member.client.patch(`/users/${target.userId}`, { role: 'admin' });
    expect(response.status).toBe(403);
  }, 180_000);

  it('ends the member’s sessions on a role change, so no session carries stale privileges', async () => {
    const member = await addMember(harness, owner, 'read_only');

    const before = await member.client.post('/consultations', {
      title: 'Before',
      taskMode: 'ask',
      sourceIds: [],
    });
    expect(before.status).toBe(403);

    const promoted = await owner.client.patch(`/users/${member.userId}`, { role: 'consultant' });
    expect(promoted.status).toBeLessThan(300);

    // The old session is gone rather than silently gaining new powers.
    expect((await member.client.get('/auth/session')).status).toBe(401);

    // Signing in again picks up the new role.
    const reconnected = new Client(harness);
    await login(reconnected, member.email, 'An0ther-Str0ng-Passphrase!');

    const session = await reconnected.get<{ workspace: { role: string } }>('/auth/session');
    expect(session.body.workspace.role).toBe('consultant');

    const after = await reconnected.post('/consultations', {
      title: 'After',
      taskMode: 'ask',
      sourceIds: [],
    });
    expect(after.status).toBeLessThan(300);
  }, 180_000);

  it('suspends a member and their session stops working', async () => {
    const member = await addMember(harness, owner, 'consultant');
    expect((await member.client.get('/sources')).status).toBe(200);

    const suspended = await owner.client.patch(`/users/${member.userId}`, { status: 'suspended' });
    expect(suspended.status).toBeLessThan(300);

    const after = await member.client.get('/sources');
    expect([401, 403]).toContain(after.status);
  }, 180_000);
});

describe('workspace settings', () => {
  it('returns the defaults a new workspace starts with', async () => {
    const response = await owner.client.get<{
      settings: {
        general: { workspaceName: string };
        consultant: { name: string; defaultAnswerStyle: string };
        answers: { knowledgeOnly: boolean; requireCitations: boolean };
        security: { mfaPolicy: string };
        retention: { auditDays: number };
      };
      models: unknown[];
    }>('/settings');

    expect(response.status).toBe(200);
    expect(response.body.settings.consultant.name).toBe('Ayumi');
    expect(response.body.settings.consultant.defaultAnswerStyle).toBeTruthy();
    expect(response.body.settings.security.mfaPolicy).toBeTruthy();
    expect(response.body.settings.retention.auditDays).toBeGreaterThan(0);
  });

  it('persists a change and reads it back', async () => {
    const updated = await owner.client.patch('/settings', {
      general: { workspaceName: 'Renamed workspace' },
    });
    expect(updated.status).toBeLessThan(300);

    const settings = await owner.client.get<{ settings: { general: { workspaceName: string } } }>(
      '/settings',
    );
    expect(settings.body.settings.general.workspaceName).toBe('Renamed workspace');
  });

  it('keeps general-knowledge fallback off by default', async () => {
    const response = await owner.client.get<{
      settings: {
        answers: {
          generalModelFallback: boolean;
          knowledgeOnly: boolean;
          requireCitations: boolean;
        };
      };
    }>('/settings');

    // The brief requires grounding by default; a fallback must be a deliberate act.
    expect(response.body.settings.answers.generalModelFallback).toBe(false);
    expect(response.body.settings.answers.knowledgeOnly).toBe(true);
    expect(response.body.settings.answers.requireCitations).toBe(true);
  });

  it('refuses a settings change from someone without the permission', async () => {
    const member = await addMember(harness, owner, 'member');
    const response = await member.client.patch('/settings', {
      general: { workspaceName: 'Hijacked' },
    });
    expect(response.status).toBe(403);

    const settings = await owner.client.get<{ settings: { general: { workspaceName: string } } }>(
      '/settings',
    );
    expect(settings.body.settings.general.workspaceName).not.toBe('Hijacked');
  }, 120_000);

  it('carries a saved key across to another model from the same provider', async () => {
    /*
     * Configurations are keyed by model, so picking a different one from the loaded list
     * makes a new row. Asking for the same account key again is how somebody ends up with
     * a working provider replaced by an unconfigured one.
     */
    const first = await owner.client.post('/settings/models', {
      provider: 'openai',
      capability: 'chat',
      model: 'gpt-5.6-terra',
      apiKey: 'sk-test-not-a-real-key-111111111111',
    });
    expect(first.status).toBeLessThan(300);

    const second = await owner.client.post<{
      model: string;
      hasCredential: boolean;
      reasoningEffort: string | null;
    }>('/settings/models', {
      provider: 'openai',
      capability: 'chat',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
    });

    expect(second.status).toBeLessThan(300);
    expect(second.body.model).toBe('gpt-5.6-sol');
    expect(second.body.hasCredential).toBe(true);
    expect(second.body.reasoningEffort).toBe('high');

    // Inheriting the key must not mean returning it.
    const settings = await owner.client.get('/settings');
    expect(JSON.stringify(settings.body)).not.toContain('sk-test-not-a-real-key-111111111111');
  });

  it('refuses a reasoning effort the provider does not offer', async () => {
    const response = await owner.client.post('/settings/models', {
      provider: 'openai',
      capability: 'chat',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'extreme',
      apiKey: 'sk-test-not-a-real-key-222222222222',
    });
    // The levels are the provider's, checked at the contract rather than accepted and
    // discovered to be wrong on the first question somebody asks.
    expect(response.status).toBe(400);
  });

  it('stores no reasoning effort against a provider that has none', async () => {
    const response = await owner.client.post<{ reasoningEffort: string | null }>(
      '/settings/models',
      {
        provider: 'anthropic',
        capability: 'chat',
        model: 'claude-sonnet-5',
        reasoningEffort: 'high',
        apiKey: 'sk-test-not-a-real-key-333333333333',
      },
    );
    expect(response.status).toBeLessThan(300);
    expect(response.body.reasoningEffort).toBeNull();
  });

  it('names a saved key by its last four characters and nothing more', async () => {
    const saved = await owner.client.post<{ id: string; credentialLast4: string | null }>(
      '/settings/models',
      {
        provider: 'openai',
        capability: 'chat',
        model: 'gpt-5.6-terra',
        apiKey: 'sk-test-not-a-real-key-abcd1234',
      },
    );
    expect(saved.status).toBeLessThan(300);
    // Enough for its owner to recognise which key is stored; useless to anybody else.
    expect(saved.body.credentialLast4).toBe('1234');

    const settings = await owner.client.get('/settings');
    const body = JSON.stringify(settings.body);
    expect(body).not.toContain('sk-test-not-a-real-key-abcd1234');
  });

  it('removes a configuration and its key on request', async () => {
    const saved = await owner.client.post<{ id: string }>('/settings/models', {
      provider: 'anthropic',
      capability: 'rerank',
      model: 'claude-rerank-test',
      apiKey: 'sk-test-not-a-real-key-444444444444',
    });
    expect(saved.status).toBeLessThan(300);

    const removed = await owner.client.request('DELETE', `/settings/models/${saved.body.id}`);
    expect(removed.status).toBe(204);

    const settings = await owner.client.get<{ models: Array<{ id: string }> }>('/settings');
    expect(settings.body.models.some((m) => m.id === saved.body.id)).toBe(false);

    // Gone means gone: a second delete has nothing to find.
    const again = await owner.client.request('DELETE', `/settings/models/${saved.body.id}`);
    expect(again.status).toBe(404);
  });

  it('refuses to let a member remove a provider', async () => {
    const saved = await owner.client.post<{ id: string }>('/settings/models', {
      provider: 'anthropic',
      capability: 'ocr',
      model: 'claude-ocr-test',
      apiKey: 'sk-test-not-a-real-key-555555555555',
    });
    const member = await addMember(harness, owner, 'member');

    const attempt = await member.client.request('DELETE', `/settings/models/${saved.body.id}`);
    expect(attempt.status).toBe(403);

    const settings = await owner.client.get<{ models: Array<{ id: string }> }>('/settings');
    expect(settings.body.models.some((m) => m.id === saved.body.id)).toBe(true);
  }, 120_000);

  it('never returns a stored provider key, even to an owner', async () => {
    const configured = await owner.client.post('/settings/models', {
      provider: 'anthropic',
      capability: 'chat',
      model: 'claude-sonnet-5',
      apiKey: 'sk-test-not-a-real-key-000000000000',
      makeDefault: false,
    });

    if (configured.status < 300) {
      const settings = await owner.client.get('/settings');
      const body = JSON.stringify(settings.body);
      expect(body).not.toContain('sk-test-not-a-real-key-000000000000');
      expect(body).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    }
  });
});

describe('activity log', () => {
  it('records an append-only trail that even an owner cannot rewrite', async () => {
    await uploadFixture(harness, owner.client, 'regulation-native.pdf', { wait: false });

    const audit = await owner.client.get<{ items: Array<{ id: string; action: string }> }>(
      '/audit-events?pageSize=50',
    );
    expect(audit.body.items.length).toBeGreaterThan(0);

    // The API exposes no mutation at all, and the database refuses one directly.
    const target = audit.body.items[0]!;
    await expect(
      harness.db.execute(`UPDATE audit_events SET action = 'tampered' WHERE id = '${target.id}'`),
    ).rejects.toThrow();
  }, 120_000);

  it('exports the log as CSV for an auditor', async () => {
    await uploadFixture(harness, owner.client, 'regulation-native.pdf', { wait: false });

    const response = await owner.client.get('/audit-events/export');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('csv');

    const text = await response.raw.clone().text();
    expect(text.split('\n')[0]!.toLowerCase()).toMatch(/action/);
  }, 120_000);

  it('does not expose the export to somebody without the permission', async () => {
    const member = await addMember(harness, owner, 'member');
    expect((await member.client.get('/audit-events/export')).status).toBe(403);
  }, 120_000);
});

describe('dashboard', () => {
  it('reports figures derived from real rows, not placeholders', async () => {
    const dashboard = await owner.client.get<{
      kpis: Array<{ key: string; value: number; unit: string }>;
      recentConsultations: unknown[];
    }>('/dashboard?days=30');

    expect(dashboard.status).toBe(200);
    expect(dashboard.body.kpis.length).toBeGreaterThan(0);
    // A brand-new workspace has done nothing, and the dashboard must say so honestly.
    for (const kpi of dashboard.body.kpis) {
      expect(Number.isFinite(kpi.value)).toBe(true);
      if (kpi.key === 'consultations') expect(kpi.value).toBe(0);
    }
    expect(dashboard.body.recentConsultations).toHaveLength(0);
  });
});

/**
 * Asking a provider which models it will serve.
 *
 * The endpoint that stops anybody typing a model identifier that does not exist. It fails
 * closed like every other provider in this application: no key, no list, and a message
 * naming the variable rather than a silent empty dropdown.
 */
describe('available models', () => {
  it('refuses to ask when no key is stored, and says which variable is missing', async () => {
    const response = await owner.client.post<{ error: { code: string; message: string } }>(
      '/settings/models/available',
      { provider: 'openai', capability: 'chat' },
    );

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('provider_unconfigured');
    expect(response.body.error.message).toContain('OPENAI_API_KEY');
  });

  it('names the Anthropic variable when Anthropic is asked for', async () => {
    const response = await owner.client.post<{ error: { message: string } }>(
      '/settings/models/available',
      { provider: 'anthropic', capability: 'chat' },
    );
    expect(response.body.error.message).toContain('ANTHROPIC_API_KEY');
  });

  it('rejects a provider this application cannot talk to', async () => {
    const response = await owner.client.post('/settings/models/available', {
      provider: 'deterministic',
      capability: 'chat',
    });
    // The deterministic engine has no catalogue to read; asking for one is a malformed
    // request rather than an empty answer.
    expect(response.status).toBe(400);
  });

  it('requires permission to configure models', async () => {
    const member = await addMember(harness, owner, 'member');
    const response = await member.client.post('/settings/models/available', {
      provider: 'openai',
      capability: 'chat',
    });
    expect(response.status).toBe(403);
  });
});
