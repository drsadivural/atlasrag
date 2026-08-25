import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  buildOtpauthUrl,
  checkPasswordStrength,
  clearCookie,
  createSessionToken,
  deriveCsrfToken,
  encryptSecret,
  decryptSecret,
  evaluateLockout,
  generateRecoveryCodes,
  generateTotpSecret,
  hashPassword,
  hashSessionToken,
  mustEnrollMfa,
  normalizeRecoveryCode,
  parseCookies,
  randomToken,
  requiresMfa,
  serializeCsrfCookie,
  serializeSessionCookie,
  sessionLifetime,
  sha256Hex,
  verifyPassword,
  verifyTotp,
  type MfaPolicy,
} from '@uxe/auth';
import {
  ForgotPasswordRequest,
  LoginRequest,
  MagicLinkRequest,
  MfaVerifyRequest,
  RegisterRequest,
  ResetPasswordRequest,
  VerifyEmailRequest,
  permissionsForRole,
  type Role,
  type SessionResponse,
} from '@uxe/contracts';
import { newId } from '@uxe/db';
import type { AppBindings, AppDeps, RequestSession } from '../context.js';
import { ApiError } from '../errors.js';
import { body, validateJson } from '../middleware/validate.js';
import { clientIp, requireAuth, userAgent } from '../middleware/index.js';
import { RateLimitBuckets } from '../services/rate-limit.js';
import { EmailTemplates } from '../services/email.js';
import { isProduction } from '../env.js';
import { defaultWorkspaceSettings, workspaceSettingsFrom } from '../services/settings.js';

const VERIFY_TTL_HOURS = 24;
const RESET_TTL_MINUTES = 30;
const MAGIC_LINK_TTL_MINUTES = 15;
const MFA_CHALLENGE_TTL_MINUTES = 10;

