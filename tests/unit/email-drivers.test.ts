import { describe, expect, it, vi } from 'vitest';
import { EmailTemplates, SmtpEmailDriver } from '../../apps/api/src/services/email.js';

/**
 * SMTP.
 *
 * `smtp` sat in the driver enum from the beginning with nothing behind it, so a deployment
 * that selected it silently got the console driver and no warning — the configuration said
 * mail was being sent and it was going into a log file. These cases are about the two
 * things that make the difference between working and appearing to work: encryption is not
 * optional, and a failure is reported rather than swallowed.
 */

const MESSAGE = {
  to: 'someone@entity.gov.ae',
  subject: 'You have been invited',
  text: 'Open the link.',
  html: '<p>Open the link.</p>',
  tag: 'invitation',
};

function fakeTransport(overrides: Record<string, unknown> = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const transport = {
    sendMail: vi.fn(async (options: Record<string, unknown>) => {
      calls.push(options);
      return { messageId: '<abc@host>' };
    }),
    verify: vi.fn(async () => true),
    ...overrides,
  };
  const created: Array<Record<string, unknown>> = [];
  // Cast at the seam: nodemailer's createTransport is a nine-way overload, and matching it
  // exactly would be a page of types in service of a stub that only ever takes one shape.
  const createTransport = ((config: Record<string, unknown>) => {
    created.push(config);
    return transport;
  }) as unknown as ConstructorParameters<typeof SmtpEmailDriver>[2];
  return { transport, createTransport, created, calls };
}

const CONFIG = {
  host: 'smtp.example.test',
  port: 587,
  user: 'postmaster@example.test',
  password: 'hunter2',
  secure: false,
};

describe('SmtpEmailDriver', () => {
  it('sends the message with the configured sender', async () => {
    const { createTransport, calls } = fakeTransport();
    const driver = new SmtpEmailDriver(CONFIG, 'UXE <no-reply@example.test>', createTransport);

    const result = await driver.send(MESSAGE);

    expect(result.id).toBe('<abc@host>');
    expect(calls[0]).toMatchObject({
      from: 'UXE <no-reply@example.test>',
      to: 'someone@entity.gov.ae',
      subject: 'You have been invited',
    });
  });

  it('requires STARTTLS on a plaintext port rather than falling back', async () => {
    // Without this the password goes over the wire in the clear on any server that does
    // not advertise STARTTLS, and nothing about the configuration would say so.
    const { createTransport, created } = fakeTransport();
    await new SmtpEmailDriver(CONFIG, 'from@example.test', createTransport).send(MESSAGE);

    expect(created[0]).toMatchObject({ secure: false, requireTLS: true });
  });

  it('does not ask for STARTTLS when the port is already implicit TLS', async () => {
    const { createTransport, created } = fakeTransport();
    await new SmtpEmailDriver(
      { ...CONFIG, port: 465, secure: true },
      'from@example.test',
      createTransport,
    ).send(MESSAGE);

    expect(created[0]).toMatchObject({ secure: true, requireTLS: false });
  });

  it('connects once and reuses it', async () => {
    const { createTransport, created } = fakeTransport();
    const driver = new SmtpEmailDriver(CONFIG, 'from@example.test', createTransport);

    await driver.send(MESSAGE);
    await driver.send(MESSAGE);

    expect(created).toHaveLength(1);
  });

  it('reports an unreachable server without repeating the password', async () => {
    const { createTransport } = fakeTransport({
      verify: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.1:587');
      }),
    });
    const driver = new SmtpEmailDriver(CONFIG, 'from@example.test', createTransport);

    const health = await driver.health();

    expect(health.ok).toBe(false);
    expect(health.detail).toContain('smtp.example.test:587');
    expect(health.detail).not.toContain('hunter2');
  });

  it('says so plainly when no host is configured', async () => {
    const { createTransport } = fakeTransport();
    const driver = new SmtpEmailDriver(
      { ...CONFIG, host: '' },
      'from@example.test',
      createTransport,
    );

    expect(await driver.health()).toEqual({ ok: false, detail: 'SMTP_HOST is not configured.' });
  });
});

describe('the account-exists notice', () => {
  /*
   * The API cannot say "that address already has an account" without telling any stranger
   * which addresses are registered, so it says nothing and the mailbox gets the truth.
   * These cases are about the mailbox getting enough of it to act on.
   */
  it('points at signing in and at resetting a forgotten password', () => {
    const message = EmailTemplates.accountExists({
      fullName: 'Sadi Vural',
      signInUrl: 'https://consultnow.example/login',
      resetUrl: 'https://consultnow.example/forgot-password',
      pendingInvitation: false,
    });

    expect(message.text).toContain('https://consultnow.example/login');
    expect(message.text).toContain('https://consultnow.example/forgot-password');
    expect(message.html).toContain('https://consultnow.example/login');
  });

  it('says to open the invitation when one is still waiting', () => {
    // The case that was silently failing: invited, then signed up, then told "Account
    // created" for an account with no password on it.
    const message = EmailTemplates.accountExists({
      fullName: 'Sadi Vural',
      signInUrl: 'https://consultnow.example/login',
      resetUrl: 'https://consultnow.example/forgot-password',
      pendingInvitation: true,
    });

    expect(message.text).toMatch(/invitation waiting/i);
    expect(message.html).toMatch(/invitation waiting/i);
  });

  it('escapes a display name rather than letting it write markup', () => {
    const message = EmailTemplates.accountExists({
      fullName: '<img src=x onerror=alert(1)>',
      signInUrl: 'https://consultnow.example/login',
      resetUrl: 'https://consultnow.example/forgot-password',
      pendingInvitation: false,
    });

    expect(message.html).not.toContain('<img src=x');
    expect(message.html).toContain('&lt;img');
  });
});
