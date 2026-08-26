import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateTotp } from '@uxe/auth';
import {
  Client,
  createHarness,
  login,
  registerOwner,
  truncateAll,
  verifyEmail,
  type Harness,
} from './harness.js';

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

const PASSWORD = 'Tr0ubad0ur-Nimbus-42!';

async function register(client: Client, email: string, overrides: Record<string, unknown> = {}) {
  return client.post('/auth/register', {
    email,
    password: PASSWORD,
    fullName: 'Ayumi Tester',
    organizationName: 'Marina Consulting',
    locale: 'en',
    acceptedTerms: true,
    ...overrides,
  });
}

describe('registration', () => {
  it('creates an organization, a workspace and an owner', async () => {
    const client = new Client(harness);
    const response = await register(client, 'founder@example.test');
    expect(response.status).toBe(201);

    await login(client, 'founder@example.test', PASSWORD);

    const session = await client.get<{
      user: { email: string; emailVerified: boolean };
      workspace: { role: string };
      permissions: string[];
    }>('/auth/session');

    expect(session.body.user.email).toBe('founder@example.test');
    expect(session.body.user.emailVerified).toBe(true);
    expect(session.body.workspace.role).toBe('owner');
    expect(session.body.permissions).toContain('workspace:delete');
  });

  it('rejects a weak password with a field-level message', async () => {
    const client = new Client(harness);
    const response = await register(client, 'weak@example.test', { password: 'password' });
    expect(response.status).toBe(400);
    const body = response.body as { error: { fieldErrors: Record<string, string[]> } };
    expect(Object.keys(body.error.fieldErrors)).toContain('password');
  });

  it('rejects an invalid email and an unaccepted agreement', async () => {
    const client = new Client(harness);
    expect((await register(client, 'not-an-email')).status).toBe(400);

    const noTerms = await register(client, 'terms@example.test', { acceptedTerms: false });
    expect(noTerms.status).toBe(400);
  });

  it('does not reveal that an address is already registered', async () => {
    const first = new Client(harness);
    await register(first, 'taken@example.test');

    const second = new Client(harness);
    const fresh = new Client(harness);
    const newAddress = await register(fresh, 'brand-new@example.test');
    const response = await register(second, 'taken@example.test');

    // Same status and the same body shape as a first-time registration: either difference
    // would let an attacker enumerate which addresses hold accounts.
    expect(response.status).toBe(newAddress.status);
    expect(Object.keys(response.body as object)).toEqual(Object.keys(newAddress.body as object));
    expect((response.body as { status: string }).status).toBe(
      (newAddress.body as { status: string }).status,
    );
  });

  it('lets a new account sign in immediately when confirmation is not required', async () => {
    const client = new Client(harness);
    const created = await register(client, 'straight-in@example.test');
    expect((created.body as { status: string }).status).toBe('registered');

    const response = await client.post<{ status: string }>('/auth/login', {
      email: 'straight-in@example.test',
      password: PASSWORD,
      rememberMe: false,
    });
    expect(response.body.status).toBe('authenticated');
  });

  it('still hides whether the address was taken when confirmation is not required', async () => {
    const client = new Client(harness);
    const first = await register(client, 'twice@example.test');
    const second = await register(client, 'twice@example.test');

    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
  });

  describe('with confirmation required', () => {
    let gated: Harness;

    beforeAll(async () => {
      gated = await createHarness({ REQUIRE_EMAIL_VERIFICATION: 'true' });
    });
    afterAll(async () => {
      await gated.close();
    });

    it('sends a verification email and refuses to sign in until it is used', async () => {
      const client = new Client(gated);
      const created = await register(client, 'unverified@example.test');
      expect((created.body as { status: string }).status).toBe('email_verification_required');

      const message = gated.email.messagesFor('unverified@example.test').at(-1);
      expect(message).toBeDefined();
      expect(message!.tag).toContain('verify');

      const response = await client.post<{ status: string }>('/auth/login', {
        email: 'unverified@example.test',
        password: PASSWORD,
        rememberMe: false,
      });
      expect(response.body.status).toBe('email_verification_required');

      // And the link in that email is what opens the account.
      await verifyEmail(gated, client, 'unverified@example.test');
      await login(client, 'unverified@example.test', PASSWORD);
      const session = await client.get<{ user: { emailVerified: boolean } }>('/auth/session');
      expect(session.body.user.emailVerified).toBe(true);
    });
  });
});