export function authRoutes(deps: AppDeps) {
  const app = new Hono<AppBindings>();
  const secure = isProduction(deps.env) || deps.env.PUBLIC_API_URL.startsWith('https://');

  /* ---------------------------------------------------------------------- */
  /* Registration                                                           */
  /* ---------------------------------------------------------------------- */

  app.post('/register', validateJson(RegisterRequest), async (c) => {
    const input = body<typeof RegisterRequest._output>(c);
    const ip = clientIp(c);

    const limit = await deps.services.rateLimiter.check(RateLimitBuckets.registration(ip), 5, 3600);
    if (!limit.allowed) throw ApiError.rateLimited(limit.retryAfterSeconds);

    const strength = checkPasswordStrength(input.password, {
      email: input.email,
      fullName: input.fullName,
      workspaceName: input.organizationName,
    });
    if (!strength.ok) {
      throw ApiError.badRequest('Choose a stronger password.', { password: strength.reasons });
    }

    const existing = await deps.repos.identity.findUserByEmail(input.email);
    if (existing) {
      // Registering an existing address must not confirm that it exists. The response is
      // identical to a success, and the account holder gets an email instead.
      await sendVerificationEmail(deps, existing.id, existing.email, existing.fullName);
      return c.json({ status: 'email_verification_required', email: input.email }, 200);
    }

    const user = await deps.repos.identity.createUser({
      email: input.email,
      passwordHash: await hashPassword(input.password),
      fullName: input.fullName,
      locale: input.locale,
    });

    const slug = slugify(input.organizationName);
    const { organization, workspace } = await deps.repos.identity.createOrganizationWithWorkspace({
      organizationName: input.organizationName,
      organizationSlug: `${slug}-${user.id.slice(-6).toLowerCase()}`,
      workspaceName: input.organizationName,
      workspaceSlug: 'main',
      ownerUserId: user.id,
    });

    await deps.repos.identity.updateWorkspace(
      {
        organizationId: organization.id,
        workspaceId: workspace.id,
        userId: user.id,
        role: 'owner',
        groupIds: [],
        traceId: c.get('traceId') ?? 'setup',
      },
      { settings: defaultWorkspaceSettings(input.fullName, input.locale) as never },
    );

    await deps.repos.audit.record({
      organizationId: organization.id,
      workspaceId: workspace.id,
      actorUserId: user.id,
      actorName: user.fullName,
      action: 'auth.register',
      category: 'auth',
      targetType: 'user',
      targetId: user.id,
      targetLabel: user.email,
      ipAddress: ip,
      userAgent: userAgent(c),
      traceId: c.get('traceId') ?? 'unknown',
      summary: `${user.fullName} created an account and the workspace "${workspace.name}".`,
    });

    await sendVerificationEmail(deps, user.id, user.email, user.fullName);
    return c.json({ status: 'email_verification_required', email: user.email }, 201);
  });

  /* ---------------------------------------------------------------------- */
  /* Sign in                                                                */
  /* ---------------------------------------------------------------------- */

  app.post('/login', validateJson(LoginRequest), async (c) => {
    const input = body<typeof LoginRequest._output>(c);
    const ip = clientIp(c);

    // Two independent buckets: neither an IP nor an account alone can be used to lock
    // somebody else out, but a spray across either dimension is still throttled.
    const byIp = await deps.services.rateLimiter.check(
      RateLimitBuckets.loginByIp(ip),
      deps.env.RATE_LIMIT_LOGIN_PER_15M,
      900,
    );
    const byEmail = await deps.services.rateLimiter.check(
      RateLimitBuckets.loginByEmail(input.email),
      deps.env.RATE_LIMIT_LOGIN_PER_15M,
      900,
    );
    if (!byIp.allowed || !byEmail.allowed) {
      throw ApiError.rateLimited(Math.max(byIp.retryAfterSeconds, byEmail.retryAfterSeconds));
    }

    const user = await deps.repos.identity.findUserByEmail(input.email);

    // Always spend the cost of a hash, even for an unknown address, so response timing
    // does not reveal which addresses have accounts.
    const storedHash = user?.passwordHash ?? DUMMY_HASH;
    const check = await verifyPassword(input.password, storedHash);

    if (!user || !user.passwordHash || !check.valid) {
      if (user) {
        const state = await deps.repos.identity.recordFailedLogin(user.id);
        await deps.repos.audit.record({
          organizationId: 'unknown',
          workspaceId: null,
          actorUserId: user.id,
          actorName: user.email,
          action: 'auth.login.failed',
          category: 'auth',
          result: 'failure',
          ipAddress: ip,
          userAgent: userAgent(c),
          traceId: c.get('traceId') ?? 'unknown',
          summary: `Failed sign-in attempt (${state?.failedLoginCount ?? 0} consecutive).`,
        });
      }
      throw new ApiError(401, 'unauthenticated', 'That email address and password do not match.');
    }

    const lockout = evaluateLockout(user);
    if (lockout.locked) {
      throw new ApiError(429, 'rate_limited', lockout.message ?? 'Account temporarily locked.', {
        retryable: true,
        retryAfterSeconds: lockout.retryAfterSeconds ?? 900,
      });
    }

    if (!user.emailVerifiedAt) {
      await sendVerificationEmail(deps, user.id, user.email, user.fullName);
      return c.json({ status: 'email_verification_required', email: user.email }, 200);
    }

    // Upgrade a hash that predates the current KDF parameters, transparently.
    if (check.needsRehash) {
      await deps.repos.identity.updateUser(user.id, {
        passwordHash: await hashPassword(input.password),
      });
    }

    await deps.repos.identity.clearFailedLogins(user.id);

    const workspaces = await deps.repos.identity.listWorkspacesForUser(user.id);
    const primary = workspaces[0];
    const policy = await mfaPolicyFor(deps, primary?.id ?? null);
    const factors = await deps.repos.identity.listActiveFactors(user.id);
    const hasFactor = factors.some((f) => f.kind === 'totp' || f.kind === 'webauthn');

    if (requiresMfa({ policy, role: (primary?.role ?? 'member') as Role, hasActiveFactor: hasFactor })) {
      if (!hasFactor) {
        // Policy demands MFA but the user has none: route into enrolment rather than
        // locking them out of their own workspace.
        const session = await issueSession(deps, c, user, primary?.id ?? null, input.rememberMe, true);
        return c.json({ status: 'authenticated', session }, 200);
      }

      const challengeToken = randomToken(24);
      const challenge = await deps.repos.identity.createAuthToken({
        userId: user.id,
        email: user.email,
        kind: 'mfa_challenge',
        tokenHash: await sha256Hex(challengeToken),
        ttlMinutes: MFA_CHALLENGE_TTL_MINUTES,
        metadata: { rememberMe: input.rememberMe, workspaceId: primary?.id ?? null },
      });

      return c.json(
        {
          status: 'mfa_required',
          challengeId: challenge.id,
          methods: [...new Set(factors.map((f) => f.kind))].filter(
            (k): k is 'totp' | 'webauthn' => k === 'totp' || k === 'webauthn',
          ),
          // The raw challenge token is returned to the browser, not stored; only its hash
          // is persisted, so a database read cannot complete somebody else's challenge.
          challengeToken,
        },
        200,
      );
    }

    const session = await issueSession(deps, c, user, primary?.id ?? null, input.rememberMe, true);

    await deps.repos.audit.record({
      organizationId: primary ? primary.organizationId : 'unknown',
      workspaceId: primary?.id ?? null,
      actorUserId: user.id,
      actorName: user.fullName,
      action: 'auth.login',
      category: 'auth',
      ipAddress: ip,
      userAgent: userAgent(c),
      traceId: c.get('traceId') ?? 'unknown',
      summary: `${user.fullName} signed in.`,
    });

    return c.json({ status: 'authenticated', session }, 200);
  });

  /* ---------------------------------------------------------------------- */
  /* MFA                                                                    */
  /* ---------------------------------------------------------------------- */

  app.post('/mfa/verify', validateJson(MfaVerifyRequest.extend({})), async (c) => {
    const input = body<typeof MfaVerifyRequest._output & { challengeToken?: string }>(c);
    const raw = (await c.req.raw.clone().json()) as { challengeToken?: string };
    const challengeToken = raw.challengeToken;
    if (!challengeToken) throw ApiError.badRequest('The challenge has expired. Sign in again.');

    const token = await deps.repos.identity.findAuthToken(
      await sha256Hex(challengeToken),
      'mfa_challenge',
    );
    if (!token || token.id !== input.challengeId || !token.userId) {
      throw new ApiError(401, 'unauthenticated', 'That challenge has expired. Sign in again.');
    }

    const limit = await deps.services.rateLimiter.check(RateLimitBuckets.mfaByUser(token.userId), 8, 900);
    if (!limit.allowed) throw ApiError.rateLimited(limit.retryAfterSeconds);

    const user = await deps.repos.identity.findUserById(token.userId);
    if (!user) throw new ApiError(401, 'unauthenticated', 'That challenge is no longer valid.');

    const factors = await deps.repos.identity.listActiveFactors(user.id);
    const verified = await verifyAnyFactor(deps, factors, input.code);
    if (!verified) {
      throw new ApiError(401, 'unauthenticated', 'That code is not valid. Check your authenticator and try again.');
    }

    // Consume only after success, so a mistyped digit does not force a fresh sign-in.
    await deps.repos.identity.consumeAuthToken(await sha256Hex(challengeToken), 'mfa_challenge');

    const metadata = token.metadata as { rememberMe?: boolean; workspaceId?: string | null };
    const session = await issueSession(
      deps,
      c,
      user,
      metadata.workspaceId ?? null,
      metadata.rememberMe ?? false,
      true,
    );

    await deps.repos.audit.record({
      organizationId: 'unknown',
      workspaceId: metadata.workspaceId ?? null,
      actorUserId: user.id,
      actorName: user.fullName,
      action: 'auth.mfa.verified',
      category: 'auth',
      ipAddress: clientIp(c),
      userAgent: userAgent(c),
      traceId: c.get('traceId') ?? 'unknown',
      summary: `${user.fullName} completed two-factor authentication.`,
    });

    return c.json(session, 200);
  });

  app.post('/mfa/enroll', requireAuth(), async (c) => {
    const sess = c.get('session');
    if (!sess) throw ApiError.unauthenticated();

    const secret = generateTotpSecret();
    const factor = await deps.repos.identity.createFactor({
      userId: sess.userId,
      kind: 'totp',
      label: 'Authenticator app',
      secretEncrypted: await encryptSecret(secret, deps.env.ENCRYPTION_KEY),
      status: 'pending',
    });

    return c.json({
      factorId: factor.id,
      secret,
      otpauthUrl: buildOtpauthUrl({
        secret,
        accountName: sess.user.email,
        issuer: 'UXE Consulting AI',
      }),
    });
  });

  app.post('/mfa/activate', requireAuth(), async (c) => {
    const sess = c.get('session');
    if (!sess) throw ApiError.unauthenticated();

    const input = (await c.req.json()) as { factorId?: string; code?: string };
    if (!input.factorId || !input.code) throw ApiError.badRequest('Enter the 6-digit code.');

    const factor = await deps.repos.identity.getFactor(input.factorId);
    if (!factor || factor.userId !== sess.userId || !factor.secretEncrypted) {
      throw ApiError.notFound('Enrolment');
    }

    const secret = await decryptSecret(factor.secretEncrypted, deps.env.ENCRYPTION_KEY);
    if (!(await verifyTotp(secret, input.code))) {
      throw ApiError.badRequest('That code is not valid. Check the time on your device and try again.', {
        code: ['Incorrect code'],
      });
    }

    const recoveryCodes = generateRecoveryCodes(10);
    const hashes = await Promise.all(
      recoveryCodes.map((code) => sha256Hex(normalizeRecoveryCode(code))),
    );
    await deps.repos.identity.activateFactor(factor.id, hashes);

    return c.json({ ok: true as const, recoveryCodes });
  });

  /* ---------------------------------------------------------------------- */
  /* Session lifecycle                                                      */
  /* ---------------------------------------------------------------------- */

  app.get('/session', async (c) => {
    const sess = c.get('session');
    if (!sess) throw ApiError.unauthenticated();
    return c.json(await buildSessionResponse(deps, sess));
  });

  app.post('/logout', async (c) => {
    const sess = c.get('session');
    if (sess) {
      await deps.repos.identity.revokeSession(sess.sessionId);
      await deps.repos.audit.record({
        organizationId: 'unknown',
        workspaceId: null,
        actorUserId: sess.userId,
        actorName: sess.user.fullName,
        action: 'auth.logout',
        category: 'auth',
        ipAddress: clientIp(c),
        userAgent: userAgent(c),
        traceId: c.get('traceId') ?? 'unknown',
        summary: `${sess.user.fullName} signed out.`,
      });
    }
    c.header('set-cookie', clearCookie(SESSION_COOKIE, { secure }), { append: true });
    c.header('set-cookie', clearCookie(CSRF_COOKIE, { secure }), { append: true });
    return c.json({ ok: true as const });
  });

  app.post('/switch-workspace', requireAuth(), async (c) => {
    const sess = c.get('session');
    if (!sess) throw ApiError.unauthenticated();
    const input = (await c.req.json()) as { workspaceId?: string };
    if (!input.workspaceId) throw ApiError.badRequest('Choose a workspace.');

    const membership = await deps.repos.identity.getMembership(sess.userId, input.workspaceId);
    if (!membership) throw ApiError.notFound('Workspace');

    await deps.repos.identity.setSessionWorkspace(sess.sessionId, input.workspaceId);
    return c.json(await buildSessionResponse(deps, sess));
  });

  app.get('/sessions', requireAuth(), async (c) => {
    const sess = c.get('session');
    if (!sess) throw ApiError.unauthenticated();
    const rows = await deps.repos.identity.listSessionsForUser(sess.userId);
    return c.json(
      rows.map((row) => ({
        id: row.id,
        current: row.id === sess.sessionId,
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
        createdAt: row.createdAt.toISOString(),
        lastSeenAt: row.lastSeenAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      })),
    );
  });

  app.delete('/sessions/:id', requireAuth(), async (c) => {
    const sess = c.get('session');
    if (!sess) throw ApiError.unauthenticated();
    const id = c.req.param('id');
    const rows = await deps.repos.identity.listSessionsForUser(sess.userId);
    if (!rows.some((r) => r.id === id)) throw ApiError.notFound('Session');
    await deps.repos.identity.revokeSession(id);
    return c.json({ ok: true as const });
  });

  /* ---------------------------------------------------------------------- */
  /* Email verification, password reset, magic link                         */
  /* ---------------------------------------------------------------------- */

  app.post('/verify-email', validateJson(VerifyEmailRequest), async (c) => {
    const input = body<typeof VerifyEmailRequest._output>(c);
    const token = await deps.repos.identity.consumeAuthToken(
      await sha256Hex(input.token),
      'email_verify',
    );
    if (!token?.userId) {
      throw ApiError.badRequest('That verification link has expired or has already been used.');
    }
    await deps.repos.identity.markEmailVerified(token.userId);
    return c.json({ ok: true as const });
  });

  app.post('/forgot-password', validateJson(ForgotPasswordRequest), async (c) => {
    const input = body<typeof ForgotPasswordRequest._output>(c);
    const limit = await deps.services.rateLimiter.check(
      RateLimitBuckets.passwordReset(input.email),
      5,
      3600,
    );
    if (!limit.allowed) throw ApiError.rateLimited(limit.retryAfterSeconds);

    const user = await deps.repos.identity.findUserByEmail(input.email);
    if (user) {
      const token = randomToken(32);
      await deps.repos.identity.createAuthToken({
        userId: user.id,
        email: user.email,
        kind: 'password_reset',
        tokenHash: await sha256Hex(token),
        ttlMinutes: RESET_TTL_MINUTES,
      });
      await deps.services.email.send({
        to: user.email,
        ...EmailTemplates.resetPassword({
          fullName: user.fullName,
          url: `${deps.env.PUBLIC_APP_URL}/reset-password?token=${encodeURIComponent(token)}`,
          expiresInMinutes: RESET_TTL_MINUTES,
        }),
      });
    }

    // Identical response either way: a reset form must not become an account oracle.
    return c.json({ ok: true as const });
  });

  app.post('/reset-password', validateJson(ResetPasswordRequest), async (c) => {
    const input = body<typeof ResetPasswordRequest._output>(c);
    const token = await deps.repos.identity.consumeAuthToken(
      await sha256Hex(input.token),
      'password_reset',
    );
    if (!token?.userId) {
      throw ApiError.badRequest('That reset link has expired or has already been used.');
    }

    const user = await deps.repos.identity.findUserById(token.userId);
    if (!user) throw ApiError.badRequest('That reset link is no longer valid.');

    const strength = checkPasswordStrength(input.password, {
      email: user.email,
      fullName: user.fullName,
    });
    if (!strength.ok) {
      throw ApiError.badRequest('Choose a stronger password.', { password: strength.reasons });
    }

    await deps.repos.identity.updateUser(user.id, {
      passwordHash: await hashPassword(input.password),
      failedLoginCount: 0,
      lockedUntil: null,
    });

    // Every existing session is revoked: a password reset is the standard response to a
    // suspected compromise, so leaving other devices signed in would defeat its purpose.
    const revoked = await deps.repos.identity.revokeAllSessionsForUser(user.id);

    await deps.repos.audit.record({
      organizationId: 'unknown',
      workspaceId: null,
      actorUserId: user.id,
      actorName: user.fullName,
      action: 'auth.password.reset',
      category: 'auth',
      ipAddress: clientIp(c),
      userAgent: userAgent(c),
      traceId: c.get('traceId') ?? 'unknown',
      summary: `Password reset completed; ${revoked} session(s) revoked.`,
    });

    return c.json({ ok: true as const });
  });

  app.post('/magic-link', validateJson(MagicLinkRequest), async (c) => {
    const input = body<typeof MagicLinkRequest._output>(c);
    const limit = await deps.services.rateLimiter.check(
      RateLimitBuckets.passwordReset(input.email),
      5,
      3600,
    );
    if (!limit.allowed) throw ApiError.rateLimited(limit.retryAfterSeconds);

    const user = await deps.repos.identity.findUserByEmail(input.email);
    if (user) {
      const token = randomToken(32);
      await deps.repos.identity.createAuthToken({
        userId: user.id,
        email: user.email,
        kind: 'magic_link',
        tokenHash: await sha256Hex(token),
        ttlMinutes: MAGIC_LINK_TTL_MINUTES,
      });
      await deps.services.email.send({
        to: user.email,
        ...EmailTemplates.magicLink({
          url: `${deps.env.PUBLIC_APP_URL}/magic-link?token=${encodeURIComponent(token)}`,
          expiresInMinutes: MAGIC_LINK_TTL_MINUTES,
        }),
      });
    }
    return c.json({ ok: true as const });
  });

  app.post('/magic-link/consume', async (c) => {
    const input = (await c.req.json()) as { token?: string };
    if (!input.token) throw ApiError.badRequest('That link is missing its token.');

    const token = await deps.repos.identity.consumeAuthToken(
      await sha256Hex(input.token),
      'magic_link',
    );
    if (!token?.userId) throw ApiError.badRequest('That link has expired or has already been used.');

    const user = await deps.repos.identity.findUserById(token.userId);
    if (!user) throw ApiError.badRequest('That link is no longer valid.');

    // A working magic link proves control of the mailbox, so it also verifies the address.
    if (!user.emailVerifiedAt) await deps.repos.identity.markEmailVerified(user.id);

    const workspaces = await deps.repos.identity.listWorkspacesForUser(user.id);
    const session = await issueSession(deps, c, user, workspaces[0]?.id ?? null, false, true);
    return c.json({ status: 'authenticated' as const, session });
  });

  return app;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A fixed hash with the same cost as a real one. Comparing against this for unknown
 * accounts keeps sign-in timing flat whether or not the address exists.
 */
const DUMMY_HASH =
  'pbkdf2-sha512$600000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

async function issueSession(
  deps: AppDeps,
  c: Context<AppBindings>,
  user: { id: string; email: string; fullName: string; avatarUrl: string | null; title: string | null; locale: string; theme: string; emailVerifiedAt: Date | null; createdAt: Date },
  workspaceId: string | null,
  rememberMe: boolean,
  mfaSatisfied: boolean,
): Promise<SessionResponse> {
  const secure = deps.env.PUBLIC_API_URL.startsWith('https://') || isProduction(deps.env);
  const security = await securityFor(deps, workspaceId);
  const lifetime = sessionLifetime({
    rememberMe,
    policyIdleMinutes: security.sessionIdleMinutes,
    policyAbsoluteHours: security.sessionAbsoluteHours,
  });

  const minted = await createSessionToken();
  const session = await deps.repos.identity.createSession({
    userId: user.id,
    tokenHash: minted.tokenHash,
    csrfSecret: minted.csrfSecret,
    activeWorkspaceId: workspaceId,
    ipAddress: clientIp(c),
    userAgent: userAgent(c),
    rememberMe,
    mfaSatisfied,
    idleMinutes: lifetime.idleMinutes,
    absoluteHours: lifetime.absoluteHours,
  });

  const maxAge = Math.floor((session.absoluteExpiresAt.getTime() - Date.now()) / 1000);
  c.header('set-cookie', serializeSessionCookie(minted.token, { secure, maxAgeSeconds: maxAge }), {
    append: true,
  });
  c.header('set-cookie', serializeCsrfCookie(minted.csrfToken, { secure, maxAgeSeconds: maxAge }), {
    append: true,
  });

  return buildSessionResponse(deps, {
    sessionId: session.id,
    userId: user.id,
    csrfSecret: minted.csrfSecret,
    mfaSatisfied,
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      avatarUrl: user.avatarUrl,
      title: user.title,
      locale: user.locale,
      theme: user.theme,
      emailVerified: user.emailVerifiedAt !== null,
      createdAt: user.createdAt,
    },
  });
}

