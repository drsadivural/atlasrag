import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'drizzle');

/**
 * Migration names are ordered lexicographically, so the numeric prefix is the contract.
 * Every migration is written expand-first: add columns/tables, backfill, then contract in a
 * later release. That keeps a rolling deploy safe because the old code keeps working while
 * the new schema is already in place.
 */
export async function listMigrationFiles(dir = MIGRATIONS_DIR): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((f) => f.endsWith('.sql')).sort();
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function runMigrations(
  databaseUrl: string,
  options: { dir?: string; log?: (msg: string) => void } = {},
): Promise<MigrationResult> {
  const dir = options.dir ?? MIGRATIONS_DIR;
  const log = options.log ?? (() => {});
  const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} });

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;

    const existing = await sql<{ name: string; checksum: string }[]>`
      SELECT name, checksum FROM schema_migrations
    `;
    const appliedMap = new Map(existing.map((r) => [r.name, r.checksum]));

    const files = await listMigrationFiles(dir);
    const applied: string[] = [];
    const skipped: string[] = [];

    for (const file of files) {
      const body = await readFile(join(dir, file), 'utf8');
      const checksum = await sha256Hex(body);
      const prior = appliedMap.get(file);

      if (prior) {
        if (prior !== checksum) {
          // An edited migration is a deployment hazard: the two environments would diverge.
          throw new Error(
            `Migration ${file} was modified after it was applied. Add a new migration instead of editing history.`,
          );
        }
        skipped.push(file);
        continue;
      }

      log(`applying ${file}`);
      // Each migration runs in its own transaction so a failure leaves no partial schema.
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`INSERT INTO schema_migrations (name, checksum) VALUES (${file}, ${checksum})`;
      });
      applied.push(file);
    }

    return { applied, skipped };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const MIGRATIONS = { dir: MIGRATIONS_DIR, list: listMigrationFiles };

// Allow `pnpm --filter @uxe/db migrate` to run this file directly.
if (process.argv[1] && process.argv[1].endsWith('migrate.ts')) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  runMigrations(url, { log: (m) => console.log(m) })
    .then((r) => {
      console.log(`applied ${r.applied.length}, already present ${r.skipped.length}`);
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