describe('sign-in', () => {
  it('rejects a wrong password with the same message as an unknown account', async () => {
    const account = await registerOwner(harness);
    const client = new Client(harness);

    const wrongPassword = await client.post('/auth/login', {
      email: account.email,
      password: 'not-the-password',
      rememberMe: false,
    });
    const unknownAccount = await client.post('/auth/login', {
      email: 'nobody@example.test',
      password: 'not-the-password',
      rememberMe: false,
    });

    expect(wrongPassword.status).toBe(401);
    expect(unknownAccount.status).toBe(401);
    expect((wrongPassword.body as { error: { message: string } }).error.message).toBe(
      (unknownAccount.body as { error: { message: string } }).error.message,
    );
  });

  it('sets an HttpOnly, SameSite session cookie', async () => {
    const account = await registerOwner(harness);
    const fresh = new Client(harness);
    const response = await fresh.post('/auth/login', {
      email: account.email,
      password: account.password,
      rememberMe: false,
    });

    const cookies = response.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith('uxe_session='));
    expect(session).toBeDefined();
    expect(session).toContain('HttpOnly');
    expect(session).toContain('SameSite=Lax');
    expect(session).toContain('Path=/');
  });

  it('locks the account after repeated failures and says when to try again', async () => {
    const account = await registerOwner(harness);
    const client = new Client(harness);

    let locked: { status: number; body: unknown } | null = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await client.post('/auth/login', {
        email: account.email,
        password: `wrong-${attempt}`,
        rememberMe: false,
      });
      if (response.status === 423 || response.status === 429) {
        locked = response;
        break;
      }
    }

    expect(locked).not.toBeNull();
    expect(JSON.stringify(locked!.body)).toMatch(/try again|locked|too many/i);

    // The correct password must not open a locked account either.
    const correct = await client.post('/auth/login', {
      email: account.email,
      password: account.password,
      rememberMe: false,
    });
    expect(correct.status).not.toBe(200);
  });
});

describe('session and CSRF', () => {
  it('returns an unauthenticated session rather than an error when signed out', async () => {
    const client = new Client(harness);
    const response = await client.get('/auth/session');
    expect(response.status).toBe(401);
  });

  it('refuses a state-changing request with no CSRF token', async () => {
    const account = await registerOwner(harness);
    const response = await account.client.post(
      '/consultations',
      { title: 'No token', taskMode: 'ask', sourceIds: [] },
      { omitCsrf: true },
    );
    expect(response.status).toBe(403);
    expect((response.body as { error: { code: string } }).error.code).toBe('csrf_failed');
  });

  it('refuses a forged CSRF token', async () => {
    const account = await registerOwner(harness);
    const response = await account.client.post(
      '/consultations',
      { title: 'Forged', taskMode: 'ask', sourceIds: [] },
      { headers: { 'x-csrf-token': 'forged-token-value' } },
    );
    expect(response.status).toBe(403);
  });

  it('refuses a request from a foreign origin', async () => {
    const account = await registerOwner(harness);
    const response = await account.client.post(
      '/consultations',
      { title: 'Cross origin', taskMode: 'ask', sourceIds: [] },
      { origin: 'https://evil.example.com' },
    );
    expect(response.status).toBe(403);
  });

  it('ends the session on sign-out, and the cookie stops working', async () => {
    const account = await registerOwner(harness);
    const before = await account.client.get('/auth/session');
    expect(before.status).toBe(200);

    const out = await account.client.post('/auth/logout');
    expect(out.status).toBeLessThan(300);

    const after = await account.client.get('/auth/session');
    expect(after.status).toBe(401);
  });

  it('lists device sessions and can revoke one', async () => {
    const account = await registerOwner(harness);

    const second = new Client(harness);
    await login(second, account.email, account.password);

    const sessions =
      await account.client.get<Array<{ id: string; current: boolean }>>('/auth/sessions');
    expect(sessions.body.length).toBeGreaterThanOrEqual(2);

    const other = sessions.body.find((s) => !s.current);
    expect(other).toBeDefined();

    const revoked = await account.client.delete(`/auth/sessions/${other!.id}`);
    expect(revoked.status).toBeLessThan(300);

    // The revoked session is genuinely dead, not merely hidden from the list.
    expect((await second.get('/auth/session')).status).toBe(401);
  });
});

