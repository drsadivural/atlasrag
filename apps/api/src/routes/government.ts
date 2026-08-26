import { Hono } from 'hono';
import { buildAuthorizationRequest, exchangeCode, fetchProfile, sha256Hex } from '@uxe/auth';
import type { AppBindings, AppDeps } from '../context.js';
import { ApiError } from '../errors.js';
import { clientIp, userAgent } from '../middleware/index.js';
import { allowedGovernmentDomains, allowedSsoTenants, uaePassConfig, type AppEnv } from '../env.js';
import {
  buildUaePassAuthorization,
  exchangeUaePassCode,
  fetchUaePassProfile,
  isAllowedGovernmentEmail,
  readIdTokenClaims,
  UaePassError,
} from '../services/uae-pass.js';
import { issueSession } from './auth.js';

/**
 * Government Edition authentication.
 *
 * Two federated routes and the configuration the sign-in screen needs to render honestly.
 *
 * The rule that shapes all of it: **this screen never creates an account**. Access is
 * provisioned by an entity administrator, so a federated identity that does not already
 * correspond to a provisioned user is refused — politely, in the same words as any other
 * refusal, and recorded in the audit log. An identity provider proving who somebody is
 * does not decide whether they are allowed in here.
 */
export function governmentRoutes(deps: AppDeps) {
  const app = new Hono<AppBindings>();

  /**
   * What the sign-in screen may show.
   *
   * Availability is reported rather than inferred by the browser, because the browser
   * must never see enough of a provider's configuration to infer anything. No client id,
   * no endpoint, no secret — only whether the button works and, when it does not, which
   * variables an administrator has to set.
   */
  app.get('/config', (c) => {
    const uaePass = uaePassConfig(deps.env);
    const ssoConfigured = Boolean(
      deps.env.MICROSOFT_OAUTH_CLIENT_ID && deps.env.MICROSOFT_OAUTH_CLIENT_SECRET,
    );

    return c.json({
      uaePass: {
        available: uaePass !== null,
        environment: uaePass?.environment ?? deps.env.UAE_PASS_ENVIRONMENT,
        requiredEnv: uaePass
          ? []
          : [
              'UAE_PASS_ISSUER',
              'UAE_PASS_AUTHORIZATION_ENDPOINT',
              'UAE_PASS_TOKEN_ENDPOINT',
              'UAE_PASS_USERINFO_ENDPOINT',
              'UAE_PASS_CLIENT_ID',
              'UAE_PASS_CLIENT_SECRET',
            ],
      },
      sso: {
        available: ssoConfigured,
        requiredEnv: ssoConfigured
          ? []
          : ['MICROSOFT_OAUTH_CLIENT_ID', 'MICROSOFT_OAUTH_CLIENT_SECRET'],
      },
      // Only stated when the deployment says it is true. An unverified instance claims
      // less rather than printing a compliance line it cannot stand behind.
      dataResidency: deps.env.GOV_DATA_RESIDENCY_STATEMENT === 'true',
      allowedDomains: allowedGovernmentDomains(deps.env),
      links: {
        privacy: deps.env.GOV_URL_PRIVACY,
        security: deps.env.GOV_URL_SECURITY,
        accessibility: deps.env.GOV_URL_ACCESSIBILITY,
        support: deps.env.GOV_URL_SUPPORT,
        status: deps.env.GOV_URL_STATUS,
        incident: deps.env.GOV_URL_INCIDENT,
        uaePassHelp: deps.env.GOV_URL_UAE_PASS_HELP,
        ssoHelp: deps.env.GOV_URL_SSO_HELP,
      },
    });
  });

  /* --- UAE PASS ---------------------------------------------------------- */

  app.post('/uae-pass/start', async (c) => {
    const config = uaePassConfig(deps.env);
    if (!config) throw unconfigured('UAE PASS', 'uae_pass');

    const request = await buildUaePassAuthorization(config, uaePassRedirect(deps.env));
    await deps.repos.identity.createAuthToken({
      userId: null,
      email: null,
      kind: 'gov_oidc_state',
      tokenHash: await sha256Hex(request.state),
      ttlMinutes: 10,
      metadata: {
        provider: 'uae_pass',
        codeVerifier: request.codeVerifier,
        nonce: request.nonce,
      },
    });

    return c.json({ url: request.url });
  });

  app.get('/uae-pass/callback', async (c) => {
    const url = new URL(c.req.url);
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const fail = (reason: string) => failure(deps, c, reason);

    const config = uaePassConfig(deps.env);
    if (!config) return fail('not_configured');
    if (!state) return fail('invalid_state');
    if (url.searchParams.get('error')) return fail('cancelled');
    if (!code) return fail('invalid_state');

    // Single use: a replayed callback finds nothing to consume and cannot mint a session.
    const stored = await deps.repos.identity.consumeAuthToken(
      await sha256Hex(state),
      'gov_oidc_state',
    );
    const metadata = (stored?.metadata ?? {}) as {
      provider?: string;
      codeVerifier?: string;
      nonce?: string;
    };
    if (!stored || metadata.provider !== 'uae_pass' || !metadata.codeVerifier) {
      return fail('invalid_state');
    }

    try {
      const tokens = await exchangeUaePassCode(
        config,
        uaePassRedirect(deps.env),
        code,
        metadata.codeVerifier,
      );

      if (tokens.idToken) {
        const claims = readIdTokenClaims(tokens.idToken);
        // The nonce this server issued must come back unchanged, and the token must come
        // from the issuer this deployment was configured with.
        if (metadata.nonce && claims.nonce !== metadata.nonce) return fail('invalid_nonce');
        if (typeof claims.iss === 'string' && claims.iss !== config.issuer) {
          return fail('invalid_issuer');
        }
        if (claims.aud !== undefined) {
          const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
          if (!audiences.includes(config.clientId)) return fail('invalid_audience');
        }
      }

      const profile = await fetchUaePassProfile(config, tokens.accessToken);
      return await completeFederatedSignIn(deps, c, {
        provider: 'uae_pass',
        email: profile.email,
        subject: profile.subject,
      });
    } catch (error) {
      deps.logger.warn('gov.uae_pass_failed', {
        reason: error instanceof UaePassError ? error.reason : 'unknown',
      });
      return fail(error instanceof UaePassError ? error.reason : 'exchange_failed');
    }
  });

  /* --- Government SSO ---------------------------------------------------- */

  app.post('/sso/start', async (c) => {
    if (!deps.env.MICROSOFT_OAUTH_CLIENT_ID || !deps.env.MICROSOFT_OAUTH_CLIENT_SECRET) {
      throw unconfigured('Government SSO', 'gov_sso');
    }

    const request = await buildAuthorizationRequest('microsoft', ssoConfig(deps.env), {
      offlineAccess: false,
    });
    await deps.repos.identity.createAuthToken({
      userId: null,
      email: null,
      kind: 'gov_oidc_state',
      tokenHash: await sha256Hex(request.state),
      ttlMinutes: 10,
      metadata: {
        provider: 'gov_sso',
        codeVerifier: request.codeVerifier,
        nonce: request.nonce,
      },
    });

    return c.json({ url: request.url });
  });

  app.get('/sso/callback', async (c) => {
    const url = new URL(c.req.url);
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const fail = (reason: string) => failure(deps, c, reason);

    if (!deps.env.MICROSOFT_OAUTH_CLIENT_ID) return fail('not_configured');
    if (!state) return fail('invalid_state');
    if (url.searchParams.get('error')) return fail('cancelled');
    if (!code) return fail('invalid_state');

    const stored = await deps.repos.identity.consumeAuthToken(
      await sha256Hex(state),
      'gov_oidc_state',
    );
    const metadata = (stored?.metadata ?? {}) as { provider?: string; codeVerifier?: string };
    if (!stored || metadata.provider !== 'gov_sso' || !metadata.codeVerifier) {
      return fail('invalid_state');
    }

    try {
      const tokens = await exchangeCode(
        'microsoft',
        ssoConfig(deps.env),
        code,
        metadata.codeVerifier,
      );

      const tenants = allowedSsoTenants(deps.env);
      if (tenants.length > 0 && tokens.idToken) {
        // Tenant is the directory the identity came from. Without this check any Entra
        // account anywhere would satisfy a "government SSO" button.
        const claims = readIdTokenClaims(tokens.idToken);
        const tenantId = typeof claims.tid === 'string' ? claims.tid : null;
        if (!tenantId || !tenants.includes(tenantId)) return fail('tenant_not_allowed');
      }

      const profile = await fetchProfile('microsoft', ssoConfig(deps.env), tokens.accessToken);
      return await completeFederatedSignIn(deps, c, {
        provider: 'gov_sso',
        email: profile.email,
        subject: profile.providerAccountId,
      });
    } catch (error) {
      deps.logger.warn('gov.sso_failed', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      return fail('exchange_failed');
    }
  });

  return app;
}

/* -------------------------------------------------------------------------- */

/**
 * Turns a proven federated identity into a session — but only for somebody who already
 * has an account here.
 *
 * Every refusal below redirects with the same generic reason. Which of them applied —
 * no address, wrong domain, no such user, suspended — is recorded in the audit log and
 * never told to the browser, because the difference between them is exactly the
 * information an attacker would want.
 */
async function completeFederatedSignIn(
  deps: AppDeps,
  c: Parameters<typeof issueSession>[1],
  input: { provider: string; email: string | null; subject: string },
): Promise<Response> {
  /**
   * A refusal before a user is known has no tenant to file an audit row against, so it is
   * recorded as a structured security event instead. Once a user and workspace resolve,
   * the success is written to the tenant's own audit log where an administrator will look
   * for it. Neither carries the identity provider's subject or any national identifier.
   */
  const refuse = (outcome: string, email: string | null): Response => {
    deps.logger.warn('gov.sign_in_refused', {
      provider: input.provider,
      outcome,
      emailDomain: email?.split('@')[1] ?? null,
      ipAddress: clientIp(c),
    });
    return failure(deps, c, 'not_provisioned');
  };

  if (!input.email) return refuse('no_email', null);

  const domains = allowedGovernmentDomains(deps.env);
  if (!isAllowedGovernmentEmail(input.email, domains))
    return refuse('domain_not_allowed', input.email);

  const user = await deps.repos.identity.findUserByEmail(input.email);
  if (!user || user.status !== 'active') return refuse('not_provisioned', input.email);

  const workspaces = await deps.repos.identity.listWorkspacesForUser(user.id);
  const primary = workspaces[0];
  if (!primary) return refuse('no_workspace', input.email);

  if (!user.emailVerifiedAt) await deps.repos.identity.markEmailVerified(user.id);

  // A federated identity provider has already done the second factor, so the session is
  // minted as MFA-satisfied; `rememberMe` is false because this browser made no such
  // request — the checkbox belongs to the password form.
  await issueSession(deps, c, user, primary.id, false, true);

  await deps.repos.audit.record({
    organizationId: primary.organizationId,
    workspaceId: primary.id,
    actorUserId: user.id,
    actorName: user.fullName,
    action: `auth.${input.provider}`,
    category: 'auth',
    targetType: 'user',
    targetId: user.id,
    targetLabel: user.email,
    ipAddress: clientIp(c),
    userAgent: userAgent(c),
    traceId: c.get('traceId') ?? 'gov-callback',
    summary: `${user.fullName} signed in with ${input.provider === 'uae_pass' ? 'UAE PASS' : 'Government SSO'}.`,
  });

  return c.redirect(`${deps.env.PUBLIC_APP_URL}${deps.env.GOV_POST_LOGIN_ROUTE}`, 302);
}

function failure(deps: AppDeps, c: Parameters<typeof issueSession>[1], reason: string): Response {
  return c.redirect(
    `${deps.env.PUBLIC_APP_URL}/login?sso=failed&reason=${encodeURIComponent(reason)}`,
    302,
  );
}

function unconfigured(label: string, key: string): ApiError {
  return new ApiError(
    400,
    'provider_unconfigured',
    `${label} has not been configured for this deployment.`,
    { details: { provider: key } },
  );
}

function uaePassRedirect(env: AppEnv): string {
  return `${env.PUBLIC_API_URL}/api/v1/auth/government/uae-pass/callback`;
}

function ssoConfig(env: AppEnv) {
  return {
    clientId: env.MICROSOFT_OAUTH_CLIENT_ID,
    clientSecret: env.MICROSOFT_OAUTH_CLIENT_SECRET,
    redirectUri: `${env.PUBLIC_API_URL}/api/v1/auth/government/sso/callback`,
    ...(env.MICROSOFT_OAUTH_TENANT ? { tenant: env.MICROSOFT_OAUTH_TENANT } : {}),
  };
}
