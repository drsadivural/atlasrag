/**
 * Fills in the last four characters of provider keys stored before that column existed.
 *
 * The Models list can only name a key it has a hint for, and the hint is written when a
 * key is saved — so every configuration that predates the column shows "Key saved" and
 * nothing more. This reads each credential once, through the same decryption the API uses,
 * and writes back four characters. It is idempotent and skips anything it cannot decrypt,
 * which means the ENCRYPTION_KEY has rotated and the key has to be entered again anyway.
 *
 * Run once after deploying the migration:  pnpm exec tsx packages/db/scripts/backfill-key-hints.mts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { decryptSecret } from '../../auth/src/crypto.js';

const env = Object.fromEntries(
  readFileSync(fileURLToPath(new URL('../../../.env', import.meta.url)), 'utf8')
    .split('\n')
    .filter((line) => line.includes('=') && !line.trimStart().startsWith('#'))
    .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]),
);

const sql = postgres(env.DATABASE_URL!, { max: 2 });
const rows = await sql<Array<{ id: string; credential_encrypted: string }>>`
  SELECT id, credential_encrypted
  FROM model_configurations
  WHERE credential_encrypted IS NOT NULL AND credential_last4 IS NULL`;

let done = 0;
for (const row of rows) {
  try {
    const key = await decryptSecret(row.credential_encrypted, env.ENCRYPTION_KEY!);
    await sql`UPDATE model_configurations SET credential_last4 = ${key.slice(-4)} WHERE id = ${row.id}`;
    done += 1;
  } catch {
    // Undecryptable: predates the current ENCRYPTION_KEY. No hint is the honest outcome.
  }
}
console.log(`backfilled ${done} of ${rows.length}`);
await sql.end();
