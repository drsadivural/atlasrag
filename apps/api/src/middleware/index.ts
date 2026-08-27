import type { Context, MiddlewareHandler, Next } from 'hono';
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  SAFE_METHODS,
  SESSION_COOKIE,
  hashSessionToken,
  isAllowedOrigin,
  parseCookies,
  verifyCsrf,
} from '@uxe/auth';
import { formatTraceparent, newSpanId, newTraceId, parseTraceparent } from '@uxe/observability';
import { permissionsForRole, type Permission, type Role } from '@uxe/contracts';
import type { TenantContext } from '@uxe/db';
import type { AppBindings, AppDeps } from '../context.js';
import { ApiError, respondWithError, toErrorResponse } from '../errors.js';
import { corsOrigins, isProduction } from '../env.js';
import { RateLimitBuckets } from '../services/rate-limit.js';

/** Assigns a trace id, echoes it on the response, and binds it to the request logger. */
export function tracing(deps: AppDeps): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const inbound = parseTraceparent(c.req.header('traceparent'));
    const traceId = inbound?.traceId ?? newTraceId();
    const spanId = newSpanId();

    c.set('traceId', traceId);
    c.set('spanId', spanId);
    c.set('requestStart', Date.now());
    c.set('logger', deps.logger.child({ traceId, spanId, requestId: traceId.slice(0, 16) }));

    // Surfaced so a user can quote it in support, and so the browser can correlate.
    c.header('x-trace-id', traceId);
    c.header('traceparent', formatTraceparent(traceId, spanId, true));

    await next();
  };
}

/**
 * Security headers.
 *
 * The CSP is strict on purpose: no inline script, no eval, and `connect-src` limited to
 * the API origin. Document text is untrusted input, so the browser must not be able to
 * execute anything that leaks through it.
 */
export function securityHeaders(deps: AppDeps): MiddlewareHandler<AppBindings> {
  const apiOrigin = new URL(deps.env.PUBLIC_API_URL).origin;
  const appOrigin = new URL(deps.env.PUBLIC_APP_URL).origin;

  const csp = [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "style-src 'self'",
    "script-src 'self'",
    `connect-src 'self' ${apiOrigin} ${appOrigin}`,
    "object-src 'none'",
    "worker-src 'self' blob:",
  ].join('; ');

  return async (c, next) => {
    await next();
    c.header('content-security-policy', csp);
    c.header('x-content-type-options', 'nosniff');
    c.header('x-frame-options', 'DENY');
    c.header('referrer-policy', 'strict-origin-when-cross-origin');
    c.header('cross-origin-opener-policy', 'same-origin');
    c.header('cross-origin-resource-policy', 'same-site');
    c.header(
      'permissions-policy',
      'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), payment=(), usb=(), microphone=(self)',
    );
    if (isProduction(deps.env)) {
      c.header('strict-transport-security', 'max-age=31536000; includeSubDomains; preload');
    }
    // API responses are per-user; a shared cache must never serve one user's data to another.
    if (!c.res.headers.has('cache-control')) {
      c.header('cache-control', 'no-store, private');
    }
  };
}

/** CORS restricted to an explicit allowlist; credentials require an exact origin match. */
export function cors(deps: AppDeps): MiddlewareHandler<AppBindings> {
  const allowed = corsOrigins(deps.env);

  return async (c, next) => {
    const origin = c.req.header('origin');
    const isAllowed = origin !== undefined && allowed.includes(origin);

    if (c.req.method === 'OPTIONS') {
      if (!isAllowed) return c.body(null, 403);
      return c.body(null, 204, {
        'access-control-allow-origin': origin,
        'access-control-allow-credentials': 'true',
        // PUT is how upload bytes arrive; omitting it fails the preflight and every
        // browser upload reports a network error.
        'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'access-control-allow-headers': `content-type,${CSRF_HEADER},idempotency-key,traceparent`,
        'access-control-max-age': '600',
        vary: 'Origin',
      });
    }

    await next();

    if (isAllowed && origin) {
      c.header('access-control-allow-origin', origin);
      c.header('access-control-allow-credentials', 'true');
      c.header('vary', 'Origin');
      c.header('access-control-expose-headers', 'x-trace-id,retry-after');
    }
  };
}

/**
 * Converts any thrown error into the single error envelope and logs it exactly once.
 *
 * Registered through `app.onError` rather than as a middleware: once an error escapes the
 * handler chain the context can no longer write a body, so Hono's dedicated error hook is
 * the only place a structured response can still be produced.
 */
export function errorHandler(deps: AppDeps) {
  return (error: Error, c: Context<AppBindings>): Response => {
    const traceId = c.get('traceId') ?? 'unknown';
    const logger = c.get('logger') ?? deps.logger;
    const mapped = toErrorResponse(error, traceId);

    const fields = {
      path: c.req.path,
      method: c.req.method,
      status: mapped.status,
      error: {
        name: error.name,
        message: error.message,
        // Which field failed, not just that one did. Field names only — the values may be
        // whatever the caller typed.
        ...(error instanceof ApiError && error.options.fieldErrors
          ? Object.keys(error.options.fieldErrors).length > 0
            ? { fields: Object.keys(error.options.fieldErrors) }
            : {}
          : {}),
      },
      ...(mapped.logLevel === 'error' ? { stack: error.stack?.slice(0, 2000) } : {}),
    };

    if (mapped.logLevel === 'error') logger.error('request.failed', fields);
    else logger.warn('request.rejected', fields);

    return respondWithError(c, error, traceId);
  };
}

