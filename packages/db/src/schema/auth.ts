import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, id, updatedAt } from './columns.js';
import { users, workspaces } from './tenancy.js';

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * SHA-256 of the session token. The raw token lives only in the HttpOnly cookie, so a
     * database dump alone cannot be replayed as a valid session.
     */
    tokenHash: text('token_hash').notNull(),
    /** Rotated on privilege change and periodically; the old hash is invalidated at once. */
    activeWorkspaceId: text('active_workspace_id').references(() => workspaces.id, {
      onDelete: 'set null',
    }),
    csrfSecret: text('csrf_secret').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    /** True once the session has cleared any MFA requirement. */
    mfaSatisfied: boolean('mfa_satisfied').notNull().default(false),
    rememberMe: boolean('remember_me').notNull().default(false),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    absoluteExpiresAt: timestamp('absolute_expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('sessions_token_key').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId, t.revokedAt),
    index('sessions_expiry_idx').on(t.expiresAt),
  ],
);

export const authFactors = pgTable(
  'auth_factors',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // totp | webauthn | recovery
    label: text('label'),
    /** TOTP secret / WebAuthn public key, encrypted with AES-256-GCM at rest. */
    secretEncrypted: text('secret_encrypted'),
    credentialId: text('credential_id'),
    publicKey: text('public_key'),
    signCount: integer('sign_count').notNull().default(0),
    transports: jsonb('transports').$type<string[]>().notNull().default([]),
    /** Argon2 hashes of single-use recovery codes. */
    recoveryHashes: jsonb('recovery_hashes').$type<string[]>().notNull().default([]),
    status: text('status').notNull().default('pending'), // pending | active | revoked
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('auth_factors_user_idx').on(t.userId, t.status),
    uniqueIndex('auth_factors_credential_key').on(t.credentialId),
  ],
);

/**
 * Short-lived tokens for email verification, password reset, magic-link sign-in and
 * MFA challenges. Only the hash is stored, and `consumedAt` makes every token single-use.
 */
export const authTokens = pgTable(
  'auth_tokens',
  {
    id: id(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    email: text('email'),
    kind: text('kind').notNull(), // email_verify | password_reset | magic_link | mfa_challenge
    tokenHash: text('token_hash').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('auth_tokens_hash_key').on(t.tokenHash),
    index('auth_tokens_user_kind_idx').on(t.userId, t.kind),
    index('auth_tokens_expiry_idx').on(t.expiresAt),
  ],
);

export const oauthAccounts = pgTable(
  'oauth_accounts',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(), // google | microsoft
    providerAccountId: text('provider_account_id').notNull(),
    email: text('email'),
    /** Encrypted at rest; only used to refresh connector access, never returned by an API. */
    refreshTokenEncrypted: text('refresh_token_encrypted'),
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('oauth_accounts_key').on(t.provider, t.providerAccountId)],
);
