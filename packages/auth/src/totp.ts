import { fromBase64Url, timingSafeEqual } from './crypto.js';

/**
 * RFC 6238 TOTP over WebCrypto HMAC-SHA1, which is what every authenticator app expects.
 *
 * Verification accepts a small window of neighbouring steps to tolerate clock drift, and
 * the comparison is constant time so a code cannot be brute-forced digit by digit through
 * response timing.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(byteLength = 20): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base32Encode(bytes);
}

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export async function generateTotp(
  secret: string,
  options: { timestamp?: number; step?: number; digits?: number } = {},
): Promise<string> {
  const step = options.step ?? 30;
  const digits = options.digits ?? 6;
  const counter = Math.floor((options.timestamp ?? Date.now()) / 1000 / step);

  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);

  const key = await crypto.subtle.importKey(
    'raw',
    base32Decode(secret) as ArrayBufferView,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, buffer));

  const offset = (signature[signature.length - 1] ?? 0) & 0x0f;
  const binary =
    (((signature[offset] ?? 0) & 0x7f) << 24) |
    (((signature[offset + 1] ?? 0) & 0xff) << 16) |
    (((signature[offset + 2] ?? 0) & 0xff) << 8) |
    ((signature[offset + 3] ?? 0) & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Verifies a code against the current step and `window` steps either side.
 * A window of 1 (the default) tolerates ~30s of drift in each direction.
 */
export async function verifyTotp(
  secret: string,
  code: string,
  options: { timestamp?: number; window?: number; step?: number; digits?: number } = {},
): Promise<boolean> {
  const window = options.window ?? 1;
  const step = options.step ?? 30;
  const now = options.timestamp ?? Date.now();
  const normalized = code.replace(/\s/g, '');

  let matched = false;
  for (let offset = -window; offset <= window; offset += 1) {
    const candidate = await generateTotp(secret, {
      timestamp: now + offset * step * 1000,
      step,
      digits: options.digits ?? 6,
    });
    // Do not break early: an early return would leak which step matched via timing.
    if (timingSafeEqual(candidate, normalized)) matched = true;
  }
  return matched;
}

export function buildOtpauthUrl(options: {
  secret: string;
  accountName: string;
  issuer: string;
}): string {
  const label = encodeURIComponent(`${options.issuer}:${options.accountName}`);
  const params = new URLSearchParams({
    secret: options.secret,
    issuer: options.issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Single-use recovery codes for when an authenticator device is lost.
 * Only hashes are stored; the plaintext is shown exactly once at enrolment.
 */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1

export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    // Rejection-free sampling over a 31-character alphabet chosen to exclude glyphs users
    // routinely mistype (I/L/1, O/0), because these are transcribed by hand under stress.
    const bytes = new Uint8Array(10);
    crypto.getRandomValues(bytes);
    let raw = '';
    for (const byte of bytes) raw += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
  }
  return codes;
}

export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export { fromBase64Url };