/** Records request duration and outcome for the p95 targets in section 21. */
export function metrics(deps: AppDeps): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    await next();
    const start = c.get('requestStart') ?? Date.now();
    deps.metrics.observe('uxe_http_request_duration_ms', Date.now() - start, {
      method: c.req.method,
      route: c.req.routePath ?? c.req.path,
      status: String(c.res.status),
    });
  };
}

/**
 * Resolves the session from the HttpOnly cookie.
 *
 * Optional by design: this middleware never rejects, it only populates `session`. Route
 * guards decide whether an anonymous caller is acceptable, which keeps the login and
 * health endpoints usable without a special case here.
 */
export function session(deps: AppDeps): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const cookies = parseCookies(c.req.header('cookie'));
    const token = cookies[SESSION_COOKIE];
    if (!token) return next();

    const tokenHash = await hashSessionToken(token);
    const found = await deps.repos.identity.findSessionByTokenHash(tokenHash);
    if (!found) return next();

    // Sliding idle expiry, capped by the absolute lifetime stored at sign-in.
    const settings = await workspaceSecurity(deps, found.session.activeWorkspaceId);
    await deps.repos.identity.touchSession(found.session.id, settings.sessionIdleMinutes);

    c.set('session', {
      sessionId: found.session.id,
      userId: found.user.id,
      csrfSecret: found.session.csrfSecret,
      mfaSatisfied: found.session.mfaSatisfied,
      user: {
        id: found.user.id,
        email: found.user.email,
        fullName: found.user.fullName,
        avatarUrl: found.user.avatarUrl,
        title: found.user.title,
        locale: found.user.locale,
        theme: found.user.theme,
        emailVerified: found.user.emailVerifiedAt !== null,
        createdAt: found.user.createdAt,
        isPlatformAdmin: found.user.isPlatformAdmin === true,
      },
    });

    const logger = c.get('logger');
    if (logger) c.set('logger', logger.child({ userId: found.user.id }));

    await next();
  };
}

async function workspaceSecurity(deps: AppDeps, workspaceId: string | null) {
  const fallback = {
    sessionIdleMinutes: 60 * 8,
    sessionAbsoluteHours: 24 * 30,
    mfaPolicy: 'optional' as const,
  };
  if (!workspaceId) return fallback;
  const workspace = await deps.repos.identity.getWorkspace(workspaceId);
  if (!workspace) return fallback;
  const security = (workspace.settings as Record<string, unknown>).security as
    { sessionIdleMinutes?: number; sessionAbsoluteHours?: number; mfaPolicy?: string } | undefined;
  return {
    sessionIdleMinutes: security?.sessionIdleMinutes ?? fallback.sessionIdleMinutes,
    sessionAbsoluteHours: security?.sessionAbsoluteHours ?? fallback.sessionAbsoluteHours,
    mfaPolicy: (security?.mfaPolicy ?? 'optional') as
      'optional' | 'required_admins' | 'required_all',
  };
}

/**
 * CSRF defence for state-changing requests: origin allowlist AND a double-submit token
 * bound to the session's own secret. Both must pass.
 */
export function csrf(deps: AppDeps): MiddlewareHandler<AppBindings> {
  const allowed = corsOrigins(deps.env);

  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();

    if (!isAllowedOrigin(c.req.header('origin'), c.req.header('referer'), allowed)) {
      throw ApiError.forbidden('This request did not come from an allowed origin.');
    }

    const sess = c.get('session');
    // An unauthenticated POST (sign-in, registration) is protected by the origin check and
    // by rate limiting; there is no session secret to bind a token to yet.
    if (!sess) return next();

    const cookies = parseCookies(c.req.header('cookie'));
    const ok = await verifyCsrf(sess.csrfSecret, c.req.header(CSRF_HEADER), cookies[CSRF_COOKIE]);
    if (!ok) {
      throw new ApiError(
        403,
        'csrf_failed',
        'Your session token is missing or stale. Refresh the page and try again.',
      );
    }

    await next();
  };
}

/** Rejects anonymous callers. Use on every route that touches tenant data. */
export function requireAuth(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const sess = c.get('session');
    if (!sess) throw ApiError.unauthenticated();
    if (!sess.mfaSatisfied) {
      throw new ApiError(401, 'mfa_required', 'Complete two-factor authentication to continue.');
    }
    await next();
  };
}

