/**
 * Drops every table and re-runs migrations.
 *
 * Refuses to run against a production database: a reset is destructive and there is no
 * legitimate reason to want one there.
 */
import 'dotenv/config';
import postgres from 'postgres';
import { runMigrations } from './migrate.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

if (process.env.APP_ENV === 'production' || process.env.NODE_ENV === 'production') {
  console.error('Refusing to reset a production database.');
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });

try {
  console.log('Dropping schema…');
  await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await sql.end({ timeout: 5 });

  console.log('Re-running migrations…');
  const result = await runMigrations(DATABASE_URL, { log: (m) => console.log(`  ${m}`) });
  console.log(`Applied ${result.applied.length} migration(s).`);
  process.exit(0);
} catch (error) {
  console.error(error);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
}
