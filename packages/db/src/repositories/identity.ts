import { and, count, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  authFactors,
  authTokens,
  groupMembers,
  groups,
  invitations,
  memberships,
  oauthAccounts,
  organizations,
  sessions,
  userPreferences,
  users,
  workspaces,
} from '../schema/index.js';
import { newId } from '../ids.js';
import {
  AuthorizationError,
  NotFoundError,
  requirePermission,
  type TenantContext,
} from '../tenant.js';
import { canAssignRole, type Role } from '@uxe/contracts';

export class IdentityRepository {
  constructor(private readonly db: Database) {}

  /* ---------------------------------------------------------------------- */
  /* Users                                                                  */
  /* ---------------------------------------------------------------------- */

  async findUserByEmail(email: string) {
    const [row] = await this.db
      .select()
      .from(users)
      .where(and(sql`lower(${users.email}) = lower(${email})`, isNull(users.deletedAt)))
      .limit(1);
    return row ?? null;
  }

  async findUserById(userId: string) {
    const [row] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1);
    return row ?? null;
  }

  async createUser(input: {
    email: string;
    passwordHash: string | null;
    fullName: string;
    locale?: string;
    emailVerified?: boolean;
    title?: string | null;
  }) {
    const [row] = await this.db
      .insert(users)
      .values({
        id: newId(),
        email: input.email.toLowerCase(),
        passwordHash: input.passwordHash,
        fullName: input.fullName,
        title: input.title ?? null,
        locale: input.locale ?? 'en',
        emailVerifiedAt: input.emailVerified ? new Date() : null,
      })
      .returning();
    if (!row) throw new Error('Failed to create user');
    return row;
  }

  async updateUser(userId: string, patch: Partial<typeof users.$inferInsert>) {
    const [row] = await this.db
      .update(users)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning();
    return row ?? null;
  }

  async markEmailVerified(userId: string) {
    await this.db
      .update(users)
      .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, userId));
  }

  /**
   * Progressive lockout. Ten consecutive failures locks the account for fifteen minutes,
   * which blunts credential stuffing without letting an attacker lock a victim out forever.
   */
  async recordFailedLogin(userId: string) {
    const [row] = await this.db
      .update(users)
      .set({
        failedLoginCount: sql`${users.failedLoginCount} + 1`,
        lockedUntil: sql`CASE WHEN ${users.failedLoginCount} + 1 >= 10 THEN now() + interval '15 minutes' ELSE ${users.lockedUntil} END`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning({ failedLoginCount: users.failedLoginCount, lockedUntil: users.lockedUntil });
    return row ?? null;
  }

  async clearFailedLogins(userId: string) {
    await this.db
      .update(users)
      .set({ failedLoginCount: 0, lockedUntil: null, lastActiveAt: new Date() })
      .where(eq(users.id, userId));
  }

  /* ---------------------------------------------------------------------- */
  /* Organizations and workspaces                                           */
  /* ---------------------------------------------------------------------- */

  async createOrganizationWithWorkspace(input: {
    organizationName: string;
    organizationSlug: string;
    workspaceName: string;
    workspaceSlug: string;
    ownerUserId: string;
  }) {
    return this.db.transaction(async (tx) => {
      const orgId = newId();
      const wsId = newId();

      const [org] = await tx
        .insert(organizations)
        .values({ id: orgId, name: input.organizationName, slug: input.organizationSlug })
        .returning();

      const [ws] = await tx
        .insert(workspaces)
        .values({
          id: wsId,
          organizationId: orgId,
          name: input.workspaceName,
          slug: input.workspaceSlug,
          isDefault: true,
        })
        .returning();

      await tx.insert(memberships).values({
        id: newId(),
        organizationId: orgId,
        workspaceId: wsId,
        userId: input.ownerUserId,
        role: 'owner',
        status: 'active',
        joinedAt: new Date(),
      });

      if (!org || !ws) throw new Error('Failed to create organization');
      return { organization: org, workspace: ws };
    });
  }

  async getWorkspace(workspaceId: string) {
    const [row] = await this.db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
      .limit(1);
    return row ?? null;
  }

  async updateWorkspace(ctx: TenantContext, patch: Partial<typeof workspaces.$inferInsert>) {
    requirePermission(ctx, 'settings:update');
    const [row] = await this.db
      .update(workspaces)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(workspaces.id, ctx.workspaceId))
      .returning();
    if (!row) throw new NotFoundError('Workspace');
    return row;
  }

  /** All workspaces the user is an active member of, used by the workspace switcher. */
  async listWorkspacesForUser(userId: string) {
    return this.db
      .select({
        id: workspaces.id,
        organizationId: workspaces.organizationId,
        name: workspaces.name,
        slug: workspaces.slug,
        isDefault: workspaces.isDefault,
        locale: workspaces.locale,
        role: memberships.role,
      })
      .from(memberships)
      .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.status, 'active'),
          isNull(memberships.deletedAt),
          isNull(workspaces.deletedAt),
        ),
      )
      .orderBy(desc(workspaces.isDefault), workspaces.name);
  }

  /**
   * The authorization root. Returns null when the user is not an active member, which is
   * what every request handler checks before constructing a TenantContext.
   */
  async getMembership(userId: string, workspaceId: string) {
    const [row] = await this.db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.workspaceId, workspaceId),
          eq(memberships.status, 'active'),
          isNull(memberships.deletedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async listMembers(ctx: TenantContext) {
    requirePermission(ctx, 'member:read');
    const rows = await this.db
      .select({
        membership: memberships,
        user: users,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.workspaceId, ctx.workspaceId), isNull(memberships.deletedAt)))
      .orderBy(users.fullName);

    const userIds = rows.map((r) => r.user.id);
    const [groupRows, factorRows, sessionRows] = await Promise.all([
      userIds.length
        ? this.db
            .select({ userId: groupMembers.userId, groupId: groups.id, name: groups.name })
            .from(groupMembers)
            .innerJoin(groups, eq(groups.id, groupMembers.groupId))
            .where(
              and(inArray(groupMembers.userId, userIds), eq(groups.workspaceId, ctx.workspaceId)),
            )
        : [],
      userIds.length
        ? this.db
            .select({ userId: authFactors.userId, kind: authFactors.kind })
            .from(authFactors)
            .where(and(inArray(authFactors.userId, userIds), eq(authFactors.status, 'active')))
        : [],
      userIds.length
        ? this.db
            .select({ userId: sessions.userId, value: count() })
            .from(sessions)
            .where(
              and(
                inArray(sessions.userId, userIds),
                isNull(sessions.revokedAt),
                gt(sessions.expiresAt, new Date()),
              ),
            )
            .groupBy(sessions.userId)
        : [],
    ]);

    const groupsByUser = new Map<string, Array<{ id: string; name: string }>>();
    for (const g of groupRows) {
      const list = groupsByUser.get(g.userId) ?? [];
      list.push({ id: g.groupId, name: g.name });
      groupsByUser.set(g.userId, list);
    }
    const mfaUsers = new Set(factorRows.filter((f) => f.kind !== 'recovery').map((f) => f.userId));
    const sessionsByUser = new Map(sessionRows.map((s) => [s.userId, Number(s.value)]));

    return rows.map((r) => ({
      ...r,
      groups: groupsByUser.get(r.user.id) ?? [],
      mfaEnabled: mfaUsers.has(r.user.id),
      activeSessions: sessionsByUser.get(r.user.id) ?? 0,
    }));
  }

  /**
   * Role changes go through `canAssignRole`, so an Admin can never promote themselves to
   * Owner nor demote an Owner. The check lives here rather than in the route so a queue
   * consumer or script cannot skip it.
   */
  /**
   * Removes somebody from a workspace.
   *
   * Soft, and deliberately: the audit trail names the actor by user id, and hard-deleting
   * the row would leave every entry they ever produced pointing at nothing. Their sessions
   * go immediately — the point of removing access is that it stops now, not at the next
   * token expiry — and the rows that carry authority, group memberships, go with them so a
   * later re-invitation starts from nothing rather than silently restoring what they had.
   *
   * The same three guards as suspension, for the same reasons: not yourself, not somebody
   * at or above your own level, and never the last active Owner.
   */
  async removeMembership(ctx: TenantContext, targetUserId: string) {
    requirePermission(ctx, 'member:remove');
    const target = await this.getMembershipAnyStatus(targetUserId, ctx.workspaceId);
    if (!target) throw new NotFoundError('Member');

    if (targetUserId === ctx.userId) {
      throw new AuthorizationError('member:remove', 'You cannot remove your own account');
    }
    if (!canAssignRole(ctx.role, target.role as Role, target.role as Role)) {
      throw new AuthorizationError(
        'member:remove',
        'You cannot remove somebody at or above your own level',
      );
    }
    if (target.role === 'owner') {
      const [remaining] = await this.db
        .select({ value: count() })
        .from(memberships)
        .where(
          and(
            eq(memberships.workspaceId, ctx.workspaceId),
            eq(memberships.role, 'owner'),
            eq(memberships.status, 'active'),
            isNull(memberships.deletedAt),
          ),
        );
      if (Number(remaining?.value ?? 0) <= 1) {
        throw new AuthorizationError(
          'member:remove',
          'A workspace must keep at least one active Owner',
        );
      }
    }

    await this.db.transaction(async (tx) => {
      // Group membership is scoped through the group, which belongs to the workspace, so
      // the join is how "their groups here" is expressed — a plain delete by user id would
      // strip them from groups in every other workspace they belong to.
      const workspaceGroups = await tx
        .select({ id: groups.id })
        .from(groups)
        .where(eq(groups.workspaceId, ctx.workspaceId));
      const groupIds = workspaceGroups.map((g) => g.id);
      if (groupIds.length > 0) {
        await tx
          .delete(groupMembers)
          .where(
            and(eq(groupMembers.userId, targetUserId), inArray(groupMembers.groupId, groupIds)),
          );
      }
      await tx
        .update(memberships)
        // `deletedAt` is the marker, and the only one: every membership query already
        // filters on it, and inventing a 'removed' status would say the same thing twice
        // in a column whose permitted values are checked in the database.
        .set({ deletedAt: new Date(), version: target.version + 1 })
        .where(
          and(eq(memberships.workspaceId, ctx.workspaceId), eq(memberships.userId, targetUserId)),
        );
    });

    const revoked = await this.revokeAllSessionsForUser(targetUserId);
    return { role: target.role, revokedSessions: revoked };
  }

  async updateMembership(
    ctx: TenantContext,
    targetUserId: string,
    patch: { role?: Role; status?: 'active' | 'suspended' },
  ) {
    requirePermission(ctx, 'member:update');
    const target = await this.getMembershipAnyStatus(targetUserId, ctx.workspaceId);
    if (!target) throw new NotFoundError('Member');

    if (patch.role && patch.role !== target.role) {
      if (!canAssignRole(ctx.role, target.role as Role, patch.role)) {
        throw new AuthorizationError(
          'member:update',
          'You cannot assign a role at or above your own level',
        );
      }
    }

    if (patch.status === 'suspended') {
      requirePermission(ctx, 'member:suspend');
      if (targetUserId === ctx.userId) {
        throw new AuthorizationError('member:suspend', 'You cannot suspend your own account');
      }
      // Refuse to suspend the last active Owner.
      if (target.role === 'owner') {
        const [remaining] = await this.db
          .select({ value: count() })
          .from(memberships)
          .where(
            and(
              eq(memberships.workspaceId, ctx.workspaceId),
              eq(memberships.role, 'owner'),
              eq(memberships.status, 'active'),
              isNull(memberships.deletedAt),
            ),
          );
        if (Number(remaining?.value ?? 0) <= 1) {
          throw new AuthorizationError(
            'member:suspend',
            'A workspace must keep at least one active Owner',
          );
        }
      }
    }

    const [row] = await this.db
      .update(memberships)
      .set({ ...patch, version: target.version + 1, updatedAt: new Date() })
      .where(
        and(eq(memberships.workspaceId, ctx.workspaceId), eq(memberships.userId, targetUserId)),
      )
      .returning();
    if (!row) throw new NotFoundError('Member');
    return row;
  }

  async getMembershipAnyStatus(userId: string, workspaceId: string) {
    const [row] = await this.db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.workspaceId, workspaceId),
          isNull(memberships.deletedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async addMembership(input: {
    organizationId: string;
    workspaceId: string;
    userId: string;
    role: string;
    status?: string;
  }) {
    const [row] = await this.db
      .insert(memberships)
      .values({
        id: newId(),
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        role: input.role,
        status: input.status ?? 'active',
        joinedAt: input.status === 'invited' ? null : new Date(),
        invitedAt: input.status === 'invited' ? new Date() : null,
      })
      .onConflictDoNothing()
      .returning();
    return row ?? null;
  }

  /* ---------------------------------------------------------------------- */
  /* Groups                                                                 */
  /* ---------------------------------------------------------------------- */

  async listGroups(ctx: TenantContext) {
    return this.db
      .select()
      .from(groups)
      .where(and(eq(groups.workspaceId, ctx.workspaceId), isNull(groups.deletedAt)))
      .orderBy(groups.name);
  }

  async createGroup(ctx: TenantContext, name: string, description?: string) {
    requirePermission(ctx, 'group:manage');
    const [row] = await this.db
      .insert(groups)
      .values({ id: newId(), workspaceId: ctx.workspaceId, name, description: description ?? null })
      .returning();
    if (!row) throw new Error('Failed to create group');
    return row;
  }

  async setUserGroups(ctx: TenantContext, userId: string, groupIds: string[]) {
    requirePermission(ctx, 'group:manage');
    const owned = await this.db
      .select({ id: groups.id })
      .from(groups)
      .where(
        and(
          eq(groups.workspaceId, ctx.workspaceId),
          inArray(groups.id, groupIds.length ? groupIds : ['-']),
        ),
      );
    const allowed = new Set(owned.map((g) => g.id));

    await this.db.transaction(async (tx) => {
      const workspaceGroups = await tx
        .select({ id: groups.id })
        .from(groups)
        .where(eq(groups.workspaceId, ctx.workspaceId));
      const ids = workspaceGroups.map((g) => g.id);
      if (ids.length > 0) {
        await tx
          .delete(groupMembers)
          .where(and(eq(groupMembers.userId, userId), inArray(groupMembers.groupId, ids)));
      }
      const rows = [...allowed].map((groupId) => ({ id: newId(), groupId, userId }));
      if (rows.length > 0) await tx.insert(groupMembers).values(rows);
    });
  }

  async groupIdsForUser(userId: string, workspaceId: string) {
    const rows = await this.db
      .select({ groupId: groupMembers.groupId })
      .from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .where(and(eq(groupMembers.userId, userId), eq(groups.workspaceId, workspaceId)));
    return rows.map((r) => r.groupId);
  }

  /* ---------------------------------------------------------------------- */
  /* Sessions                                                               */
  /* ---------------------------------------------------------------------- */

  async createSession(input: {
    userId: string;
    tokenHash: string;
    csrfSecret: string;
    activeWorkspaceId: string | null;
    ipAddress: string | null;
    userAgent: string | null;
    rememberMe: boolean;
    mfaSatisfied: boolean;
    idleMinutes: number;
    absoluteHours: number;
  }) {
    const now = new Date();
    const [row] = await this.db
      .insert(sessions)
      .values({
        id: newId(),
        userId: input.userId,
        tokenHash: input.tokenHash,
        csrfSecret: input.csrfSecret,
        activeWorkspaceId: input.activeWorkspaceId,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        rememberMe: input.rememberMe,
        mfaSatisfied: input.mfaSatisfied,
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + input.idleMinutes * 60_000),
        absoluteExpiresAt: new Date(now.getTime() + input.absoluteHours * 3_600_000),
      })
      .returning();
    if (!row) throw new Error('Failed to create session');
    return row;
  }

  async findSessionByTokenHash(tokenHash: string) {
    const [row] = await this.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.tokenHash, tokenHash),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, new Date()),
          gt(sessions.absoluteExpiresAt, new Date()),
          isNull(users.deletedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Sliding idle expiry, capped by the absolute lifetime set at sign-in.
   *
   * The new expiry is computed in SQL from `now()` rather than from a JavaScript Date, so
   * it uses the database clock (the single source of truth for every other timestamp) and
   * avoids binding a Date inside a raw fragment, which postgres-js cannot encode.
   */
  async touchSession(sessionId: string, idleMinutes: number) {
    await this.db
      .update(sessions)
      .set({
        lastSeenAt: sql`now()`,
        expiresAt: sql`LEAST(now() + (interval '1 minute' * ${idleMinutes}), ${sessions.absoluteExpiresAt})`,
      })
      .where(eq(sessions.id, sessionId));
  }

  /** Rotates the session token in place — used after MFA and after privilege changes. */
  async rotateSessionToken(sessionId: string, newTokenHash: string, newCsrfSecret: string) {
    await this.db
      .update(sessions)
      .set({ tokenHash: newTokenHash, csrfSecret: newCsrfSecret })
      .where(eq(sessions.id, sessionId));
  }

  async setSessionWorkspace(sessionId: string, workspaceId: string) {
    await this.db
      .update(sessions)
      .set({ activeWorkspaceId: workspaceId })
      .where(eq(sessions.id, sessionId));
  }

  async setSessionMfaSatisfied(sessionId: string) {
    await this.db.update(sessions).set({ mfaSatisfied: true }).where(eq(sessions.id, sessionId));
  }

  async revokeSession(sessionId: string) {
    await this.db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
  }

  async revokeAllSessionsForUser(userId: string, exceptSessionId?: string) {
    const rows = await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          exceptSessionId ? sql`${sessions.id} <> ${exceptSessionId}` : sql`true`,
        ),
      )
      .returning({ id: sessions.id });
    return rows.length;
  }

  async listSessionsForUser(userId: string) {
    return this.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(sessions.lastSeenAt));
  }

  async purgeExpiredSessions() {
    const rows = await this.db
      .delete(sessions)
      .where(or(lt(sessions.absoluteExpiresAt, new Date()), lt(sessions.expiresAt, new Date())))
      .returning({ id: sessions.id });
    return rows.length;
  }

  /* ---------------------------------------------------------------------- */
  /* Tokens and MFA factors                                                 */
  /* ---------------------------------------------------------------------- */

  async createAuthToken(input: {
    userId: string | null;
    email: string | null;
    kind: string;
    tokenHash: string;
    ttlMinutes: number;
    metadata?: Record<string, unknown>;
  }) {
    const [row] = await this.db
      .insert(authTokens)
      .values({
        id: newId(),
        userId: input.userId,
        email: input.email,
        kind: input.kind,
        tokenHash: input.tokenHash,
        metadata: input.metadata ?? {},
        expiresAt: new Date(Date.now() + input.ttlMinutes * 60_000),
      })
      .returning();
    if (!row) throw new Error('Failed to create token');
    return row;
  }

  /**
   * Atomically consumes a token: the UPDATE only matches while `consumed_at IS NULL`, so
   * two concurrent uses of the same reset link cannot both succeed.
   */
  async consumeAuthToken(tokenHash: string, kind: string) {
    const [row] = await this.db
      .update(authTokens)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(authTokens.tokenHash, tokenHash),
          eq(authTokens.kind, kind),
          isNull(authTokens.consumedAt),
          gt(authTokens.expiresAt, new Date()),
        ),
      )
      .returning();
    return row ?? null;
  }

  async findAuthToken(tokenHash: string, kind: string) {
    const [row] = await this.db
      .select()
      .from(authTokens)
      .where(
        and(
          eq(authTokens.tokenHash, tokenHash),
          eq(authTokens.kind, kind),
          isNull(authTokens.consumedAt),
          gt(authTokens.expiresAt, new Date()),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async listFactors(userId: string) {
    return this.db.select().from(authFactors).where(eq(authFactors.userId, userId));
  }

  async listActiveFactors(userId: string) {
    return this.db
      .select()
      .from(authFactors)
      .where(and(eq(authFactors.userId, userId), eq(authFactors.status, 'active')));
  }

  async createFactor(input: {
    userId: string;
    kind: string;
    label?: string | null;
    secretEncrypted?: string | null;
    credentialId?: string | null;
    publicKey?: string | null;
    transports?: string[];
    status?: string;
  }) {
    const [row] = await this.db
      .insert(authFactors)
      .values({
        id: newId(),
        userId: input.userId,
        kind: input.kind,
        label: input.label ?? null,
        secretEncrypted: input.secretEncrypted ?? null,
        credentialId: input.credentialId ?? null,
        publicKey: input.publicKey ?? null,
        transports: input.transports ?? [],
        status: input.status ?? 'pending',
      })
      .returning();
    if (!row) throw new Error('Failed to create auth factor');
    return row;
  }

  async activateFactor(factorId: string, recoveryHashes: string[]) {
    await this.db
      .update(authFactors)
      .set({ status: 'active', recoveryHashes, updatedAt: new Date() })
      .where(eq(authFactors.id, factorId));
  }

  async getFactor(factorId: string) {
    const [row] = await this.db
      .select()
      .from(authFactors)
      .where(eq(authFactors.id, factorId))
      .limit(1);
    return row ?? null;
  }

  async touchFactor(factorId: string) {
    await this.db
      .update(authFactors)
      .set({ lastUsedAt: new Date() })
      .where(eq(authFactors.id, factorId));
  }

  async consumeRecoveryCode(factorId: string, remaining: string[]) {
    await this.db
      .update(authFactors)
      .set({ recoveryHashes: remaining, lastUsedAt: new Date() })
      .where(eq(authFactors.id, factorId));
  }

  /* ---------------------------------------------------------------------- */
  /* OAuth and invitations                                                  */
  /* ---------------------------------------------------------------------- */

  async findOAuthAccount(provider: string, providerAccountId: string) {
    const [row] = await this.db
      .select()
      .from(oauthAccounts)
      .where(
        and(
          eq(oauthAccounts.provider, provider),
          eq(oauthAccounts.providerAccountId, providerAccountId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async linkOAuthAccount(input: {
    userId: string;
    provider: string;
    providerAccountId: string;
    email: string | null;
    refreshTokenEncrypted: string | null;
    scopes: string[];
  }) {
    const [row] = await this.db
      .insert(oauthAccounts)
      .values({ id: newId(), ...input })
      .onConflictDoNothing()
      .returning();
    return row ?? null;
  }

  async createInvitation(
    ctx: TenantContext,
    input: {
      email: string;
      role: string;
      tokenHash: string;
      groupIds: string[];
      message?: string | null;
      ttlHours: number;
    },
  ) {
    requirePermission(ctx, 'member:invite');
    if (!canAssignRole(ctx.role, 'read_only', input.role as Role)) {
      throw new AuthorizationError('member:invite', 'You cannot invite at or above your own level');
    }
    const [row] = await this.db
      .insert(invitations)
      .values({
        id: newId(),
        workspaceId: ctx.workspaceId,
        organizationId: ctx.organizationId,
        email: input.email.toLowerCase(),
        role: input.role,
        tokenHash: input.tokenHash,
        invitedByUserId: ctx.userId,
        groupIds: input.groupIds,
        message: input.message ?? null,
        expiresAt: new Date(Date.now() + input.ttlHours * 3_600_000),
      })
      .returning();
    if (!row) throw new Error('Failed to create invitation');
    return row;
  }

  async findInvitation(tokenHash: string) {
    const [row] = await this.db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.tokenHash, tokenHash),
          eq(invitations.status, 'pending'),
          gt(invitations.expiresAt, new Date()),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Whether this address has an invitation still waiting to be accepted.
   *
   * Read without a tenant context on purpose: the caller is the registration endpoint,
   * which has no session and is deciding what to put in an email to the address itself. It
   * returns a boolean rather than the invitation, so nothing about which workspace invited
   * whom can leak through it.
   */
  async hasPendingInvitation(email: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: invitations.id })
      .from(invitations)
      .where(
        and(
          eq(invitations.email, email.toLowerCase()),
          eq(invitations.status, 'pending'),
          gt(invitations.expiresAt, new Date()),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  async acceptInvitation(invitationId: string) {
    await this.db
      .update(invitations)
      .set({ status: 'accepted', acceptedAt: new Date() })
      .where(eq(invitations.id, invitationId));
  }

  /**
   * Activates the membership an invitation created.
   *
   * Deliberately takes no `TenantContext`: the caller is the invited person, who is not yet
   * a member of anything and therefore cannot hold one. The invitation token is the
   * authorisation, and it has already been verified against its stored hash.
   */
  async activateInvitedMembership(input: {
    workspaceId: string;
    userId: string;
    role: string;
    groupIds: string[];
  }) {
    const [row] = await this.db
      .update(memberships)
      .set({ status: 'active', role: input.role, joinedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(memberships.workspaceId, input.workspaceId),
          eq(memberships.userId, input.userId),
          isNull(memberships.deletedAt),
        ),
      )
      .returning();

    for (const groupId of input.groupIds) {
      await this.db
        .insert(groupMembers)
        .values({ id: newId(), groupId, userId: input.userId })
        .onConflictDoNothing();
    }

    return row ?? null;
  }

  /* ---------------------------------------------------------------------- */
  /* Preferences                                                            */
  /* ---------------------------------------------------------------------- */

  async getPreferences(userId: string, workspaceId: string | null) {
    const [row] = await this.db
      .select()
      .from(userPreferences)
      .where(
        and(
          eq(userPreferences.userId, userId),
          workspaceId
            ? eq(userPreferences.workspaceId, workspaceId)
            : isNull(userPreferences.workspaceId),
        ),
      )
      .limit(1);
    return row?.preferences ?? {};
  }

  async setPreferences(
    userId: string,
    workspaceId: string | null,
    preferences: Record<string, unknown>,
  ) {
    await this.db
      .insert(userPreferences)
      .values({ id: newId(), userId, workspaceId, preferences })
      .onConflictDoUpdate({
        target: [userPreferences.userId, userPreferences.workspaceId],
        set: { preferences, updatedAt: new Date() },
      });
  }
}
