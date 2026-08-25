import { hmacSha256, randomToken, sha256Hex, timingSafeEqual } from './crypto.js';

export const SESSION_COOKIE = 'uxe_session';
export const CSRF_COOKIE = 'uxe_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export interface CookieOptions {
  secure: boolean;
  domain?: string | undefined;
  maxAgeSeconds?: number | undefined;
  sameSite?: 'Lax' | 'Strict' | 'None';
  path?: string;
}

/**
 * Serialises a session cookie.
 *
 * HttpOnly keeps the token out of reach of any script on the page, which is the difference
 * between an XSS bug being a defacement and being a full account takeover. SameSite=Lax
 * blocks the cross-site POST that CSRF depends on while still allowing normal top-level
 * navigation back into the app from an email link.
 */
export function serializeSessionCookie(token: string, options: CookieOptions): string {
  return serializeCookie(SESSION_COOKIE, token, {
    ...options,
    httpOnly: true,
    sameSite: options.sameSite ?? 'Lax',
  });
}

/**
 * The CSRF cookie is deliberately readable by script: the double-submit pattern needs the
 * browser to echo it back in a header. It carries no authority on its own — it is only
 * ever compared against the HMAC bound to the server-side session secret.
 */
export function serializeCsrfCookie(token: string, options: CookieOptions): string {
  return serializeCookie(CSRF_COOKIE, token, {
    ...options,
    httpOnly: false,
    sameSite: options.sameSite ?? 'Lax',
  });
}

export function clearCookie(
  name: string,
  options: Pick<CookieOptions, 'secure' | 'domain'>,
): string {
  return serializeCookie(name, '', {
    ...options,
    httpOnly: true,
    maxAgeSeconds: 0,
    sameSite: 'Lax',
  });
}

function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions & { httpOnly: boolean },
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path ?? '/'}`];
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${options.maxAgeSeconds}`);
    parts.push(`Expires=${new Date(Date.now() + options.maxAgeSeconds * 1000).toUTCString()}`);
  }
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  if (options.secure) parts.push('Secure');
  if (options.httpOnly) parts.push('HttpOnly');
  return parts.join('; ');
}

export function parseCookies(header: string | null | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index === -1) continue;
    const key = pair.slice(0, index).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(pair.slice(index + 1).trim());
  }
  return out;
}

export interface NewSessionToken {
  token: string;
  tokenHash: string;
  csrfSecret: string;
  csrfToken: string;
}

/**
 * Mints a session.
 *
 * Only the SHA-256 of the token reaches the database, so a database dump cannot be
 * replayed as a live session. The CSRF token is an HMAC of the session's own secret, which
 * ties it to this session specifically: a token stolen from another session will not verify.
 */
export async function createSessionToken(): Promise<NewSessionToken> {
  const token = randomToken(32);
  const csrfSecret = randomToken(32);
  return {
    token,
    tokenHash: await sha256Hex(token),
    csrfSecret,
    csrfToken: await hmacSha256(csrfSecret, 'csrf'),
  };
}

export async function deriveCsrfToken(csrfSecret: string): Promise<string> {
  return hmacSha256(csrfSecret, 'csrf');
}

export async function hashSessionToken(token: string): Promise<string> {
  return sha256Hex(token);
}

/**
 * Double-submit CSRF verification.
 *
 * Both halves must be present and equal to the HMAC derived from the session's stored
 * secret. Comparing against a value derived server-side (rather than merely comparing the
 * cookie to the header) means an attacker who can set a cookie on the victim's browser
 * still cannot produce a matching header value.
 */
export async function verifyCsrf(
  csrfSecret: string,
  headerToken: string | null | undefined,
  cookieToken: string | null | undefined,
): Promise<boolean> {
  if (!headerToken || !cookieToken) return false;
  const expected = await deriveCsrfToken(csrfSecret);
  return timingSafeEqual(headerToken, expected) && timingSafeEqual(cookieToken, expected);
}

/** Methods that never mutate state and therefore never require a CSRF token. */
export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Origin check, run in addition to the CSRF token.
 *
 * Two independent defences are deliberate: the token defeats a forged form post, and the
 * origin check defeats a request from a page that somehow obtained a token.
 */
export function isAllowedOrigin(
  origin: string | null | undefined,
  referer: string | null | undefined,
  allowed: readonly string[],
): boolean {
  const candidate = origin ?? (referer ? safeOrigin(referer) : null);
  // A same-origin fetch from some clients omits Origin entirely; the CSRF token still applies.
  if (!candidate) return true;
  return allowed.includes(candidate);
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
