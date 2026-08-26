import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  assertDomainAllowed,
  buildAuthorizationRequest,
  exchangeCode,
  fetchProfile,
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
  AcceptInvitationRequest,
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
import { isProduction, requiresEmailVerification } from '../env.js';
import { defaultWorkspaceSettings, workspaceSettingsFrom } from '../services/settings.js';
import type { OAuthConfig, OAuthProvider } from '@uxe/auth';

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

    const mustVerify = requiresEmailVerification(deps.env);
    const status = mustVerify ? 'email_verification_required' : 'registered';

    const existing = await deps.repos.identity.findUserByEmail(input.email);
    if (existing) {
      // Registering an existing address must not confirm that it exists. The response is
      // identical to a success, and the account holder gets an email instead.
      await sendVerificationEmail(deps, existing.id, existing.email, existing.fullName);
      // Same status as the success path, not only the same body: a different status code
      // is an enumeration oracle on its own. That holds whether or not confirmation is
      // required — the caller must not be able to tell the two branches apart, so no
      // session is minted here even when one would be harmless.
      return c.json({ status, email: input.email }, 201);
    }

    const user = await deps.repos.identity.createUser({
      email: input.email,
      passwordHash: await hashPassword(input.password),
      fullName: input.fullName,
      locale: input.locale,
    });

    if (!mustVerify) await deps.repos.identity.markEmailVerified(user.id);

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

    if (mustVerify) await sendVerificationEmail(deps, user.id, user.email, user.fullName);
    return c.json({ status, email: user.email }, 201);
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

    if (!user.emailVerifiedAt && requiresEmailVerification(deps.env)) {
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

    if (
      requiresMfa({ policy, role: (primary?.role ?? 'member') as Role, hasActiveFactor: hasFactor })
    ) {
      if (!hasFactor) {
        // Policy demands MFA but the user has none: route into enrolment rather than
        // locking them out of their own workspace.
        const session = await issueSession(
          deps,
          c,
          user,
          primary?.id ?? null,
          input.rememberMe,
          true,
        );
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

  app.post('/mfa/verify', validateJson(MfaVerifyRequest), async (c) => {
    // The body has already been read by the validator; re-reading the raw request throws.
    const input = body<typeof MfaVerifyRequest._output>(c);
    const challengeToken = input.challengeToken;

    const token = await deps.repos.identity.findAuthToken(
      await sha256Hex(challengeToken),
      'mfa_challenge',
    );
    if (!token || token.id !== input.challengeId || !token.userId) {
      throw new ApiError(401, 'unauthenticated', 'That challenge has expired. Sign in again.');
    }

    const limit = await deps.services.rateLimiter.check(
      RateLimitBuckets.mfaByUser(token.userId),
      8,
      900,
    );
    if (!limit.allowed) throw ApiError.rateLimited(limit.retryAfterSeconds);

    const user = await deps.repos.identity.findUserById(token.userId);
    if (!user) throw new ApiError(401, 'unauthenticated', 'That challenge is no longer valid.');

    const factors = await deps.repos.identity.listActiveFactors(user.id);
    const verified = await verifyAnyFactor(deps, factors, input.code);
    if (!verified) {
      throw new ApiError(
        401,
        'unauthenticated',
        'That code is not valid. Check your authenticator and try again.',
      );
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
      throw ApiError.badRequest(
        'That code is not valid. Check the time on your device and try again.',
        {
          code: ['Incorrect code'],
        },
      );
    }

    const recoveryCodes = generateRecoveryCodes(10);
    const hashes = await Promise.all(
      recoveryCodes.map((code) => sha256Hex(normalizeRecoveryCode(code))),
    );
    await deps.repos.identity.activateFactor(factor.id, hashes);

    return c.json({ ok: true as const, recoveryCodes });
  });

  /* ---------------------------------------------------------------------- */
  /* OAuth                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Starts an OAuth authorization-code flow with PKCE.
   *
   * The `state` and `code_verifier` are stored server-side as a short-lived, single-use
   * token and only their hash reaches the database, so a callback that does not match the
   * request this browser started cannot be replayed.
   */
  app.post('/oauth/:provider/start', async (c) => {
    const provider = c.req.param('provider');
    if (provider !== 'google' && provider !== 'microsoft') throw ApiError.notFound('Provider');

    const config = oauthConfigFor(deps, provider);
    if (!config) {
      throw new ApiError(
        400,
        'provider_unconfigured',
        `${provider === 'google' ? 'Google' : 'Microsoft'} sign-in is not configured for this deployment. An administrator needs to add the OAuth client ID and secret.`,
        {
          details: {
            requiredEnv:
              provider === 'google'
                ? ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET']
                : ['MICROSOFT_OAUTH_CLIENT_ID', 'MICROSOFT_OAUTH_CLIENT_SECRET'],
          },
        },
      );
    }

    const request = await buildAuthorizationRequest(provider, config);
    await deps.repos.identity.createAuthToken({
      userId: null,
      email: null,
      kind: 'oauth_state',
      tokenHash: await sha256Hex(request.state),
      ttlMinutes: 10,
      metadata: { provider, codeVerifier: request.codeVerifier, nonce: request.nonce },
    });

    return c.json({ url: request.url });
  });

  app.get('/oauth/:provider/callback', async (c) => {
    const provider = c.req.param('provider');
    const failure = (reason: string) =>
      c.redirect(
        `${deps.env.PUBLIC_APP_URL}/login?sso=failed&reason=${encodeURIComponent(reason)}`,
        302,
      );

    if (provider !== 'google' && provider !== 'microsoft') return failure('unknown_provider');

    const config = oauthConfigFor(deps, provider);
    if (!config) return failure('not_configured');

    const url = new URL(c.req.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) return failure('missing_code');

    // Single-use: consuming the state here means a replayed callback cannot succeed.
    const stored = await deps.repos.identity.consumeAuthToken(
      await sha256Hex(state),
      'oauth_state',
    );
    if (!stored) return failure('invalid_state');

    const metadata = stored.metadata as { provider?: string; codeVerifier?: string };
    if (metadata.provider !== provider || !metadata.codeVerifier) return failure('invalid_state');

    try {
      const tokens = await exchangeCode(provider, config, code, metadata.codeVerifier);
      const profile = await fetchProfile(provider, config, tokens.accessToken);
      if (!profile.email) return failure('no_email');
      if (!profile.emailVerified) return failure('unverified_email');

      let account = await deps.repos.identity.findOAuthAccount(provider, profile.providerAccountId);
      let user = account ? await deps.repos.identity.findUserById(account.userId) : null;

      if (!user) {
        // Link by verified email when the address already has an account, so signing in
        // with Google after registering with a password reaches the same workspace.
        user = await deps.repos.identity.findUserByEmail(profile.email);
        if (!user) {
          user = await deps.repos.identity.createUser({
            email: profile.email,
            passwordHash: null,
            fullName: profile.fullName ?? profile.email.split('@')[0] ?? profile.email,
            emailVerified: true,
          });
        }
        account = await deps.repos.identity.linkOAuthAccount({
          userId: user.id,
          provider,
          providerAccountId: profile.providerAccountId,
          email: profile.email,
          refreshTokenEncrypted: tokens.refreshToken
            ? await encryptSecret(tokens.refreshToken, deps.env.ENCRYPTION_KEY)
            : null,
          scopes: tokens.scopes,
        });
      }

      if (!user.emailVerifiedAt) await deps.repos.identity.markEmailVerified(user.id);

      const workspaces = await deps.repos.identity.listWorkspacesForUser(user.id);
      const primary = workspaces[0];
      if (primary) {
        const workspace = await deps.repos.identity.getWorkspace(primary.id);
        const settings = workspaceSettingsFrom(workspace?.settings ?? {}, workspace?.name ?? '');
        try {
          assertDomainAllowed(profile.email, settings.security.allowedEmailDomains);
        } catch {
          return failure('domain_not_allowed');
        }
      }

      await issueSession(deps, c, user, primary?.id ?? null, true, true);
      return c.redirect(`${deps.env.PUBLIC_APP_URL}/dashboard`, 302);
    } catch (error) {
      deps.logger.warn('oauth.callback_failed', {
        provider,
        error: error instanceof Error ? error.message : 'unknown',
      });
      return failure('exchange_failed');
    }
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

  /* ---------------------------------------------------------------------- */
  /* Invitations                                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * Shows who is being invited, and to what, before anything is committed.
   *
   * Answering this without a session is safe: the token is the secret, it is stored only
   * as a hash, and the response says nothing an attacker could not already infer by
   * holding the invitation email.
   */
  app.get('/invitations/:token', async (c) => {
    const raw = c.req.param('token');
    if (!raw || raw.length < 20) throw ApiError.badRequest('That invitation link is not valid.');

    const invitation = await deps.repos.identity.findInvitation(await sha256Hex(raw));
    if (!invitation) {
      throw ApiError.badRequest('That invitation has expired or has already been used.');
    }

    const workspace = await deps.repos.identity.getWorkspace(invitation.workspaceId);
    const inviter = invitation.invitedByUserId
      ? await deps.repos.identity.findUserById(invitation.invitedByUserId)
      : null;
    const existing = await deps.repos.identity.findUserByEmail(invitation.email);

    return c.json({
      email: invitation.email,
      workspaceName: workspace?.name ?? 'the workspace',
      role: invitation.role,
      invitedByName: inviter?.fullName ?? 'A colleague',
      hasAccount: Boolean(existing?.passwordHash),
      message: invitation.message,
      expiresAt: invitation.expiresAt.toISOString(),
    });
  });

  /**
   * Accepts an invitation and signs the person in.
   *
   * Receiving the email proves control of the address, so the account is marked verified
   * here rather than sending a second round trip the user has no way to understand.
   */
  app.post('/invitations/accept', validateJson(AcceptInvitationRequest), async (c) => {
    const input = body<typeof AcceptInvitationRequest._output>(c);
    const ip = clientIp(c);

    const limit = await deps.services.rateLimiter.check(
      RateLimitBuckets.registration(ip),
      10,
      3600,
    );
    if (!limit.allowed) throw ApiError.rateLimited(limit.retryAfterSeconds);

    const invitation = await deps.repos.identity.findInvitation(await sha256Hex(input.token));
    if (!invitation) {
      throw ApiError.badRequest('That invitation has expired or has already been used.');
    }

    const user = await deps.repos.identity.findUserByEmail(invitation.email);
    if (!user) throw ApiError.badRequest('That invitation is no longer valid.');

    // A brand-new account must set a password; an existing one keeps the password it has.
    if (!user.passwordHash) {
      if (!input.password) {
        throw ApiError.badRequest('Choose a password to finish setting up your account.', {
          password: ['Required'],
        });
      }
      const strength = checkPasswordStrength(input.password, {
        email: user.email,
        fullName: input.fullName ?? user.fullName,
      });
      if (!strength.ok) {
        throw ApiError.badRequest('Choose a stronger password.', { password: strength.reasons });
      }
      await deps.repos.identity.updateUser(user.id, {
        passwordHash: await hashPassword(input.password),
        emailVerifiedAt: new Date(),
        ...(input.fullName ? { fullName: input.fullName } : {}),
      });
    } else if (input.fullName) {
      await deps.repos.identity.updateUser(user.id, { fullName: input.fullName });
    }

    await deps.repos.identity.activateInvitedMembership({
      workspaceId: invitation.workspaceId,
      userId: user.id,
      role: invitation.role,
      groupIds: invitation.groupIds,
    });
    await deps.repos.identity.acceptInvitation(invitation.id);

    const fresh = await deps.repos.identity.findUserById(user.id);
    if (!fresh) throw ApiError.badRequest('That invitation is no longer valid.');

    await deps.repos.audit.record({
      organizationId: invitation.organizationId,
      workspaceId: invitation.workspaceId,
      actorUserId: fresh.id,
      actorName: fresh.fullName,
      action: 'member.joined',
      category: 'permission',
      targetType: 'user',
      targetId: fresh.id,
      targetLabel: fresh.email,
      ipAddress: ip,
      userAgent: userAgent(c),
      traceId: c.get('traceId') ?? 'unknown',
      summary: `${fresh.fullName} accepted an invitation as ${invitation.role.replace(/_/g, ' ')}.`,
    });

    const session = await issueSession(deps, c, fresh, invitation.workspaceId, false, false);
    return c.json(session, 200);
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
    if (!token?.userId)
      throw ApiError.badRequest('That link has expired or has already been used.');

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
  user: {
    id: string;
    email: string;
    fullName: string;
    avatarUrl: string | null;
    title: string | null;
    locale: string;
    theme: string;
    emailVerifiedAt: Date | null;
    createdAt: Date;
  },
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
  if (!workspaceId)
    return {
      sessionIdleMinutes: 480,
      sessionAbsoluteHours: 720,
      mfaPolicy: 'optional' as MfaPolicy,
    };
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
  factors: Array<{
    id: string;
    kind: string;
    secretEncrypted: string | null;
    recoveryHashes: string[];
  }>,
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

async function sendVerificationEmail(
  deps: AppDeps,
  userId: string,
  email: string,
  fullName: string,
) {
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

/** Returns the OAuth configuration for a provider, or null when it is not configured. */
function oauthConfigFor(deps: AppDeps, provider: OAuthProvider): OAuthConfig | null {
  if (provider === 'google') {
    if (!deps.env.GOOGLE_OAUTH_CLIENT_ID || !deps.env.GOOGLE_OAUTH_CLIENT_SECRET) return null;
    return {
      clientId: deps.env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: deps.env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirectUri: `${deps.env.PUBLIC_API_URL}/api/v1/auth/oauth/google/callback`,
    };
  }
  if (!deps.env.MICROSOFT_OAUTH_CLIENT_ID || !deps.env.MICROSOFT_OAUTH_CLIENT_SECRET) return null;
  return {
    clientId: deps.env.MICROSOFT_OAUTH_CLIENT_ID,
    clientSecret: deps.env.MICROSOFT_OAUTH_CLIENT_SECRET,
    redirectUri: `${deps.env.PUBLIC_API_URL}/api/v1/auth/oauth/microsoft/callback`,
    tenant: deps.env.MICROSOFT_OAUTH_TENANT,
  };
}
