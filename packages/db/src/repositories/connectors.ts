import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../client.js';
import { sourceConnectors } from '../schema/index.js';
import { newId } from '../ids.js';
import {
  NotFoundError,
  VersionConflictError,
  requirePermission,
  type TenantContext,
} from '../tenant.js';

export type ConnectorRow = typeof sourceConnectors.$inferSelect;

/**
 * The file stores a workspace has attached.
 *
 * One connection per kind per workspace: two Drive grants in the same workspace would
 * make "sync from Drive" ambiguous, and nothing in the product asks for it. Reconnecting
 * replaces the grant rather than adding a second one.
 *
 * The stored credential is a refresh token and never leaves this class. Callers get rows
 * through `list` and `get`, which do not select it; only `credentialFor` does, and it is
 * the only path the sync worker uses.
 */
export class ConnectorRepository {
  constructor(private readonly db: Database) {}

  private readonly columns = {
    id: sourceConnectors.id,
    organizationId: sourceConnectors.organizationId,
    workspaceId: sourceConnectors.workspaceId,
    kind: sourceConnectors.kind,
    displayName: sourceConnectors.displayName,
    accountEmail: sourceConnectors.accountEmail,
    config: sourceConnectors.config,
    status: sourceConnectors.status,
    lastError: sourceConnectors.lastError,
    lastSyncedAt: sourceConnectors.lastSyncedAt,
    createdByUserId: sourceConnectors.createdByUserId,
    version: sourceConnectors.version,
    createdAt: sourceConnectors.createdAt,
    updatedAt: sourceConnectors.updatedAt,
  };

  async list(ctx: TenantContext) {
    requirePermission(ctx, 'settings:read');
    return this.db
      .select(this.columns)
      .from(sourceConnectors)
      .where(
        and(eq(sourceConnectors.workspaceId, ctx.workspaceId), isNull(sourceConnectors.deletedAt)),
      )
      .orderBy(sourceConnectors.kind);
  }

  async getByKind(ctx: TenantContext, kind: string) {
    requirePermission(ctx, 'settings:read');
    const [row] = await this.db
      .select(this.columns)
      .from(sourceConnectors)
      .where(
        and(
          eq(sourceConnectors.workspaceId, ctx.workspaceId),
          eq(sourceConnectors.kind, kind),
          isNull(sourceConnectors.deletedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async getById(ctx: TenantContext, connectorId: string) {
    requirePermission(ctx, 'settings:read');
    const [row] = await this.db
      .select(this.columns)
      .from(sourceConnectors)
      .where(
        and(
          eq(sourceConnectors.id, connectorId),
          eq(sourceConnectors.workspaceId, ctx.workspaceId),
          isNull(sourceConnectors.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Connector');
    return row;
  }

  /**
   * Records a completed grant, replacing any previous one for the same kind.
   *
   * `credentialEncrypted` is written here and read only by `credentialFor`, so a refresh
   * token cannot reach an API response by way of a repository that returns whole rows.
   */
  async connect(
    ctx: TenantContext,
    input: {
      kind: string;
      displayName: string;
      accountEmail: string | null;
      credentialEncrypted: string;
      config?: Record<string, unknown>;
    },
  ) {
    requirePermission(ctx, 'settings:connectors');

    const existing = await this.db
      .select({ id: sourceConnectors.id })
      .from(sourceConnectors)
      .where(
        and(
          eq(sourceConnectors.workspaceId, ctx.workspaceId),
          eq(sourceConnectors.kind, input.kind),
          isNull(sourceConnectors.deletedAt),
        ),
      )
      .limit(1);

    const values = {
      displayName: input.displayName,
      accountEmail: input.accountEmail,
      credentialEncrypted: input.credentialEncrypted,
      config: input.config ?? {},
      status: 'connected',
      lastError: null,
      updatedAt: new Date(),
    };

    if (existing[0]) {
      const [row] = await this.db
        .update(sourceConnectors)
        .set(values)
        .where(eq(sourceConnectors.id, existing[0].id))
        .returning(this.columns);
      if (!row) throw new NotFoundError('Connector');
      return row;
    }

    const [row] = await this.db
      .insert(sourceConnectors)
      .values({
        id: newId(),
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
        kind: input.kind,
        createdByUserId: ctx.userId,
        ...values,
      })
      .returning(this.columns);
    if (!row) throw new Error('Connector insert returned no row');
    return row;
  }

  async update(
    ctx: TenantContext,
    connectorId: string,
    input: { config?: Record<string, unknown>; expectedVersion: number },
  ) {
    requirePermission(ctx, 'settings:connectors');
    const current = await this.getById(ctx, connectorId);
    if (current.version !== input.expectedVersion) {
      throw new VersionConflictError('Connector', input.expectedVersion, current.version);
    }

    const [row] = await this.db
      .update(sourceConnectors)
      .set({
        ...(input.config ? { config: input.config } : {}),
        updatedAt: new Date(),
      })
      .where(eq(sourceConnectors.id, connectorId))
      .returning(this.columns);
    if (!row) throw new NotFoundError('Connector');
    return row;
  }

  /**
   * Drops the grant.
   *
   * The credential is cleared in the same statement as the soft delete, so a disconnected
   * connector cannot leave a usable refresh token behind in a row nothing reads any more.
   */
  async disconnect(ctx: TenantContext, connectorId: string) {
    requirePermission(ctx, 'settings:connectors');
    await this.getById(ctx, connectorId);
    await this.db
      .update(sourceConnectors)
      .set({
        credentialEncrypted: null,
        status: 'disconnected',
        deletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(sourceConnectors.id, connectorId));
  }

  async setStatus(
    connectorId: string,
    status: string,
    options: { lastError?: string | null; lastSyncedAt?: Date | null } = {},
  ) {
    await this.db
      .update(sourceConnectors)
      .set({
        status,
        ...(options.lastError !== undefined ? { lastError: options.lastError } : {}),
        ...(options.lastSyncedAt !== undefined ? { lastSyncedAt: options.lastSyncedAt } : {}),
        updatedAt: new Date(),
      })
      .where(eq(sourceConnectors.id, connectorId));
  }

  /**
   * The encrypted refresh token, for the sync worker alone.
   *
   * Deliberately not part of any row this class otherwise returns: a credential should
   * have to be asked for by name.
   */
  async credentialFor(workspaceId: string, connectorId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ credential: sourceConnectors.credentialEncrypted })
      .from(sourceConnectors)
      .where(
        and(
          eq(sourceConnectors.id, connectorId),
          eq(sourceConnectors.workspaceId, workspaceId),
          isNull(sourceConnectors.deletedAt),
        ),
      )
      .limit(1);
    return row?.credential ?? null;
  }
}