export async function buildSessionResponse(
  deps: AppDeps,
  sess: RequestSession,
): Promise<SessionResponse> {
  const workspaces = await deps.repos.identity.listWorkspacesForUser(sess.userId);
  const sessions = await deps.repos.identity.listSessionsForUser(sess.userId);
  const active = sessions.find((s) => s.id === sess.sessionId);
  const current =
    workspaces.find((w) => w.id === active?.activeWorkspaceId) ?? workspaces[0] ?? null;

  return {
    user: {
      id: sess.user.id,
      email: sess.user.email,
      fullName: sess.user.fullName,
      avatarUrl: sess.user.avatarUrl,
      title: sess.user.title,
      locale: sess.user.locale as 'en' | 'ja',
      theme: sess.user.theme as 'light' | 'dark' | 'system',
      emailVerified: sess.user.emailVerified,
      mfaEnabled: (await deps.repos.identity.listActiveFactors(sess.userId)).some(
        (f) => f.kind !== 'recovery',
      ),
      createdAt: sess.user.createdAt.toISOString(),
    },
    workspace: current
      ? {
          id: current.id,
          organizationId: current.organizationId,
          name: current.name,
          slug: current.slug,
          role: current.role as Role,
          isDefault: current.isDefault,
        }
      : null,
    workspaces: workspaces.map((w) => ({
      id: w.id,
      organizationId: w.organizationId,
      name: w.name,
      slug: w.slug,
      role: w.role as Role,
      isDefault: w.isDefault,
    })),
    permissions: current ? [...permissionsForRole(current.role as Role)] : [],
    csrfToken: await deriveCsrfToken(sess.csrfSecret),
    expiresAt: (active?.expiresAt ?? new Date(Date.now() + 3600_000)).toISOString(),
  };
}

