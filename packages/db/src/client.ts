import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type Database = PostgresJsDatabase<typeof schema>;
export type SqlClient = ReturnType<typeof postgres>;

export interface DbHandle {
  db: Database;
  sql: SqlClient;
  close: () => Promise<void>;
}

export interface CreateDbOptions {
  url: string;
  max?: number;
  /** Statement timeout guards against a pathological retrieval query pinning a connection. */
  statementTimeoutMs?: number;
  debug?: boolean;
}

/**
 * Creates a pooled connection. On Cloudflare Workers the same `postgres` client runs
 * against the Hyperdrive connection string, so this factory is used unchanged in both
 * runtimes and only the URL differs.
 */
export function createDb(options: CreateDbOptions): DbHandle {
  const sql = postgres(options.url, {
    max: options.max ?? 10,
    idle_timeout: 30,
    connect_timeout: 15,
    prepare: false,
    onnotice: () => {},
    connection: {
      application_name: 'uxe-api',
      statement_timeout: options.statementTimeoutMs ?? 30_000,
    },
  });

  const db = drizzle(sql, { schema, logger: options.debug === true });

  return {
    db,
    sql,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

export { schema };
