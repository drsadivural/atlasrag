import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Client,
  createHarness,
  login,
  registerOwner,
  truncateAll,
  type Harness,
  type RegisteredAccount,
} from './harness.js';

let harness: Harness;
let admin: RegisteredAccount;
let other: RegisteredAccount;

/**
 * Platform administration.
 *
 * The authority that crosses workspaces, which is why most of what is asserted here is
 * what it does *not* reach. Administering accounts and reading what those accounts hold
 * are different things, and the second must not come free with the first.
 */
beforeAll(async () => {
  harness = await createHarness();
  await truncateAll(harness.db);
  harness.resetRateLimits();

  admin = await registerOwner(harness);
  other = await registerOwner(harness);

  await harness.db.execute(
    `UPDATE users SET is_platform_admin = true WHERE id = '${admin.userId}'`,
  );
  // The flag is read when the session is resolved, so the existing one predates it. Signing
  // in again also re-reads the CSRF token, which the new session issues afresh.
  await admin.client.post('/auth/logout');
  await login(admin.client, admin.email, admin.password);
}, 180_000);

afterAll(async () => {
  await harness.close();
});

describe('who may use it', () => {
  it('refuses everybody who does not hold the flag', async () => {
    const attempt = await other.client.get('/platform/users');
    expect(attempt.status).toBe(403);
  });

  it('refuses an anonymous caller outright', async () => {
    const anonymous = new Client(harness);
    const attempt = await anonymous.get('/platform/users');
    expect(attempt.status).toBe(401);
  });
});

describe('seeing every account', () => {
  it('lists accounts from other workspaces, with where they belong', async () => {
    const response = await admin.client.get<{
      items: Array<{
        email: string;
        memberships: Array<{ workspaceName: string; role: string }>;
      }>;
      total: number;
    }>('/platform/users');

    expect(response.status).toBe(200);
    const emails = response.body.items.map((u) => u.email);
    expect(emails).toContain(admin.email);
    // The other owner is in a workspace this administrator is not a member of.
    expect(emails).toContain(other.email);

    const row = response.body.items.find((u) => u.email === other.email);
    expect(row?.memberships.length).toBeGreaterThan(0);
    expect(row?.memberships[0]?.role).toBe('owner');
  });

  it('never returns a password hash, however it is asked', async () => {
    const response = await admin.client.get('/platform/users?q=' + encodeURIComponent(other.email));
    const body = JSON.stringify(response.body);
    expect(body).not.toMatch(/\$argon2|passwordHash|password_hash/);
    // Only whether one exists.
    expect(body).toContain('hasPassword');
  });
});

describe('what it deliberately cannot do', () => {
  it('does not open another workspace’s documents', async () => {
    /*
     * The point of the whole design. A platform administrator administers identities; the
     * tenant checks every retrieval makes are untouched by the flag, so reading somebody
     * else's sources still requires a membership in their workspace.
     */
    const sources = await admin.client.get<{ items: unknown[] }>('/sources');
    expect(sources.status).toBe(200);
    // Their own workspace, which is empty — not the other owner's.
    expect(sources.body.items).toEqual([]);

    const consultations = await admin.client.get<{ items: unknown[] }>('/consultations');
    expect(consultations.body.items).toEqual([]);
  });
});

describe('helping somebody back in', () => {
  it('issues a reset link without ever revealing a password', async () => {
    const list = await admin.client.get<{ items: Array<{ id: string; email: string }> }>(
      '/platform/users?q=' + encodeURIComponent(other.email),
    );
    const target = list.body.items[0]!;

    const response = await admin.client.post<{
      delivery: { status: string; resetUrl: string | null };
    }>(`/platform/users/${target.id}/password-reset`);

    expect(response.status).toBe(200);
    // The harness runs the console driver, so the link comes back to be sent by hand.
    expect(response.body.delivery.status).toBe('not_configured');
    expect(response.body.delivery.resetUrl).toContain('/reset-password?token=');

    // And it works: the token resets the password for real.
    const token = /token=([A-Za-z0-9_-]+)/.exec(response.body.delivery.resetUrl ?? '')?.[1];
    const guest = new Client(harness);
    const reset = await guest.post('/auth/reset-password', {
      token,
      password: 'A-Third-Str0ng-Passphrase!',
    });
    expect(reset.status).toBeLessThan(300);
  });
});

describe('adding somebody', () => {
  it('creates an account that can sign in with the password given', async () => {
    const created = await admin.client.post<{ user: { id: string; email: string } }>(
      '/platform/users',
      {
        email: 'added.person@example.test',
        fullName: 'Added Person',
        role: 'member',
        password: 'An0ther-Str0ng-Passphrase!',
      },
    );
    expect(created.status).toBe(201);

    const client = new Client(harness);
    const login = await client.post('/auth/login', {
      email: 'added.person@example.test',
      password: 'An0ther-Str0ng-Passphrase!',
    });
    expect(login.status).toBe(200);

    // And they are in the administrator's workspace, at the role given.
    const members = await admin.client.get<Array<{ email: string; role: string }>>('/users');
    expect(members.body.find((m) => m.email === 'added.person@example.test')?.role).toBe('member');
  });

  it('sends a link instead when no password is given, and sets none', async () => {
    const created = await admin.client.post<{
      user: { hasPassword: boolean };
      delivery: { status: string; resetUrl: string | null } | null;
    }>('/platform/users', {
      email: 'linked.person@example.test',
      fullName: 'Linked Person',
      role: 'read_only',
    });

    expect(created.status).toBe(201);
    expect(created.body.user.hasPassword).toBe(false);
    expect(created.body.delivery?.resetUrl).toContain('/reset-password?token=');
  });

  it('tells an administrator plainly that an address is taken', async () => {
    // Unlike registration, which must not confirm an address exists to a stranger: this
    // caller is entitled to know, and hiding it only makes them try again.
    const response = await admin.client.post('/platform/users', {
      email: other.email,
      fullName: 'Duplicate',
      role: 'member',
    });
    expect(response.status).toBe(400);
  });
});

describe('the authority itself', () => {
  it('will not let the last administrator be demoted', async () => {
    const list = await admin.client.get<{ items: Array<{ id: string; email: string }> }>(
      '/platform/users?q=' + encodeURIComponent(admin.email),
    );
    const self = list.body.items[0]!;

    // Their own account is refused outright, which is also what keeps the last one.
    const attempt = await admin.client.patch(`/platform/users/${self.id}`, {
      isPlatformAdmin: false,
    });
    expect(attempt.status).toBe(403);
  });

  it('suspends an account and stops its sessions in the same breath', async () => {
    // Its own account: the reset case above deliberately revoked the other owner's
    // sessions, and a test that depends on another test's leftovers is not a test.
    const victim = await registerOwner(harness);
    const list = await admin.client.get<{ items: Array<{ id: string; email: string }> }>(
      '/platform/users?q=' + encodeURIComponent(victim.email),
    );
    const target = list.body.items[0]!;

    const before = await victim.client.get('/auth/session');
    expect(before.status).toBeLessThan(300);

    const suspended = await admin.client.patch(`/platform/users/${target.id}`, {
      status: 'suspended',
    });
    expect(suspended.status).toBe(200);

    const after = await victim.client.get('/auth/session');
    expect(after.status).toBeGreaterThanOrEqual(400);
  });
});
