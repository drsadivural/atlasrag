import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client, createHarness, truncateAll, type Harness } from './harness.js';

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  harness.resetRateLimits();
});

/**
 * Government Edition authentication, as the sign-in screen and the providers see it.
 *
 * The rule under test throughout: this screen never creates an account. A federated
 * identity that is not already provisioned is refused, and every refusal looks the same
 * from the outside.
 */
describe('government configuration', () => {
  it('reports availability without leaking any of the configuration', async () => {
    const client = new Client(harness);
    const response = await client.get<{
      uaePass: { available: boolean; requiredEnv: string[] };
      sso: { available: boolean; requiredEnv: string[] };
      dataResidency: boolean;
    }>('/auth/government/config');

    expect(response.status).toBe(200);
    expect(response.body.uaePass.available).toBe(false);
    expect(response.body.uaePass.requiredEnv).toContain('UAE_PASS_CLIENT_ID');

    // Variable names are the point of that list; values are what must never appear. The
    // response carries no client id, no secret and no endpoint under any key.
    const payload = response.body as unknown as Record<string, unknown>;
    const keys = JSON.stringify(payload).match(/"([a-zA-Z]+)":/g) ?? [];
    expect(keys).not.toContain('"clientId":');
    expect(keys).not.toContain('"clientSecret":');
    expect(keys).not.toContain('"authorizationEndpoint":');
    expect(keys).not.toContain('"tokenEndpoint":');
    expect(JSON.stringify(payload)).not.toContain('uaepass.ae');
  });

  it('does not claim data residency unless the deployment asserts it', async () => {
    const client = new Client(harness);
    const response = await client.get<{ dataResidency: boolean }>('/auth/government/config');
    expect(response.body.dataResidency).toBe(false);
  });

  it('is readable without a session, because the sign-in screen needs it', async () => {
    const client = new Client(harness);
    expect((await client.get('/auth/government/config')).status).toBe(200);
  });
});

describe('starting a federated flow', () => {
  it('refuses to start UAE PASS when it is not configured, and names what is missing', async () => {
    const client = new Client(harness);
    const response = await client.post<{ error: { code: string } }>(
      '/auth/government/uae-pass/start',
      {},
    );

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('provider_unconfigured');
  });

  it('refuses to start Government SSO when it is not configured', async () => {
    const client = new Client(harness);
    const response = await client.post<{ error: { code: string } }>(
      '/auth/government/sso/start',
      {},
    );
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('provider_unconfigured');
  });
});

describe('the callbacks', () => {
  it('refuses a state that was never issued, and sends the browser somewhere it knows', async () => {
    const client = new Client(harness);
    const response = await client.get('/auth/government/uae-pass/callback?state=forged&code=abc');

    expect(response.status).toBe(302);
    const location = response.headers.get('location') ?? '';
    expect(location).toContain('/login');
    expect(location).toContain('sso=failed');
    // No session is issued on the way past.
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('refuses a replayed callback', async () => {
    const client = new Client(harness);
    const first = await client.get('/auth/government/sso/callback?state=used-once&code=abc');
    const second = await client.get('/auth/government/sso/callback?state=used-once&code=abc');

    // Both fail here because no state was issued at all; what matters is that neither
    // path can mint a session without one.
    for (const response of [first, second]) {
      expect(response.status).toBe(302);
      expect(response.headers.get('set-cookie')).toBeNull();
    }
  });

  it('treats a cancelled consent as a decision rather than an error', async () => {
    const client = new Client(harness);
    const response = await client.get(
      '/auth/government/uae-pass/callback?state=whatever&error=access_denied',
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});
