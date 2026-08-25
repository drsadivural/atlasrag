import { relations, sql } from 'drizzle-orm';
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
import { createdAt, deletedAt, id, rowVersion, updatedAt } from './columns.js';

export const organizations = pgTable(
  'organizations',
  {
    id: id(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    /** Sign-in domain allowlist; empty means any verified email may be invited. */
    allowedEmailDomains: jsonb('allowed_email_domains').$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [uniqueIndex('organizations_slug_key').on(t.slug)],
);

export const workspaces = pgTable(
  'workspaces',
  {
    id: id(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    locale: text('locale').notNull().default('en'),
    timezone: text('timezone').notNull().default('UTC'),
    brandColor: text('brand_color').notNull().default('#3156F5'),
    logoUrl: text('logo_url'),
    /** Consultant persona + answer defaults + security/retention policy for this workspace. */
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    version: rowVersion(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    uniqueIndex('workspaces_org_slug_key').on(t.organizationId, t.slug),
    index('workspaces_org_idx').on(t.organizationId),
  ],
);

export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true, mode: 'date' }),
    /** Argon2id hash. Null for accounts that only ever used OAuth or magic links. */
    passwordHash: text('password_hash'),
    fullName: text('full_name').notNull(),
    title: text('title'),
    avatarUrl: text('avatar_url'),
    locale: text('locale').notNull().default('en'),
    theme: text('theme').notNull().default('system'),
    status: text('status').notNull().default('active'),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true, mode: 'date' }),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true, mode: 'date' }),
    version: rowVersion(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [uniqueIndex('users_email_key').on(sql`lower(${t.email})`)],
);

export const memberships = pgTable(
  'memberships',
  {
    id: id(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    status: text('status').notNull().default('active'),
    invitedAt: timestamp('invited_at', { withTimezone: true, mode: 'date' }),
    joinedAt: timestamp('joined_at', { withTimezone: true, mode: 'date' }),
    version: rowVersion(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    uniqueIndex('memberships_workspace_user_key').on(t.workspaceId, t.userId),
    index('memberships_user_idx').on(t.userId),
    index('memberships_workspace_idx').on(t.workspaceId, t.status),
  ],
);

export const groups = pgTable(
  'groups',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [uniqueIndex('groups_workspace_name_key').on(t.workspaceId, t.name)],
);

export const groupMembers = pgTable(
  'group_members',
  {
    id: id(),
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('group_members_key').on(t.groupId, t.userId),
    index('group_members_user_idx').on(t.userId),
  ],
);

export const invitations = pgTable(
  'invitations',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id').notNull(),
    email: text('email').notNull(),
    role: text('role').notNull().default('member'),
    /** SHA-256 of the invite token; the raw token only ever exists in the email. */
    tokenHash: text('token_hash').notNull(),
    invitedByUserId: text('invited_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    groupIds: jsonb('group_ids').$type<string[]>().notNull().default([]),
    message: text('message'),
    status: text('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('invitations_token_key').on(t.tokenHash),
    index('invitations_workspace_email_idx').on(t.workspaceId, t.email),
  ],
);

export const userPreferences = pgTable(
  'user_preferences',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    preferences: jsonb('preferences').$type<Record<string, unknown>>().notNull().default({}),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('user_preferences_key').on(t.userId, t.workspaceId)],
);

export const organizationsRelations = relations(organizations, ({ many }) => ({
  workspaces: many(workspaces),
  memberships: many(memberships),
}));

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [workspaces.organizationId],
    references: [organizations.id],
  }),
  memberships: many(memberships),
  groups: many(groups),
}));

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(memberships),
  groupMembers: many(groupMembers),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  user: one(users, { fields: [memberships.userId], references: [users.id] }),
  workspace: one(workspaces, { fields: [memberships.workspaceId], references: [workspaces.id] }),
}));