async function securityFor(deps: AppDeps, workspaceId: string | null) {
  if (!workspaceId) return { sessionIdleMinutes: 480, sessionAbsoluteHours: 720, mfaPolicy: 'optional' as MfaPolicy };
  const workspace = await deps.repos.identity.getWorkspace(workspaceId);
  const settings = workspaceSettingsFrom(workspace?.settings ?? {}, workspace?.name ?? 'Workspace');
  return {
    sessionIdleMinutes: settings.security.sessionIdleMinutes,
    sessionAbsoluteHours: settings.security.sessionAbsoluteHours,
    mfaPolicy: settings.security.mfaPolicy,
  };
}

async function mfaPolicyFor(deps: AppDeps, workspaceId: string | null): Promise<MfaPolicy> {
  return (await securityFor(deps, workspaceId)).mfaPolicy;
}

async function verifyAnyFactor(
  deps: AppDeps,
  factors: Array<{ id: string; kind: string; secretEncrypted: string | null; recoveryHashes: string[] }>,
  code: string,
): Promise<boolean> {
  for (const factor of factors) {
    if (factor.kind === 'totp' && factor.secretEncrypted) {
      const secret = await decryptSecret(factor.secretEncrypted, deps.env.ENCRYPTION_KEY);
      if (await verifyTotp(secret, code)) {
        await deps.repos.identity.touchFactor(factor.id);
        return true;
      }
    }
    if (factor.recoveryHashes.length > 0) {
      const hash = await sha256Hex(normalizeRecoveryCode(code));
      if (factor.recoveryHashes.includes(hash)) {
        // Recovery codes are single use; the used one is removed immediately.
        await deps.repos.identity.consumeRecoveryCode(
          factor.id,
          factor.recoveryHashes.filter((h) => h !== hash),
        );
        return true;
      }
    }
  }
  return false;
}

async function sendVerificationEmail(deps: AppDeps, userId: string, email: string, fullName: string) {
  const token = randomToken(32);
  await deps.repos.identity.createAuthToken({
    userId,
    email,
    kind: 'email_verify',
    tokenHash: await sha256Hex(token),
    ttlMinutes: VERIFY_TTL_HOURS * 60,
  });
  await deps.services.email.send({
    to: email,
    ...EmailTemplates.verifyEmail({
      fullName,
      url: `${deps.env.PUBLIC_APP_URL}/verify-email?token=${encodeURIComponent(token)}`,
      expiresInHours: VERIFY_TTL_HOURS,
    }),
  });
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'workspace'
  );
}

export { newId, parseCookies, hashSessionToken, mustEnrollMfa };
