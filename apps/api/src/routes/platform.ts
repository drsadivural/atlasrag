import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  CreateUserRequest,
  UpdatePlatformUserRequest,
  type PlatformUser,
  type Role,
} from '@uxe/contracts';
import { hashPassword, randomToken, sha256Hex } from '@uxe/auth';
import type { AppBindings, AppDeps } from '../context.js';
import { ApiError } from '../errors.js';
import { body, query, requireId, validateJson, validateQuery } from '../middleware/validate.js';
import { clientIp, requirePlatformAdmin, userAgent } from '../middleware/index.js';
import { EmailTemplates } from '../services/email.js';
import { z } from 'zod';

const RESET_TTL_MINUTES = 60;

const ListQuery = z.object({
  q: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * Platform administration.
 *
 * Every route here crosses workspaces, which is the whole point and also the reason the
 * surface is this small. It administers *identities*: who exists, what they may do in the
 * workspaces that admitted them, and how they get back in when they are locked out.
 *
 * It reaches no tenant data. There is no route through this file to a source, a
 * consultation, an answer or an artifact, and the tenant checks every retrieval makes are
 * untouched by it — a platform administrator who wants to read a customer's filings has to
 * be given a membership like anybody else, and that grant is auditable on its own. Being
 * able to administer accounts is not permission to read what those accounts hold.
 */
export function platformRoutes(deps: AppDeps) {
  const app = new Hono<AppBindings>();
  app.use('*', requirePlatformAdmin());

  /* ---------------------------------------------------------------------- */
  /* Everybody on the deployment                                            */
  /* ---------------------------------------------------------------------- */

  app.get('/users', validateQuery(ListQuery), async (c) => {
    const params = query<typeof ListQuery._output>(c);
    const result = await deps.repos.identity.listAllUsers({
      q: params.q,
      limit: params.pageSize,
      offset: (params.page - 1) * params.pageSize,
    });

    return c.json({
      items: result.items.map(({ user, memberships }) => toPlatformUser(user, memberships)),
      total: result.total,
      page: params.page,
      pageSize: params.pageSize,
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Suspending, and granting this authority to somebody else               */
  /* ---------------------------------------------------------------------- */

  app.patch('/users/:id', validateJson(UpdatePlatformUserRequest), async (c) => {
    const session = c.get('session');
    if (!session) throw ApiError.unauthenticated();
    const targetId = requireId(c, 'id');
    const input = body<typeof UpdatePlatformUserRequest._output>(c);

    const target = await deps.repos.identity.findUserById(targetId);
    if (!target) throw ApiError.notFound('User');

    if (targetId === session.userId) {
      // Both of these would be a way to lock yourself out of the authority you are using,
      // and the second is how a deployment ends up with no administrator at all.
      throw ApiError.forbidden('Change your own account from your profile, not from here.');
    }

    if (input.isPlatformAdmin === false && target.isPlatformAdmin) {
      const remaining = await deps.repos.identity.countPlatformAdmins();
      if (remaining <= 1) {
        throw ApiError.forbidden('A deployment must keep at least one platform administrator.');
      }
    }

    if (input.isPlatformAdmin !== undefined) {
      await deps.repos.identity.setPlatformAdmin(targetId, input.isPlatformAdmin);
    }

    let revoked = 0;
    if (input.status !== undefined) {
      await deps.repos.identity.setUserStatus(targetId, input.status);
      if (input.status === 'suspended') {
        // Suspension that leaves live sessions running is not suspension.
        revoked = await deps.repos.identity.revokeAllSessionsForUser(targetId);
      }
    }

    await recordPlatformAudit(deps, c, {
      action: 'platform.user.updated',
      targetId,
      targetLabel: target.email,
      summary:
        [
          input.status ? `status → ${input.status}` : null,
          input.isPlatformAdmin === undefined
            ? null
            : input.isPlatformAdmin
              ? 'granted platform administration'
              : 'revoked platform administration',
          revoked > 0 ? `${revoked} session(s) revoked` : null,
        ]
          .filter(Boolean)
          .join('; ') || 'no change',
      before: { status: target.status, isPlatformAdmin: target.isPlatformAdmin },
      after: {
        status: input.status ?? target.status,
        isPlatformAdmin: input.isPlatformAdmin ?? target.isPlatformAdmin,
      },
    });

    const refreshed = await deps.repos.identity.findUserById(targetId);
    const listed = await deps.repos.identity.listAllUsers({ q: target.email, limit: 1, offset: 0 });
    return c.json(toPlatformUser(refreshed ?? target, listed.items[0]?.memberships ?? []));
  });

  /* ---------------------------------------------------------------------- */
  /* Getting somebody back in                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Issues a reset link for another account.
   *
   * The administrator never learns the password: they send a link, and the person chooses
   * one. That is the difference between helping somebody back in and being able to sign in
   * as them, and it is why this endpoint does not accept a password.
   */
  app.post('/users/:id/password-reset', async (c) => {
    const session = c.get('session');
    if (!session) throw ApiError.unauthenticated();
    const targetId = requireId(c, 'id');

    const target = await deps.repos.identity.findUserById(targetId);
    if (!target) throw ApiError.notFound('User');

    const token = randomToken(32);
    await deps.repos.identity.createAuthToken({
      userId: target.id,
      email: target.email,
      kind: 'password_reset',
      tokenHash: await sha256Hex(token),
      ttlMinutes: RESET_TTL_MINUTES,
    });
    const resetUrl = `${deps.env.PUBLIC_APP_URL}/reset-password?token=${encodeURIComponent(token)}`;

    const delivery = await deliver(deps, {
      to: target.email,
      message: EmailTemplates.resetPassword({
        fullName: target.fullName,
        url: resetUrl,
        expiresInMinutes: RESET_TTL_MINUTES,
      }),
      fallbackUrl: resetUrl,
    });

    await recordPlatformAudit(deps, c, {
      action: 'platform.user.password_reset',
      targetId,
      targetLabel: target.email,
      // The token is never written here: an audit trail readable by an administrator must
      // not contain a live credential for somebody else's account.
      summary: `Issued a password reset link (${delivery.status}).`,
    });

    return c.json({ delivery: { ...delivery, resetUrl: delivery.link } });
  });

  /* ---------------------------------------------------------------------- */
  /* Adding somebody directly                                               */
  /* ---------------------------------------------------------------------- */

  app.post('/users', validateJson(CreateUserRequest), async (c) => {
    const tenant = c.get('tenant');
    const session = c.get('session');
    if (!tenant || !session) throw ApiError.unauthenticated();
    const input = body<typeof CreateUserRequest._output>(c);

    const existing = await deps.repos.identity.findUserByEmail(input.email);
    if (existing) {
      // Unlike registration, this caller is an administrator who is entitled to know the
      // address is taken — hiding it would only make them create the same account twice.
      throw ApiError.badRequest('That address already has an account.', {
        email: ['An account with this address already exists.'],
      });
    }

    const user = await deps.repos.identity.createUser({
      email: input.email,
      passwordHash: input.password ? await hashPassword(input.password) : null,
      fullName: input.fullName,
    });
    // Created by an administrator who typed the address: there is nobody to confirm it to,
    // and leaving it unverified would block a sign-in nobody else can unblock.
    await deps.repos.identity.markEmailVerified(user.id);

    await deps.repos.identity.addMembership({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      userId: user.id,
      role: input.role,
      status: 'active',
    });

    /*
     * No password given means they choose their own, which is the better path: the
     * administrator never knows it. The link is emailed, and returned when it could not
     * be — the same as an invitation, for the same reason.
     */
    let delivery: Delivery | null = null;
    if (!input.password) {
      const token = randomToken(32);
      await deps.repos.identity.createAuthToken({
        userId: user.id,
        email: user.email,
        kind: 'password_reset',
        tokenHash: await sha256Hex(token),
        ttlMinutes: RESET_TTL_MINUTES,
      });
      const url = `${deps.env.PUBLIC_APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
      delivery = await deliver(deps, {
        to: user.email,
        message: EmailTemplates.resetPassword({
          fullName: user.fullName,
          url,
          expiresInMinutes: RESET_TTL_MINUTES,
        }),
        fallbackUrl: url,
      });
    }

    await recordPlatformAudit(deps, c, {
      action: 'platform.user.created',
      targetId: user.id,
      targetLabel: user.email,
      summary: `Created ${user.email} as ${input.role.replace(/_/g, ' ')} in ${tenant.workspaceId}${
        input.password ? ' with a password set by an administrator' : ''
      }.`,
    });

    return c.json(
      {
        user: toPlatformUser({ ...user, isPlatformAdmin: false }, []),
        delivery: delivery ? { ...delivery, resetUrl: delivery.link } : null,
      },
      201,
    );
  });

  return app;
}

/* -------------------------------------------------------------------------- */

interface Delivery {
  status: 'sent' | 'not_configured' | 'failed';
  driver: 'console' | 'resend' | 'smtp';
  detail: string | null;
  link: string | null;
}

/**
 * Sends a message and says honestly what happened to it.
 *
 * The same shape the invitation flow uses, and for the same reason: reporting "sent" when
 * the console driver wrote it to a log costs somebody a week before anyone thinks to check.
 */
async function deliver(
  deps: AppDeps,
  input: {
    to: string;
    message: ReturnType<typeof EmailTemplates.resetPassword>;
    fallbackUrl: string;
  },
): Promise<Delivery> {
  const driver = deps.services.email.id;
  if (driver === 'console') {
    return {
      status: 'not_configured',
      driver,
      detail:
        'This deployment has no mail transport, so no email was sent. Send the link yourself.',
      link: input.fallbackUrl,
    };
  }

  try {
    await deps.services.email.send({ to: input.to, ...input.message });
    return { status: 'sent', driver, detail: null, link: null };
  } catch (error) {
    deps.logger.warn('platform.email_failed', {
      driver,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return {
      status: 'failed',
      driver,
      detail:
        error instanceof Error
          ? `The mail server refused the message: ${error.message}`
          : 'The mail server refused the message.',
      link: input.fallbackUrl,
    };
  }
}

function toPlatformUser(
  user: {
    id: string;
    email: string;
    fullName: string;
    avatarUrl: string | null;
    status: string;
    isPlatformAdmin: boolean;
    passwordHash: string | null;
    emailVerifiedAt: Date | null;
    lastActiveAt: Date | null;
    createdAt: Date;
  },
  memberships: Array<{
    workspaceId: string;
    workspaceName: string;
    role: string;
    status: string;
  }>,
): PlatformUser {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    avatarUrl: user.avatarUrl,
    status: user.status === 'suspended' ? 'suspended' : 'active',
    isPlatformAdmin: user.isPlatformAdmin,
    emailVerified: user.emailVerifiedAt !== null,
    // Whether one exists, never any part of it. An account with none can only get in
    // through a link, which is what an administrator needs to know to help.
    hasPassword: user.passwordHash !== null,
    lastActiveAt: user.lastActiveAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    memberships: memberships.map((m) => ({
      workspaceId: m.workspaceId,
      workspaceName: m.workspaceName,
      role: m.role as Role,
      status: m.status as PlatformUser['memberships'][number]['status'],
    })),
  };
}

async function recordPlatformAudit(
  deps: AppDeps,
  c: Context<AppBindings>,
  entry: {
    action: string;
    targetId: string;
    targetLabel: string;
    summary: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
  },
): Promise<void> {
  const session = c.get('session');
  const tenant = c.get('tenant');
  await deps.repos.audit.record({
    // Recorded against the administrator's own workspace: the action was theirs, and
    // writing it into somebody else's trail would put an entry in a tenant's record that
    // nobody in that tenant performed.
    organizationId: tenant?.organizationId ?? 'platform',
    workspaceId: tenant?.workspaceId ?? null,
    actorUserId: session?.userId ?? 'unknown',
    actorName: session?.user.fullName ?? 'Unknown',
    action: entry.action,
    category: 'permission',
    targetType: 'user',
    targetId: entry.targetId,
    targetLabel: entry.targetLabel,
    ipAddress: clientIp(c),
    userAgent: userAgent(c),
    traceId: tenant?.traceId ?? c.get('traceId') ?? 'unknown',
    summary: entry.summary,
    ...(entry.before ? { before: entry.before } : {}),
    ...(entry.after ? { after: entry.after } : {}),
  });
}
