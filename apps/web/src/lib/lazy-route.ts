import { lazy, type ComponentType } from 'react';

/**
 * A route chunk that survives a deploy landing under an open tab.
 *
 * Every route below the first paint is code-split, and the chunk filenames carry a content
 * hash. A deploy replaces them. A browser holding the previous `index.html` — from its own
 * cache, or simply from having been left open — then asks for a filename that no longer
 * exists, and the import rejects with "Failed to fetch dynamically imported module". The
 * user sees "Something went wrong" on a working application, and it is unrecoverable by
 * anything they would think to try, because a soft navigation never re-reads index.html.
 *
 * So a failed chunk load reloads the page once. That fetches the current index.html, which
 * names the chunks that actually exist, and the navigation completes.
 *
 * Once, and only for this failure. The flag lives in `sessionStorage` keyed by the chunk,
 * so a genuinely missing chunk or an offline browser surfaces the error the second time
 * instead of reloading forever — a reload loop is a worse failure than the one being
 * fixed, and an invisible one.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- React.lazy's own bound.
export function lazyRoute<T extends ComponentType<any>>(
  name: string,
  load: () => Promise<{ default: T }>,
) {
  return lazy(() =>
    load().catch((error: unknown) => {
      if (!isStaleChunk(error) || alreadyRetried(name)) throw error;
      markRetried(name);
      // `reload()` never resolves — the document is replaced. The pending promise is
      // deliberately left hanging so nothing renders an error state on the way out.
      window.location.reload();
      return new Promise<{ default: T }>(() => {});
    }),
  );
}

/**
 * Whether this looks like a chunk that is no longer on the server.
 *
 * Matched on the message because the browsers do not agree on anything better: Chrome and
 * Safari throw a plain `TypeError`, Firefox an `Error`, and none of them carry a code. A
 * genuine syntax error inside a chunk produces a different message and is left to surface.
 */
function isStaleChunk(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /dynamically imported module/i.test(message) ||
    /Importing a module script failed/i.test(message) ||
    /error loading dynamically imported module/i.test(message)
  );
}

const KEY = 'uxe.chunk-retry';

function alreadyRetried(name: string): boolean {
  try {
    return window.sessionStorage.getItem(`${KEY}:${name}`) !== null;
  } catch {
    // Storage can throw outright in a locked-down browser. Retrying once without being
    // able to record it risks a loop, so treat it as already tried.
    return true;
  }
}

function markRetried(name: string): void {
  try {
    window.sessionStorage.setItem(`${KEY}:${name}`, '1');
  } catch {
    /* Checked before this is called; nothing useful to do if it fails here. */
  }
}

/**
 * Forgets the retry marks.
 *
 * Called once the application has successfully mounted, so a reload that fixed the problem
 * leaves no state behind and a stale chunk met tomorrow gets its own retry.
 */
export function clearChunkRetries(): void {
  try {
    for (const key of Object.keys(window.sessionStorage)) {
      if (key.startsWith(KEY)) window.sessionStorage.removeItem(key);
    }
  } catch {
    /* Nothing to clear if storage is unavailable. */
  }
}
