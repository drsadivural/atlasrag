/**
 * Redaction applied to everything before it reaches a log, a trace attribute or an audit
 * diff. Two categories are handled:
 *
 *  - Credentials and tokens, which must never appear anywhere.
 *  - Customer document content, which is confidential and is excluded unless the operator
 *    explicitly opts in with LOG_DOCUMENT_CONTENT for local debugging.
 */

const SECRET_KEY_PATTERN =
  /^(?:.*_)?(password|passwd|secret|token|api[_-]?key|apikey|authorization|auth|cookie|session|credential|private[_-]?key|refresh[_-]?token|access[_-]?token|csrf|otp|code|hash|signature)(?:_.*)?$/i;

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
      if (SECRET_KEY_PATTERN.test(key)) {
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
