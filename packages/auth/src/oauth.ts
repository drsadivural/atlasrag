import { randomToken, sha256Hex, toBase64Url } from './crypto.js';

/**
 * OAuth 2.0 Authorization Code flow with PKCE for Google and Microsoft.
 *
 * PKCE is used even though this is a confidential client, because it also defeats
 * authorization-code injection. `state` is bound to the browser through a short-lived
 * signed cookie, so a code delivered to the callback that does not match the state this
 * browser started with is rejected.
 */

export type OAuthProvider = 'google' | 'microsoft';

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Microsoft only: `common`, `organizations`, or a specific tenant id. */
  tenant?: string;
}

export interface OAuthProfile {
  providerAccountId: string;
  email: string | null;
  emailVerified: boolean;
  fullName: string | null;
  avatarUrl: string | null;
}

export interface AuthorizationRequest {
  url: string;
  state: string;
  codeVerifier: string;
  nonce: string;
}

const ENDPOINTS: Record<
  OAuthProvider,
  (config: OAuthConfig) => { authorize: string; token: string; userinfo: string; scopes: string[] }
> = {
  google: () => ({
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
    scopes: ['openid', 'email', 'profile'],
  }),
  microsoft: (config) => {
    const tenant = config.tenant ?? 'common';
    return {
      authorize: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
      token: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      userinfo: 'https://graph.microsoft.com/oidc/userinfo',
      scopes: ['openid', 'email', 'profile', 'offline_access'],
    };
  },
};

export async function buildAuthorizationRequest(
  provider: OAuthProvider,
  config: OAuthConfig,
  options: {
    extraScopes?: string[];
    loginHint?: string;
    /**
     * Ask for a refresh token.
     *
     * Sign-in does not need one: the session is this application's own, and the grant is
     * spent the moment the profile is read. A connector does — it has to reach the
     * account's files hours later, long after the access token has expired.
     *
     * Google returns a refresh token only for `access_type=offline`, and only on the
     * first consent unless `prompt=consent` forces the screen again; a second connection
     * attempt would otherwise come back with nothing to store. Microsoft covers the same
     * ground with the `offline_access` scope it already requests.
     */
    offlineAccess?: boolean;
  } = {},
): Promise<AuthorizationRequest> {
  const endpoints = ENDPOINTS[provider](config);
  const state = randomToken(24);
  const nonce = randomToken(16);
  const codeVerifier = randomToken(48);
  const challenge = toBase64Url(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(codeVerifier) as ArrayBufferView,
      ),
    ),
  );

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: [...endpoints.scopes, ...(options.extraScopes ?? [])].join(' '),
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  if (options.loginHint) params.set('login_hint', options.loginHint);
  if (options.offlineAccess && provider === 'google') {
    params.set('access_type', 'offline');
    params.set('prompt', 'consent');
  }

  return { url: `${endpoints.authorize}?${params.toString()}`, state, codeVerifier, nonce };
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  expiresIn: number;
  scopes: string[];
}

export class OAuthError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid_state'
      | 'exchange_failed'
      | 'profile_failed'
      | 'unverified_email'
      | 'domain_not_allowed',
    readonly detail: string | null = null,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

export async function exchangeCode(
  provider: OAuthProvider,
  config: OAuthConfig,
  code: string,
  codeVerifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  const endpoints = ENDPOINTS[provider](config);
  const response = await fetchImpl(endpoints.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: config.redirectUri,
    }).toString(),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new OAuthError(
      'Could not complete sign-in with this provider. Please try again.',
      'exchange_failed',
      body.slice(0, 300),
    );
  }

  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
    scope?: string;
  };

  if (!json.access_token) {
    throw new OAuthError('The provider did not return an access token.', 'exchange_failed');
  }

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    idToken: json.id_token ?? null,
    expiresIn: json.expires_in ?? 3600,
    scopes: (json.scope ?? '').split(' ').filter(Boolean),
  };
}

export async function fetchProfile(
  provider: OAuthProvider,
  config: OAuthConfig,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthProfile> {
  const endpoints = ENDPOINTS[provider](config);
  const response = await fetchImpl(endpoints.userinfo, {
    headers: { authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new OAuthError('Could not read your profile from the provider.', 'profile_failed');
  }

  const json = (await response.json()) as Record<string, unknown>;
  const sub = json.sub ?? json.id ?? json.oid;
  if (typeof sub !== 'string') {
    throw new OAuthError('The provider did not return a stable account id.', 'profile_failed');
  }

  const email =
    typeof json.email === 'string'
      ? json.email
      : typeof json.preferred_username === 'string' && json.preferred_username.includes('@')
        ? json.preferred_username
        : null;

  return {
    providerAccountId: sub,
    email: email ? email.toLowerCase() : null,
    // Microsoft's OIDC userinfo omits email_verified; a work account email is verified by
    // the directory itself, so treat a returned address as verified for that provider only.
    emailVerified: provider === 'microsoft' ? email !== null : json.email_verified === true,
    fullName: typeof json.name === 'string' ? json.name : null,
    avatarUrl: typeof json.picture === 'string' ? json.picture : null,
  };
}

/** Enforces the workspace's allowed sign-in domains, when configured. */
export function assertDomainAllowed(email: string, allowedDomains: readonly string[]): void {
  if (allowedDomains.length === 0) return;
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain || !allowedDomains.map((d) => d.toLowerCase()).includes(domain)) {
    throw new OAuthError(
      `Sign-in is restricted to ${allowedDomains.join(', ')}. Ask an administrator to add your domain.`,
      'domain_not_allowed',
    );
  }
}

/** State is stored as a hash in a short-lived cookie so the raw value never persists. */
export async function hashState(state: string): Promise<string> {
  return sha256Hex(state);
}
