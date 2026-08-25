import { sql } from 'drizzle-orm';
import { integer, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * IDs are ULIDs stored as `char(26)`-shaped text. They sort by creation time, which
 * gives cheap chronological indexes, but are not sequential integers so they cannot be
 * enumerated by an attacker who sees one in a URL.
 */
export const id = () => text('id').primaryKey();

/** Every timestamp is stored with a time zone and written in UTC. */
export const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`);

export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`);

/** Soft delete. Repositories filter on this by default; purge jobs act on it. */
export const deletedAt = () => timestamp('deleted_at', { withTimezone: true, mode: 'date' });

/**
 * Optimistic concurrency token for rows a user can edit from more than one tab or
 * device. Writers pass the version they read; a mismatch is a 409, not a silent overwrite.
 */
export const rowVersion = () => integer('version').notNull().default(0);
