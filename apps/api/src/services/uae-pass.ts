import type { UaePassConfig } from '../env.js';

/**
 * UAE PASS, the national digital identity.
 *
 * Standard OpenID Connect authorization code with PKCE, but its own module rather than a
 * third case in the sign-in provider enum: the endpoints differ per environment and come
 * from configuration, and the claims it returns are its own. Folding it into the Google
 * and Microsoft adapter would mean special-casing that adapter in three places.
 *
 * Nothing here reaches a browser. The client secret, the token exchange and the userinfo
 * call all stay on the server; the browser only ever sees a redirect URL.
 */

export interface UaePassAuthorization {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface UaePassProfile {
  subject: string;
  email: string | null;
  fullName: string | null;
}

export class UaePassError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'UaePassError';
  }
}

function randomToken(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return toBase64Url(buffer);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function buildUaePassAuthorization(
  config: UaePassConfig,
  redirectUri: string,
): Promise<UaePassAuthorization> {
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
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: config.scopes,
    state,
    nonce,
    acr_values: config.acrValues,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ui_locales: 'en',
  });

  return {
    url: `${config.authorizationEndpoint}?${params.toString()}`,
    state,
    nonce,
    codeVerifier,
  };
}

export interface UaePassTokens {
  accessToken: string;
  idToken: string | null;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function exchangeUaePassCode(
  config: UaePassConfig,
  redirectUri: string,
  code: string,
  codeVerifier: string,
  fetchImpl: FetchLike = fetch,
): Promise<UaePassTokens> {
  const response = await fetchImpl(config.tokenEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      // UAE PASS expects client credentials in the Basic header at the token endpoint.
      authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }).toString(),
  });

  if (!response.ok) {
    // The provider's own message is not carried through: it can name the account, and
    // this failure is shown to whoever holds the browser.
    throw new UaePassError('The authorization code was not accepted.', 'exchange_failed');
  }

  const payload = (await response.json()) as { access_token?: string; id_token?: string };
  if (!payload.access_token) {
    throw new UaePassError('The provider returned no access token.', 'no_token');
  }
  return { accessToken: payload.access_token, idToken: payload.id_token ?? null };
}

/**
 * Reads the id token's claims without trusting them on their own.
 *
 * The signature is not verified here, and this value is never the basis for a session:
 * the profile below comes from the userinfo endpoint over TLS with the access token, and
 * these claims are used only to check the nonce that this server itself issued.
 */
export function readIdTokenClaims(idToken: string): Record<string, unknown> {
  const segment = idToken.split('.')[1];
  if (!segment) return {};
  try {
    const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

export async function fetchUaePassProfile(
  config: UaePassConfig,
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<UaePassProfile> {
  const response = await fetchImpl(config.userinfoEndpoint, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  if (!response.ok) {
    throw new UaePassError('The identity could not be read.', 'userinfo_failed');
  }

  const payload = (await response.json()) as {
    sub?: string;
    uuid?: string;
    email?: string;
    firstnameEN?: string;
    lastnameEN?: string;
    fullnameEN?: string;
  };

  const subject = payload.sub ?? payload.uuid;
  if (!subject) throw new UaePassError('The identity had no subject.', 'no_subject');

  const fullName =
    payload.fullnameEN ??
    [payload.firstnameEN, payload.lastnameEN].filter(Boolean).join(' ').trim() ??
    null;

  return {
    subject,
    email: payload.email ? payload.email.trim().toLowerCase() : null,
    fullName: fullName || null,
  };
}

/**
 * Whether an address belongs to an entity this deployment accepts.
 *
 * An empty allowlist means the check is switched off, which is a deliberate deployment
 * choice rather than an accident: a development instance has no government domains.
 */
export function isAllowedGovernmentEmail(
  email: string,
  allowedDomains: readonly string[],
): boolean {
  if (allowedDomains.length === 0) return true;
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  return allowedDomains.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
}
