import { describe, expect, it } from 'vitest';
import { STALE_AFTER_MS, hasStalled } from '../../apps/web/src/lib/staleness.js';

const T = 1_700_000_000_000;

describe('hasStalled', () => {
  it('says nothing while the reads are succeeding', () => {
    expect(hasStalled({ error: null, dataUpdatedAt: T, errorUpdatedAt: 0 })).toBe(false);
  });

  it('holds its tongue through a single missed poll', () => {
    expect(
      hasStalled({ error: new Error('429'), dataUpdatedAt: T, errorUpdatedAt: T + 2_000 }),
    ).toBe(false);
  });

  it('speaks once the content on screen has fallen measurably behind', () => {
    expect(
      hasStalled({ error: new Error('429'), dataUpdatedAt: T, errorUpdatedAt: T + STALE_AFTER_MS }),
    ).toBe(true);
  });

  /*
   * The reason this measures staleness rather than counting failures. React Query resets
   * failureCount at the start of every fetch, and retries are off for 4xx because a
   * permission error will not fix itself — so a count would sit at one through an outage
   * of any length. An hour behind is an hour behind however few attempts it took.
   */
  it('does not need a run of attempts to notice a long outage', () => {
    expect(
      hasStalled({ error: new Error('429'), dataUpdatedAt: T, errorUpdatedAt: T + 3_600_000 }),
    ).toBe(true);
  });

  it('stays quiet when there was never anything on screen to go stale', () => {
    expect(hasStalled({ error: new Error('500'), dataUpdatedAt: 0, errorUpdatedAt: T })).toBe(
      false,
    );
  });

  it('clears as soon as a read succeeds again', () => {
    // React Query nulls the error on success, and that alone has to be enough to hide the
    // strip — the error timestamp it leaves behind is older than the new data, not newer.
    expect(hasStalled({ error: null, dataUpdatedAt: T + 10_000, errorUpdatedAt: T })).toBe(false);
  });
});
