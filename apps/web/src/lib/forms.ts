import { useState, type Dispatch, type SetStateAction } from 'react';

/**
 * Local editable state seeded from a server value.
 *
 * The seed is re-applied during render when the server value changes, not in an effect.
 * An effect would render the stale value once first — after switching workspace the user
 * would see the previous workspace's settings for a frame — and would then trigger a
 * second render pass for every server update.
 *
 * A local edit is preserved until the server value itself changes, so typing is never
 * interrupted by a background refetch that returned identical data.
 */
export function useSyncedState<T>(serverValue: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(serverValue);
  const [seed, setSeed] = useState<T>(serverValue);

  if (!Object.is(seed, serverValue)) {
    setSeed(serverValue);
    setValue(serverValue);
  }

  return [value, setValue];
}