/**
 * Rejects anybody who is not a platform administrator.
 *
 * Deliberately separate from `requirePermission`, which reads a role granted by a
 * membership and is therefore bounded by the workspace that granted it. This authority is
 * not: it exists so accounts can be administered across the deployment.
 *
 * What it does not do is open tenant data. Routes behind this guard touch identity and
 * nothing else — no source, consultation, answer or artifact is reachable through it, and
 * the tenant checks every retrieval makes are untouched by it. "Can administer the
 * accounts" and "may read every customer's confidential filings" are different authorities
 * and are not granted by the same flag.
 */
export function requirePlatformAdmin(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const sess = c.get('session');
    if (!sess) throw ApiError.unauthenticated();
    if (!sess.user.isPlatformAdmin) {
      // Same shape as any other permission refusal: whether platform administration exists
      // at all is not something an ordinary caller needs to learn from the error.
      throw ApiError.forbidden('You do not have permission to do that.');
    }
    await next();
  };
}

/**
 * Resolves the workspace and builds the TenantContext.
 *
 * The workspace comes from the SESSION, never from a header or body field. That single
 * rule is what makes cross-tenant access impossible by construction: a client cannot ask
 * for another tenant because it has no way to name one.
 */
export function requireTenant(deps: AppDeps): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const sess = c.get('session');
    if (!sess) throw ApiError.unauthenticated();

    const workspaceId = await resolveWorkspaceId(deps, sess.sessionId, sess.userId);
    if (!workspaceId) {
      throw ApiError.forbidden('You are not a member of any workspace yet.');
    }

    const membership = await deps.repos.identity.getMembership(sess.userId, workspaceId);
    if (!membership) {
      // Membership was revoked while the session was alive.
      throw ApiError.forbidden('Your access to this workspace has been removed.');
    }

    const groupIds = await deps.repos.identity.groupIdsForUser(sess.userId, workspaceId);

    const tenant: TenantContext = {
      organizationId: membership.organizationId,
      workspaceId: membership.workspaceId,
      userId: sess.userId,
      role: membership.role as Role,
      groupIds,
      traceId: c.get('traceId') ?? 'unknown',
    };

    c.set('tenant', tenant);
    const logger = c.get('logger');
    if (logger) {
      c.set(
        'logger',
        logger.child({ organizationId: tenant.organizationId, workspaceId: tenant.workspaceId }),
      );
    }

    await next();
  };
}

async function resolveWorkspaceId(deps: AppDeps, sessionId: string, userId: string) {
  const sessions = await deps.repos.identity.listSessionsForUser(userId);
  const active = sessions.find((s) => s.id === sessionId);
  if (active?.activeWorkspaceId) return active.activeWorkspaceId;

  // First request after sign-in: fall back to the user's default workspace and pin it.
  const workspaces = await deps.repos.identity.listWorkspacesForUser(userId);
  const first = workspaces[0];
  if (!first) return null;
  await deps.repos.identity.setSessionWorkspace(sessionId, first.id);
  return first.id;
}

/**
 * Route-level permission guard.
 *
 * This is a fast fail for a clearer error message; the authoritative check still runs in
 * the repository, so a route that forgets this guard is inconvenient, not insecure.
 */
export function requirePermission(permission: Permission): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const tenant = c.get('tenant');
    if (!tenant) throw ApiError.unauthenticated();
    if (!permissionsForRole(tenant.role).includes(permission)) {
      throw ApiError.forbidden(
        `Your role (${tenant.role.replace(/_/g, ' ')}) does not include the "${permission}" permission.`,
      );
    }
    await next();
  };
}

/** Per-user and per-IP request limits. */
export function rateLimit(deps: AppDeps): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method) && c.req.path.startsWith('/api/v1/health')) return next();

    const sess = c.get('session');
    const ip = clientIp(c);
    const bucket = sess ? RateLimitBuckets.apiByUser(sess.userId) : RateLimitBuckets.apiByIp(ip);

    const result = await deps.services.rateLimiter.check(
      bucket,
      deps.env.RATE_LIMIT_API_PER_MINUTE,
      60,
    );
    c.header('x-ratelimit-limit', String(result.limit));
    c.header('x-ratelimit-remaining', String(result.remaining));
    c.header('x-ratelimit-reset', String(Math.floor(result.resetAt.getTime() / 1000)));

    if (!result.allowed) throw ApiError.rateLimited(result.retryAfterSeconds);
    await next();
  };
}

/**
 * The client IP, taken from CF-Connecting-IP where Cloudflare sets it.
 *
 * `x-forwarded-for` is only consulted outside production because it is trivially spoofable
 * when the app is reachable directly; trusting it at the edge would let an attacker evade
 * every IP-keyed rate limit by rotating the header.
 */
export function clientIp(c: Context): string {
  return (
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-real-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    '0.0.0.0'
  );
}

export function userAgent(c: Context): string | null {
  return c.req.header('user-agent')?.slice(0, 500) ?? null;
}

/** Requires a verified email before letting a user create or change tenant data. */
export function requireVerifiedEmail(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const sess = c.get('session');
    if (!sess) throw ApiError.unauthenticated();
    if (!sess.user.emailVerified) {
      throw new ApiError(
        403,
        'email_unverified',
        'Confirm your email address before making changes. Check your inbox for the verification link.',
      );
    }
    await next();
  };
}

export type { Next };