describe('password reset', () => {
  it('always answers the same way, whether or not the address exists', async () => {
    const account = await registerOwner(harness);
    const client = new Client(harness);

    const known = await client.post('/auth/forgot-password', { email: account.email });
    const unknown = await client.post('/auth/forgot-password', { email: 'ghost@example.test' });

    expect(known.status).toBe(unknown.status);
    expect(JSON.stringify(known.body)).toBe(JSON.stringify(unknown.body));
  });

  it('resets the password with the emailed token and invalidates every existing session', async () => {
    const account = await registerOwner(harness);
    const client = new Client(harness);
    await client.post('/auth/forgot-password', { email: account.email });

    const message = harness.email.messagesFor(account.email).at(-1)!;
    const token = /token=([A-Za-z0-9_-]+)/.exec(`${message.text} ${message.html}`)![1]!;

    const newPassword = 'Compl3tely-Different-Phrase!';
    const reset = await client.post('/auth/reset-password', { token, password: newPassword });
    expect(reset.status).toBeLessThan(300);

    // A stolen session must not survive a password reset.
    expect((await account.client.get('/auth/session')).status).toBe(401);

    const fresh = new Client(harness);
    await login(fresh, account.email, newPassword);
    expect((await fresh.get('/auth/session')).status).toBe(200);
  });

  it('refuses to reuse a reset token', async () => {
    const account = await registerOwner(harness);
    const client = new Client(harness);
    await client.post('/auth/forgot-password', { email: account.email });

    const message = harness.email.messagesFor(account.email).at(-1)!;
    const token = /token=([A-Za-z0-9_-]+)/.exec(`${message.text} ${message.html}`)![1]!;

    expect(
      (await client.post('/auth/reset-password', { token, password: 'F1rst-Reset-Value!' })).status,
    ).toBeLessThan(300);
    const second = await client.post('/auth/reset-password', {
      token,
      password: 'Sec0nd-Reset-Value!',
    });
    expect(second.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses a reset token that was never issued', async () => {
    const client = new Client(harness);
    const response = await client.post('/auth/reset-password', {
      token: 'a'.repeat(43),
      password: 'Some-Valid-Passphrase-9!',
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe('multi-factor authentication', () => {
  it('enrols a factor, requires the code at the next sign-in, and rejects a wrong code', async () => {
    const account = await registerOwner(harness);

    const enrol = await account.client.post<{
      factorId: string;
      secret: string;
      otpauthUrl: string;
    }>('/auth/mfa/enroll');
    expect(enrol.status).toBe(200);
    expect(enrol.body.otpauthUrl).toContain('otpauth://totp/');

    const activate = await account.client.post<{ recoveryCodes: string[] }>('/auth/mfa/activate', {
      factorId: enrol.body.factorId,
      code: await generateTotp(enrol.body.secret),
    });
    expect(activate.status).toBe(200);
    expect(activate.body.recoveryCodes.length).toBeGreaterThan(0);

    const fresh = new Client(harness);
    const challenge = await fresh.post<{
      status: string;
      challengeId: string;
      challengeToken: string;
      methods: string[];
    }>('/auth/login', { email: account.email, password: account.password, rememberMe: false });
    expect(challenge.body.status).toBe('mfa_required');
    expect(challenge.body.methods).toContain('totp');

    // Not signed in yet: the challenge alone must not grant a session.
    expect((await fresh.get('/auth/session')).status).toBe(401);

    const wrong = await fresh.post('/auth/mfa/verify', {
      challengeId: challenge.body.challengeId,
      challengeToken: challenge.body.challengeToken,
      code: '000000',
      trustDevice: false,
    });
    expect(wrong.status).toBeGreaterThanOrEqual(400);

    const verified = await fresh.post('/auth/mfa/verify', {
      challengeId: challenge.body.challengeId,
      challengeToken: challenge.body.challengeToken,
      code: await generateTotp(enrol.body.secret),
      trustDevice: false,
    });
    expect(verified.status).toBe(200);
    expect((await fresh.get('/auth/session')).status).toBe(200);
  });

  it('accepts a recovery code once and not twice', async () => {
    const account = await registerOwner(harness);
    const enrol = await account.client.post<{ factorId: string; secret: string }>(
      '/auth/mfa/enroll',
    );
    const activate = await account.client.post<{ recoveryCodes: string[] }>('/auth/mfa/activate', {
      factorId: enrol.body.factorId,
      code: await generateTotp(enrol.body.secret),
    });
    const recovery = activate.body.recoveryCodes[0]!;

    const fresh = new Client(harness);
    const challenge = await fresh.post<{ challengeId: string; challengeToken: string }>(
      '/auth/login',
      {
        email: account.email,
        password: account.password,
        rememberMe: false,
      },
    );

    const used = await fresh.post('/auth/mfa/verify', {
      challengeId: challenge.body.challengeId,
      challengeToken: challenge.body.challengeToken,
      code: recovery,
      trustDevice: false,
    });
    expect(used.status).toBe(200);

    const again = new Client(harness);
    const secondChallenge = await again.post<{ challengeId: string; challengeToken: string }>(
      '/auth/login',
      { email: account.email, password: account.password, rememberMe: false },
    );
    const reused = await again.post('/auth/mfa/verify', {
      challengeId: secondChallenge.body.challengeId,
      challengeToken: secondChallenge.body.challengeToken,
      code: recovery,
      trustDevice: false,
    });
    expect(reused.status).toBeGreaterThanOrEqual(400);
  });
});
