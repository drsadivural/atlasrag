import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

/**
 * Loads the repository's `.env`, wherever the command was started from.
 *
 * `dotenv/config` reads only the current working directory, and pnpm runs a package script
 * with that directory set to the package — so `pnpm db:migrate` from the repository root
 * would look in `packages/db` and report that DATABASE_URL is unset while the file sits
 * three directories up.
 */
export function loadRepositoryEnv(): void {
  const candidates = [resolve(process.cwd(), '.env')];

  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    candidates.push(resolve(dir, '.env'));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  for (const path of candidates) {
    if (existsSync(path)) {
      config({ path, quiet: true });
      return;
    }
  }
}
