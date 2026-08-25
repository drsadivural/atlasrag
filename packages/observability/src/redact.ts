/**
 * Redaction applied to everything before it reaches a log, a trace attribute or an audit
 * diff. Two categories are handled:
 *
 *  - Credentials and tokens, which must never appear anywhere.
 *  - Customer document content, which is confidential and is excluded unless the operator
 *    explicitly opts in with LOG_DOCUMENT_CONTENT for local debugging.
 */

/**
 * Field names are matched on whole words, after splitting on `_`, `-` and camelCase
 * boundaries. Matching the raw string would miss `csrfToken` and `sessionToken`, which are
 * exactly the shapes this codebase uses.
 */
const SECRET_WORDS = new Set([
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'apikey',
  'authorization',
  'auth',
  'cookie',
  'credential',
  'credentials',
  'csrf',
  'xsrf',
  'otp',
  'totp',
  'jwt',
  'signature',
  'salt',
  'nonce',
  'pin',
]);

/** Words that are only sensitive next to another word, so `statusCode` stays readable. */
const QUALIFIED_SECRETS: Array<[string, string]> = [
  ['session', 'token'],
  ['session', 'secret'],
  ['session', 'key'],
  ['api', 'key'],
  ['private', 'key'],
  ['secret', 'key'],
  ['signing', 'key'],
  ['encryption', 'key'],
  ['access', 'key'],
  ['recovery', 'code'],
  ['backup', 'code'],
  ['verification', 'code'],
  ['reset', 'code'],
  ['auth', 'code'],
  ['otp', 'code'],
  ['password', 'hash'],
  ['token', 'hash'],
  ['secret', 'hash'],
];

function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

export function isSecretKey(key: string): boolean {
  const words = keyWords(key);
  if (words.some((word) => SECRET_WORDS.has(word))) return true;
  // `apikey` written as one word survives the split, so also test adjacent pairs.
  for (let i = 0; i < words.length - 1; i += 1) {
    for (const [first, second] of QUALIFIED_SECRETS) {
      if (words[i] === first && words[i + 1] === second) return true;
    }
  }
  // A field named exactly `hash`, `key` or `session` is a credential; the same word
  // qualified by something else (`sessionId`, `storageKey`) stays readable so logs remain
  // useful for correlation.
  //
  // A bare `code` is deliberately NOT in this list: in logs it is almost always an error
  // code, and redacting it hides the reason a job failed. Secret codes are named
  // (`recoveryCode`, `otpCode`, ...) and are caught by the qualified pairs above.
  const only = words.length === 1 ? words[0] : undefined;
  return only !== undefined && ['hash', 'key', 'session'].includes(only);
}

/** Content fields that hold document text; excluded by default. */
const CONTENT_KEYS = new Set([
  'text',
  'content',
  'excerpt',
  'supportingExcerpt',
  'obligationText',
  'pageText',
  'body',
  'currentContent',
  'proposedContent',
  'editedContent',
]);

const VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, 'sk-[redacted]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, 'Bearer [redacted]'],
  [/\b[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
  [/\b(?:\d[ -]?){13,19}\b/g, '[card]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[jwt]'],
];

export interface RedactOptions {
  /** Set from LOG_DOCUMENT_CONTENT. Never enable outside local development. */
  allowDocumentContent?: boolean;
  maxStringLength?: number;
  maxDepth?: number;
}

export function redactValue(value: unknown, options: RedactOptions = {}): unknown {
  return redactInner(value, options, 0, new WeakSet());
}

function redactInner(
  value: unknown,
  options: RedactOptions,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  const maxDepth = options.maxDepth ?? 6;
  if (depth > maxDepth) return '[truncated]';

  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return redactString(value, options);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message, options) };
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    return value.slice(0, 50).map((v) => redactInner(v, options, depth + 1, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(key)) {
        out[key] = '[redacted]';
        continue;
      }
      if (CONTENT_KEYS.has(key) && options.allowDocumentContent !== true) {
        out[key] = typeof item === 'string' ? `[content:${item.length} chars]` : '[content]';
        continue;
      }
      out[key] = redactInner(item, options, depth + 1, seen);
    }
    return out;
  }

  return '[unserializable]';
}

function redactString(value: string, options: RedactOptions): string {
  let out = value;
  for (const [pattern, replacement] of VALUE_PATTERNS) out = out.replace(pattern, replacement);
  const max = options.maxStringLength ?? 2000;
  return out.length > max ? `${out.slice(0, max)}...[truncated]` : out;
}

/** Builds a before/after audit diff containing only the keys that actually changed. */
export function auditDiff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  options: RedactOptions = {},
): { before: Record<string, unknown> | null; after: Record<string, unknown> | null } {
  if (!before || !after) {
    return {
      before: before ? (redactValue(before, options) as Record<string, unknown>) : null,
      after: after ? (redactValue(after, options) as Record<string, unknown>) : null,
    };
  }

  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};

  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[key];
    const b = after[key];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    changedBefore[key] = a;
    changedAfter[key] = b;
  }

  return {
    before: redactValue(changedBefore, options) as Record<string, unknown>,
    after: redactValue(changedAfter, options) as Record<string, unknown>,
  };
}
