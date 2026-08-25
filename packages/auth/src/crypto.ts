/**
 * All primitives use WebCrypto so the same code runs on Cloudflare Workers and on Node
 * without a runtime shim. Nothing here depends on a native module.
 */

const encoder = new TextEncoder();

/**
 * WebCrypto's `BufferSource`, declared locally.
 *
 * The global type only exists in the DOM lib, and pulling that into a server-side package
 * would also introduce `window`, `document` and friends as if they were real. Node's own
 * declaration is namespaced under `webcrypto`, which is not importable on Workers. A local
 * alias keeps this file genuinely portable across both runtimes.
 */
type BinaryInput = ArrayBufferView | ArrayBuffer;

/** The opaque key handle returned by `crypto.subtle.importKey`, without naming the DOM type. */
type SubtleKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** URL-safe token with 256 bits of entropy. */
export function randomToken(byteLength = 32): string {
  return toBase64Url(randomBytes(byteLength));
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === 'string' ? encoder.encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', data as BinaryInput);
  return toHex(new Uint8Array(digest));
}

/**
 * Constant-time comparison. A `===` on a token or an HMAC leaks its prefix length through
 * timing, which is enough to forge a value one byte at a time.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  // Compare lengths without early return so the loop below always runs.
  let mismatch = aBytes.length === bBytes.length ? 0 : 1;
  const length = Math.max(aBytes.length, bBytes.length);
  for (let i = 0; i < length; i += 1) {
    mismatch |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return mismatch === 0;
}

export async function hmacSha256(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret) as BinaryInput,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message) as BinaryInput);
  return toBase64Url(new Uint8Array(signature));
}

/* -------------------------------------------------------------------------- */
/* Password hashing                                                           */
/* -------------------------------------------------------------------------- */

/**
 * PBKDF2-HMAC-SHA512 at 600,000 iterations, the OWASP 2023 recommendation for PBKDF2.
 *
 * Argon2id would be preferable, but it requires a native binding that does not exist in
 * the Workers runtime, and the brief's topology puts authentication at the edge. PBKDF2 is
 * the strongest password KDF available in WebCrypto, and the parameters are stored inside
 * the hash string so they can be raised later and old hashes upgraded transparently on the
 * next successful sign-in.
 */
const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_KEY_LENGTH = 64;

export async function hashPassword(
  password: string,
  iterations = PBKDF2_ITERATIONS,
): Promise<string> {
  const salt = randomBytes(16);
  const derived = await pbkdf2(password, salt, iterations);
  return `pbkdf2-sha512$${iterations}$${toBase64Url(salt)}$${toBase64Url(derived)}`;
}

export interface PasswordVerification {
  valid: boolean;
  /** True when the stored hash uses weaker parameters than the current policy. */
  needsRehash: boolean;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<PasswordVerification> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha512') {
    return { valid: false, needsRehash: false };
  }

  const iterations = Number.parseInt(parts[1] ?? '0', 10);
  const salt = fromBase64Url(parts[2] ?? '');
  const expected = parts[3] ?? '';
  if (!Number.isFinite(iterations) || iterations <= 0 || salt.length === 0) {
    return { valid: false, needsRehash: false };
  }

  const derived = await pbkdf2(password, salt, iterations);
  const valid = timingSafeEqual(toBase64Url(derived), expected);
  return { valid, needsRehash: valid && iterations < PBKDF2_ITERATIONS };
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password) as BinaryInput,
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BinaryInput, iterations, hash: 'SHA-512' },
    key,
    PBKDF2_KEY_LENGTH * 8,
  );
  return new Uint8Array(bits);
}

/* -------------------------------------------------------------------------- */
/* Symmetric encryption for stored credentials                                */
/* -------------------------------------------------------------------------- */

/**
 * AES-256-GCM. Used for provider API keys, connector refresh tokens and TOTP secrets.
 *
 * The nonce is random per encryption and stored with the ciphertext, and the key id is
 * prefixed so a future key rotation can decrypt old values while writing new ones under
 * the new key.
 */
export async function encryptSecret(
  plaintext: string,
  base64Key: string,
  keyId = 'k1',
): Promise<string> {
  const key = await importAesKey(base64Key);
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BinaryInput },
    key,
    encoder.encode(plaintext) as BinaryInput,
  );
  return `${keyId}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(payload: string, base64Key: string): Promise<string> {
  const parts = payload.split('.');
  if (parts.length !== 3) throw new Error('Malformed ciphertext');
  const key = await importAesKey(base64Key);
  const iv = fromBase64Url(parts[1] ?? '');
  const data = fromBase64Url(parts[2] ?? '');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BinaryInput },
    key,
    data as BinaryInput,
  );
  return new TextDecoder().decode(plaintext);
}

async function importAesKey(base64Key: string): Promise<SubtleKey> {
  const raw = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
  if (raw.length !== 32) {
    throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes');
  }
  return crypto.subtle.importKey('raw', raw as BinaryInput, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}
