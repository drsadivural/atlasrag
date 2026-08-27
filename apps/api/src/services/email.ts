import { createTransport as nodemailerCreateTransport, type Transporter } from 'nodemailer';
import type { Logger } from '@uxe/observability';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Grouping tag used by the provider dashboard and by tests. */
  tag: string;
}

export interface EmailDriver {
  readonly id: 'console' | 'resend' | 'smtp';
  send(message: EmailMessage): Promise<{ id: string }>;
  health(): Promise<{ ok: boolean; detail: string | null }>;
}

/**
 * Development driver. Logs the message instead of sending it, and keeps the last messages
 * in memory so E2E tests can read a verification link without a mail server.
 */
export class ConsoleEmailDriver implements EmailDriver {
  readonly id = 'console' as const;
  private readonly outbox: Array<EmailMessage & { id: string; at: Date }> = [];

  constructor(private readonly logger: Logger) {}

  async send(message: EmailMessage) {
    const id = `console-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.outbox.push({ ...message, id, at: new Date() });
    if (this.outbox.length > 100) this.outbox.shift();
    // The body is deliberately not logged: verification and reset emails carry live tokens.
    this.logger.info('email.sent', {
      driver: 'console',
      to: message.to,
      subject: message.subject,
      tag: message.tag,
      id,
    });
    return { id };
  }

  async health() {
    return { ok: true, detail: 'Console driver: messages are not delivered.' };
  }

  /** Test-only accessor. */
  messagesFor(email: string): Array<EmailMessage & { id: string; at: Date }> {
    return this.outbox.filter((m) => m.to.toLowerCase() === email.toLowerCase());
  }

  latest(): (EmailMessage & { id: string; at: Date }) | null {
    return this.outbox.at(-1) ?? null;
  }
}

export class ResendEmailDriver implements EmailDriver {
  readonly id = 'resend' as const;

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: EmailMessage) {
    const response = await this.fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
        tags: [{ name: 'category', value: message.tag }],
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Email send failed: ${response.status} ${await response.text().catch(() => '')}`,
      );
    }

    const json = (await response.json()) as { id?: string };
    return { id: json.id ?? 'unknown' };
  }

  async health() {
    if (!this.apiKey) return { ok: false, detail: 'RESEND_API_KEY is not configured.' };
    try {
      const response = await this.fetchImpl('https://api.resend.com/domains', {
        headers: { authorization: `Bearer ${this.apiKey}` },
      });
      return { ok: response.ok, detail: response.ok ? null : `status ${response.status}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'unknown' };
    }
  }
}

/**
 * Ordinary SMTP.
 *
 * `smtp` has been in the driver enum since the beginning with nothing behind it, so a
 * deployment that selected it got the console driver and no warning — mail silently went
 * nowhere while the configuration said otherwise. This is the implementation that was
 * missing, and it is the option most operators can actually use: a mailbox and a password,
 * rather than an account with a particular sending service.
 *
 * The connection is verified once, lazily, rather than at construction: a mail server that
 * is briefly unreachable must not stop the API from starting, and every other outbound
 * dependency here behaves the same way.
 */
export class SmtpEmailDriver implements EmailDriver {
  readonly id = 'smtp' as const;
  private transport: Transporter | null = null;

  constructor(
    private readonly config: {
      host: string;
      port: number;
      user: string;
      password: string;
      /**
       * Implicit TLS, as on port 465. Port 587 is left false and upgrades with STARTTLS,
       * which nodemailer requires by default — an unencrypted fallback would put the
       * password on the wire.
       */
      secure: boolean;
    },
    private readonly from: string,
    private readonly createTransport: typeof nodemailerCreateTransport = nodemailerCreateTransport,
  ) {}

  private connection(): Transporter {
    this.transport ??= this.createTransport({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      requireTLS: !this.config.secure,
      auth: this.config.user ? { user: this.config.user, pass: this.config.password } : undefined,
    });
    return this.transport;
  }

  async send(message: EmailMessage) {
    const sent = await this.connection().sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      headers: { 'X-Entity-Tag': message.tag },
    });
    return { id: sent.messageId ?? 'unknown' };
  }

  async health() {
    if (!this.config.host) return { ok: false, detail: 'SMTP_HOST is not configured.' };
    try {
      await this.connection().verify();
      return { ok: true, detail: null };
    } catch (error) {
      // The message names the host and the failure, never the password.
      return {
        ok: false,
        detail: `${this.config.host}:${this.config.port} — ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      };
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Templates                                                                  */
/* -------------------------------------------------------------------------- */

/** Escapes interpolated values so a display name cannot inject markup into the email. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout(title: string, bodyHtml: string, cta?: { label: string; url: string }): string {
  return `<!doctype html><html><body style="margin:0;background:#F8FAFF;font-family:Inter,-apple-system,Segoe UI,sans-serif;color:#10162F">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:560px;background:#FFFFFF;border:1px solid #E4E7EC;border-radius:16px">
<tr><td style="padding:32px">
<div style="font-size:18px;font-weight:700;background:linear-gradient(90deg,#3156F5,#7C3AED);-webkit-background-clip:text;background-clip:text;color:#3156F5">UXE Consulting AI</div>
<h1 style="font-size:22px;margin:20px 0 12px">${escapeHtml(title)}</h1>
${bodyHtml}
${
  cta
    ? `<p style="margin:28px 0"><a href="${escapeHtml(cta.url)}" style="display:inline-block;background:#3156F5;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600">${escapeHtml(cta.label)}</a></p>
<p style="font-size:13px;color:#667085">If the button does not work, paste this link into your browser:<br><span style="word-break:break-all">${escapeHtml(cta.url)}</span></p>`
    : ''
}
<hr style="border:none;border-top:1px solid #E4E7EC;margin:24px 0">
<p style="font-size:12px;color:#667085;margin:0">Verified answers. Exact evidence. Corrected documents.</p>
</td></tr></table></td></tr></table></body></html>`;
}

export const EmailTemplates = {
  verifyEmail(input: {
    fullName: string;
    url: string;
    expiresInHours: number;
  }): Omit<EmailMessage, 'to'> {
    return {
      subject: 'Confirm your email address',
      tag: 'verify-email',
      text: `Hello ${input.fullName},\n\nConfirm your email address to finish setting up UXE Consulting AI:\n${input.url}\n\nThis link expires in ${input.expiresInHours} hours. If you did not create an account, you can ignore this message.`,
      html: layout(
        'Confirm your email address',
        `<p style="font-size:15px;line-height:1.6">Hello ${escapeHtml(input.fullName)}, confirm your email address to finish setting up your workspace.</p>
         <p style="font-size:14px;color:#667085">This link expires in ${input.expiresInHours} hours. If you did not create an account, ignore this message.</p>`,
        { label: 'Confirm email', url: input.url },
      ),
    };
  },

  resetPassword(input: {
    fullName: string;
    url: string;
    expiresInMinutes: number;
  }): Omit<EmailMessage, 'to'> {
    return {
      subject: 'Reset your password',
      tag: 'reset-password',
      text: `Hello ${input.fullName},\n\nReset your UXE Consulting AI password:\n${input.url}\n\nThis link expires in ${input.expiresInMinutes} minutes and can only be used once. If you did not request this, your account is still secure and no action is needed.`,
      html: layout(
        'Reset your password',
        `<p style="font-size:15px;line-height:1.6">Hello ${escapeHtml(input.fullName)}, use the button below to choose a new password.</p>
         <p style="font-size:14px;color:#667085">This link expires in ${input.expiresInMinutes} minutes and can only be used once. If you did not request it, your account is still secure.</p>`,
        { label: 'Reset password', url: input.url },
      ),
    };
  },

  magicLink(input: { url: string; expiresInMinutes: number }): Omit<EmailMessage, 'to'> {
    return {
      subject: 'Your sign-in link',
      tag: 'magic-link',
      text: `Sign in to UXE Consulting AI:\n${input.url}\n\nThis link expires in ${input.expiresInMinutes} minutes and can only be used once.`,
      html: layout(
        'Your sign-in link',
        `<p style="font-size:15px;line-height:1.6">Use the button below to sign in. The link expires in ${input.expiresInMinutes} minutes and works only once.</p>`,
        { label: 'Sign in', url: input.url },
      ),
    };
  },

  invitation(input: {
    inviterName: string;
    workspaceName: string;
    role: string;
    url: string;
    message?: string | null;
  }): Omit<EmailMessage, 'to'> {
    return {
      subject: `${input.inviterName} invited you to ${input.workspaceName}`,
      tag: 'invitation',
      text: `${input.inviterName} invited you to join ${input.workspaceName} on UXE Consulting AI as ${input.role}.\n${input.message ? `\n"${input.message}"\n` : ''}\nAccept: ${input.url}`,
      html: layout(
        `Join ${input.workspaceName}`,
        `<p style="font-size:15px;line-height:1.6">${escapeHtml(input.inviterName)} invited you to join <strong>${escapeHtml(input.workspaceName)}</strong> as <strong>${escapeHtml(input.role)}</strong>.</p>
         ${input.message ? `<blockquote style="margin:16px 0;padding:12px 16px;background:#F8FAFF;border-left:3px solid #3156F5;font-size:14px">${escapeHtml(input.message)}</blockquote>` : ''}`,
        { label: 'Accept invitation', url: input.url },
      ),
    };
  },

  jobComplete(input: { title: string; detail: string; url: string }): Omit<EmailMessage, 'to'> {
    return {
      subject: `Ready: ${input.title}`,
      tag: 'job-complete',
      text: `${input.title}\n\n${input.detail}\n\nOpen: ${input.url}`,
      html: layout(
        input.title,
        `<p style="font-size:15px;line-height:1.6">${escapeHtml(input.detail)}</p>`,
        { label: 'Open in UXE Consulting AI', url: input.url },
      ),
    };
  },

  jobFailed(input: {
    title: string;
    reason: string;
    traceId: string;
    url: string;
  }): Omit<EmailMessage, 'to'> {
    return {
      subject: `Action needed: ${input.title}`,
      tag: 'job-failed',
      text: `${input.title} could not be completed.\n\nReason: ${input.reason}\nReference: ${input.traceId}\n\nYour input was preserved and the job can be retried: ${input.url}`,
      html: layout(
        `Action needed: ${input.title}`,
        `<p style="font-size:15px;line-height:1.6">${escapeHtml(input.reason)}</p>
         <p style="font-size:14px;color:#667085">Your input was preserved and nothing was lost. You can retry from the job panel.</p>
         <p style="font-size:12px;color:#667085">Reference: <code>${escapeHtml(input.traceId)}</code></p>`,
        { label: 'Retry the job', url: input.url },
      ),
    };
  },
};
