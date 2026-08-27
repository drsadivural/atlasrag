/**
 * Deciding when a view should admit it has stopped updating.
 *
 * Every polling view here refetches on a timer and keeps the last good response on screen
 * when a refetch fails — a failed refresh is not a failed page, and blanking a finished
 * answer because one poll came back 429 throws away work the reader can still act on. The
 * cost of keeping it is that the screen can go quietly out of date, so something has to
 * decide when "quietly" has gone on long enough to say out loud.
 *
 * The measure is staleness, not a count of failures. React Query's `failureCount` looks
 * like the obvious signal and is not: it resets at the start of every fetch, so with
 * retries switched off for 4xx — which is right, a permission error will not fix itself —
 * it never climbs above one however long the outage lasts. What the reader actually cares
 * about is how far behind the numbers in front of them have fallen, and that is the gap
 * between the last success and the last failure.
 */

/**
 * How far behind the on-screen data may fall before the view says so.
 *
 * The polls here run every two to two and a half seconds, so this is the second
 * consecutive miss: the first is over before it is worth a word, and waiting any longer
 * leaves someone watching a screen that has quietly stopped moving.
 */
export const STALE_AFTER_MS = 4_000;

/**
 * Whether the last read failed and left the content on screen measurably behind.
 *
 * Takes the three fields it needs rather than a query object, so it can be reasoned about
 * — and tested — without a QueryClient.
 */
export function hasStalled(query: {
  error: unknown;
  dataUpdatedAt: number;
  errorUpdatedAt: number;
}): boolean {
  if (query.error === null || query.error === undefined) return false;
  // No successful read at all: there is nothing on screen to have gone stale, and the
  // caller is showing a full error state instead.
  if (query.dataUpdatedAt === 0) return false;
  return query.errorUpdatedAt - query.dataUpdatedAt >= STALE_AFTER_MS;
}
