import { monotonicFactory, ulid } from 'ulid';

const monotonic = monotonicFactory();

/**
 * Monotonic ULIDs: sortable by creation time within the same millisecond, and not
 * guessable from a neighbouring value the way an auto-increment integer is.
 */
export function newId(): string {
  return monotonic();
}

export function newIdAt(timestamp: number): string {
  return ulid(timestamp);
}

const ULID_RE = /^[0-7][0-9ABCDEFGHJKMNPQRSTVWXYZ]{25}$/;

export function isId(value: unknown): value is string {
  return typeof value === 'string' && ULID_RE.test(value);
}
