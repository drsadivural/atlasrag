import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  groupMembers,
  sourceChunks,
  sourcePermissions,
  sourceSections,
  sourceVersions,
  sources,
} from '../schema/index.js';
import { newId } from '../ids.js';
import {
  AuthorizationError,
  NotFoundError,
  VersionConflictError,
  assertSameTenant,
  hasPermission,
  requirePermission,
  type TenantContext,
} from '../tenant.js';

/**
 * The single visibility predicate for knowledge sources.
 *
 * Every read path -- list, detail, retrieval, citation resolution, download, search --
 * composes this. Having exactly one definition is deliberate: a second, subtly different
 * copy is how "the search index leaks documents the list page hides" bugs happen.
 *
 * A source is visible when it lives in the caller's workspace, is not soft-deleted, and
 * either is scoped to the whole workspace, or is scoped to a group the caller belongs to,
 * or names the caller directly, or is owned by the caller. Admins and Owners (who hold
 * `source:permissions`) see everything in their own workspace for audit purposes.
 */
export function visibleSourcePredicate(ctx: TenantContext) {
  const tenantScope = and(
    eq(sources.workspaceId, ctx.workspaceId),
    eq(sources.organizationId, ctx.organizationId),
    isNull(sources.deletedAt),
  );

  if (hasPermission(ctx, 'source:permissions')) {
    return tenantScope;
  }

  // Bound as a single text[] parameter -- never interpolated into the statement text.
  const groupIds = [...ctx.groupIds];

  const aclMatch = sql`EXISTS (
    SELECT 1 FROM ${sourcePermissions} sp
    WHERE sp.source_id = ${sources.id}
      AND (
        sp.scope = 'workspace'
        OR (sp.scope = 'users' AND sp.user_id = ${ctx.userId})
        OR (sp.scope = 'group' AND sp.group_id = ANY(${sql.param(groupIds)}::text[]))
      )
  )`;

  return and(
    tenantScope,
    or(eq(sources.accessScope, 'workspace'), eq(sources.ownerUserId, ctx.userId), aclMatch),
  );
}

export interface ListSourcesParams {
  q?: string | undefined;
  status?: string;
  documentType?: string;
  tag?: string | undefined;
  ownerId?: string | undefined;
  sort?: string;
  page: number;
  pageSize: number;
  /** The knowledge-base listing hides consultation uploads that were never promoted. */
  onlyPromoted?: boolean;
}

export class SourceRepository {
  constructor(private readonly db: Database) {}

  /** Group memberships are resolved once per request and folded into the TenantContext. */
  async groupIdsForUser(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ groupId: groupMembers.groupId })
      .from(groupMembers)
      .where(eq(groupMembers.userId, userId));
    return rows.map((r) => r.groupId);
  }

  async list(ctx: TenantContext, params: ListSourcesParams) {
    requirePermission(ctx, 'source:read');
    const filters = [visibleSourcePredicate(ctx)];

    if (params.onlyPromoted !== false) filters.push(eq(sources.promotedToKnowledge, true));
    if (params.status && params.status !== 'all') filters.push(eq(sources.status, params.status));
    if (params.documentType && params.documentType !== 'all') {
      filters.push(eq(sources.documentType, params.documentType));
    }
    if (params.ownerId) filters.push(eq(sources.ownerUserId, params.ownerId));
    if (params.tag) filters.push(sql`${sources.tags} @> ${JSON.stringify([params.tag])}::jsonb`);
    if (params.q && params.q.trim()) {
      const term = `%${params.q.trim()}%`;
      filters.push(or(ilike(sources.title, term), ilike(sources.description, term)));
    }

    const where = and(...filters);
    const orderBy =
      params.sort === 'title_asc'
        ? [asc(sources.title)]
        : params.sort === 'title_desc'
          ? [desc(sources.title)]
          : params.sort === 'updated_asc'
            ? [asc(sources.updatedAt)]
            : params.sort === 'status'
              ? [asc(sources.status), desc(sources.updatedAt)]
              : [desc(sources.updatedAt)];

    const [items, totalRow] = await Promise.all([
      this.db
        .select()
        .from(sources)
        .where(where)
        .orderBy(...orderBy)
        .limit(params.pageSize)
        .offset((params.page - 1) * params.pageSize),
      this.db.select({ value: count() }).from(sources).where(where),
    ]);

    return { items, total: Number(totalRow[0]?.value ?? 0) };
  }

  /** Status counts for the filter chips, computed under the same visibility predicate. */
  async statusCounts(ctx: TenantContext) {
    requirePermission(ctx, 'source:read');
    const rows = await this.db
      .select({ status: sources.status, value: count() })
      .from(sources)
      .where(and(visibleSourcePredicate(ctx), eq(sources.promotedToKnowledge, true)))
      .groupBy(sources.status);

    const byStatus = Object.fromEntries(rows.map((r) => [r.status, Number(r.value)]));
    const pick = (...keys: string[]) => keys.reduce((sum, k) => sum + (byStatus[k] ?? 0), 0);

    return {
      all: rows.reduce((sum, r) => sum + Number(r.value), 0),
      ready: pick('ready'),
      processing: pick('pending', 'scanning', 'extracting', 'indexing', 'validating'),
      needs_review: pick('needs_review', 'quarantined'),
      failed: pick('failed'),
      archived: pick('archived'),
    };
  }

  /**
   * Reads a single source through the visibility predicate. A source the caller may not
   * see raises NotFound rather than Forbidden, so probing IDs discloses nothing.
   */
  async getById(ctx: TenantContext, sourceId: string) {
    requirePermission(ctx, 'source:read');
    const [row] = await this.db
      .select()
      .from(sources)
      .where(and(eq(sources.id, sourceId), visibleSourcePredicate(ctx)))
      .limit(1);
    if (!row) throw new NotFoundError('Source');
    return row;
  }

  /** Bulk visibility filter used by retrieval before any vector or lexical search runs. */
  async filterVisibleSourceIds(ctx: TenantContext, sourceIds: string[]): Promise<string[]> {
    if (sourceIds.length === 0) return [];
    const rows = await this.db
      .select({ id: sources.id })
      .from(sources)
      .where(and(inArray(sources.id, sourceIds), visibleSourcePredicate(ctx)));
    return rows.map((r) => r.id);
  }

  async create(
    ctx: TenantContext,
    input: {
      title: string;
      documentType: string;
      description?: string | null;
      tags?: string[];
      accessScope?: string;
      connectorId?: string | null;
      connectorKind?: string | null;
      externalId?: string | null;
      externalUrl?: string | null;
      promotedToKnowledge: boolean;
      status?: string;
    },
  ) {
    requirePermission(ctx, 'source:create');
    const id = newId();
    const [row] = await this.db
      .insert(sources)
      .values({
        id,
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
        title: input.title,
        description: input.description ?? null,
        documentType: input.documentType,
        status: input.status ?? 'pending',
        tags: input.tags ?? [],
        accessScope: input.accessScope ?? 'workspace',
        ownerUserId: ctx.userId,
        connectorId: input.connectorId ?? null,
        connectorKind: input.connectorKind ?? null,
        externalId: input.externalId ?? null,
        externalUrl: input.externalUrl ?? null,
        promotedToKnowledge: input.promotedToKnowledge,
      })
      .returning();
    if (!row) throw new Error('Failed to create source');

    // An ACL row is written even for the default workspace scope so permission queries
    // only ever have one shape to reason about.
    await this.db.insert(sourcePermissions).values({
      id: newId(),
      sourceId: id,
      workspaceId: ctx.workspaceId,
      scope: input.accessScope ?? 'workspace',
      capability: 'read',
    });

    return row;
  }

  async update(
    ctx: TenantContext,
    sourceId: string,
    expectedVersion: number,
    patch: Partial<{
      title: string;
      description: string | null;
      tags: string[];
      accessScope: string;
      effectiveDate: Date | null;
      status: string;
      promotedToKnowledge: boolean;
    }>,
  ) {
    requirePermission(ctx, 'source:update');
    const current = await this.getById(ctx, sourceId);
    if (current.version !== expectedVersion) {
      throw new VersionConflictError('Source', expectedVersion, current.version);
    }

    const [row] = await this.db
      .update(sources)
      .set({ ...patch, version: current.version + 1, updatedAt: new Date() })
      .where(
        and(
          eq(sources.id, sourceId),
          eq(sources.workspaceId, ctx.workspaceId),
          eq(sources.version, expectedVersion),
        ),
      )
      .returning();

    if (!row) throw new VersionConflictError('Source', expectedVersion, current.version);
    return row;
  }

  /** Replaces the ACL rows for a source. Requires the dedicated permission. */
  async setPermissions(
    ctx: TenantContext,
    sourceId: string,
    scope: 'workspace' | 'group' | 'users',
    subjectIds: string[],
  ) {
    requirePermission(ctx, 'source:permissions');
    await this.getById(ctx, sourceId);

    await this.db.delete(sourcePermissions).where(eq(sourcePermissions.sourceId, sourceId));

    const rows =
      scope === 'workspace'
        ? [{ id: newId(), sourceId, workspaceId: ctx.workspaceId, scope, capability: 'read' }]
        : subjectIds.map((subjectId) => ({
            id: newId(),
            sourceId,
            workspaceId: ctx.workspaceId,
            scope,
            capability: 'read',
            ...(scope === 'group' ? { groupId: subjectId } : { userId: subjectId }),
          }));

    if (rows.length > 0) await this.db.insert(sourcePermissions).values(rows);
    await this.db
      .update(sources)
      .set({ accessScope: scope, updatedAt: new Date() })
      .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, ctx.workspaceId)));
  }

  async listPermissions(ctx: TenantContext, sourceId: string) {
    await this.getById(ctx, sourceId);
    return this.db.select().from(sourcePermissions).where(eq(sourcePermissions.sourceId, sourceId));
  }

  /**
   * Soft delete. Citations keep resolving for authorized audit users until the retention
   * purge runs, which is what keeps historical evidence reproducible.
   */
  async softDelete(ctx: TenantContext, sourceId: string) {
    requirePermission(ctx, 'source:delete');
    await this.getById(ctx, sourceId);
    await this.db
      .update(sources)
      .set({ deletedAt: new Date(), status: 'archived', updatedAt: new Date() })
      .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, ctx.workspaceId)));
  }

  async archive(ctx: TenantContext, sourceId: string) {
    requirePermission(ctx, 'source:archive');
    await this.getById(ctx, sourceId);
    await this.db
      .update(sources)
      .set({ status: 'archived', updatedAt: new Date() })
      .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, ctx.workspaceId)));
  }

  /* ---------------------------------------------------------------------- */
  /* Versions                                                               */
  /* ---------------------------------------------------------------------- */

  async listVersions(ctx: TenantContext, sourceId: string) {
    await this.getById(ctx, sourceId);
    return this.db
      .select()
      .from(sourceVersions)
      .where(and(eq(sourceVersions.sourceId, sourceId), isNull(sourceVersions.deletedAt)))
      .orderBy(desc(sourceVersions.versionNumber));
  }

  /**
   * Finds an existing version anywhere in the workspace with these exact bytes.
   *
   * Checked before a new upload is accepted so re-uploading a file the workspace already
   * holds points the user at the existing source rather than silently creating a second
   * copy that would then need de-duplicating, re-indexing and re-permissioning.
   */
  async findDuplicateInWorkspace(ctx: TenantContext, sha256: string, excludeSourceId?: string) {
    const [row] = await this.db
      .select({ version: sourceVersions, source: sources })
      .from(sourceVersions)
      .innerJoin(sources, eq(sources.id, sourceVersions.sourceId))
      .where(
        and(
          eq(sourceVersions.workspaceId, ctx.workspaceId),
          eq(sourceVersions.sha256, sha256),
          isNull(sources.deletedAt),
          excludeSourceId ? sql`${sources.id} <> ${excludeSourceId}` : sql`true`,
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Hard-deletes a source that never received content, used to undo a duplicate upload. */
  async discardEmptySource(ctx: TenantContext, sourceId: string) {
    const [existing] = await this.db
      .select({ currentVersionId: sources.currentVersionId })
      .from(sources)
      .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, ctx.workspaceId)))
      .limit(1);
    // Refuse to hard-delete anything that ever became citable.
    if (!existing || existing.currentVersionId !== null) return false;
    await this.db
      .delete(sources)
      .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, ctx.workspaceId)));
    return true;
  }

  /**
   * Returns the existing row when the same bytes are uploaded again as a new version of
   * the SAME source, instead of creating a duplicate version.
   */
  async findVersionBySha(sourceId: string, sha256: string) {
    const [row] = await this.db
      .select()
      .from(sourceVersions)
      .where(and(eq(sourceVersions.sourceId, sourceId), eq(sourceVersions.sha256, sha256)))
      .limit(1);
    return row ?? null;
  }

  async createVersion(
    ctx: TenantContext,
    input: {
      sourceId: string;
      sha256: string;
      storageKey: string;
      contentType: string;
      sizeBytes: number;
      pages?: number | null;
      notes?: string | null;
    },
  ) {
    requirePermission(ctx, 'source:create');
    const existing = await this.findVersionBySha(input.sourceId, input.sha256);
    if (existing) return { version: existing, duplicate: true as const };

    const [maxRow] = await this.db
      .select({ maxNumber: sql<number>`coalesce(max(${sourceVersions.versionNumber}), 0)` })
      .from(sourceVersions)
      .where(eq(sourceVersions.sourceId, input.sourceId));

    const versionNumber = Number(maxRow?.maxNumber ?? 0) + 1;
    const [row] = await this.db
      .insert(sourceVersions)
      .values({
        id: newId(),
        sourceId: input.sourceId,
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
        version: `v${versionNumber}.0`,
        versionNumber,
        sha256: input.sha256,
        storageKey: input.storageKey,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        pages: input.pages ?? null,
        notes: input.notes ?? null,
        status: 'pending',
        isCurrent: false,
        createdByUserId: ctx.userId,
      })
      .returning();
    if (!row) throw new Error('Failed to create source version');
    return { version: row, duplicate: false as const };
  }

  /**
   * Atomically promotes a validated version to current. Wrapped in a transaction so there
   * is never a moment where two versions claim `is_current`, or where none do.
   */
  async promoteVersion(ctx: TenantContext, sourceId: string, versionId: string) {
    requirePermission(ctx, 'source:update');
    return this.db.transaction(async (tx) => {
      const [version] = await tx
        .select()
        .from(sourceVersions)
        .where(and(eq(sourceVersions.id, versionId), eq(sourceVersions.sourceId, sourceId)))
        .limit(1);
      assertSameTenant(ctx, version, 'Source version');
      if (!version) throw new NotFoundError('Source version');

      await tx
        .update(sourceVersions)
        .set({ isCurrent: false })
        .where(eq(sourceVersions.sourceId, sourceId));

      const now = new Date();
      await tx
        .update(sourceVersions)
        .set({ isCurrent: true, promotedAt: now, status: 'ready' })
        .where(eq(sourceVersions.id, versionId));

      await tx
        .update(sources)
        .set({
          currentVersionId: versionId,
          status: 'ready',
          failureReason: null,
          updatedAt: now,
          lastSyncedAt: now,
        })
        .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, ctx.workspaceId)));

      return { ...version, isCurrent: true, promotedAt: now, status: 'ready' };
    });
  }

  async getCurrentVersion(ctx: TenantContext, sourceId: string) {
    await this.getById(ctx, sourceId);
    const [row] = await this.db
      .select()
      .from(sourceVersions)
      .where(and(eq(sourceVersions.sourceId, sourceId), eq(sourceVersions.isCurrent, true)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Resolves a version by id for citation replay. Deliberately does NOT require the version
   * to be current: an old consultation must keep resolving the exact version it cited.
   */
  async getVersionForCitation(ctx: TenantContext, versionId: string) {
    const [row] = await this.db
      .select({ version: sourceVersions, source: sources })
      .from(sourceVersions)
      .innerJoin(sources, eq(sources.id, sourceVersions.sourceId))
      .where(and(eq(sourceVersions.id, versionId), visibleSourcePredicate(ctx)))
      .limit(1);
    if (!row) throw new NotFoundError('Source version');
    return row;
  }

  async setVersionStatus(
    versionId: string,
    patch: Partial<{
      status: string;
      pages: number;
      ocrApplied: boolean;
      ocrConfidence: number;
      extractionCoverage: number;
      normalizedSha256: string;
      structure: Record<string, number>;
      metadata: Record<string, unknown>;
    }>,
  ) {
    await this.db.update(sourceVersions).set(patch).where(eq(sourceVersions.id, versionId));
  }

  async setSourceStatus(
    sourceId: string,
    patch: Partial<{
      status: string;
      failureReason: string | null;
      documentType: string;
      title: string;
      quarantine: Record<string, unknown> | null;
      promotedToKnowledge: boolean;
      lastSyncedAt: Date;
    }>,
  ) {
    await this.db
      .update(sources)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(sources.id, sourceId));
  }

  /**
   * Promotes a consultation upload into the knowledge base. This explicit action is what
   * keeps rule 6 true: uploads are never silently added as permanent knowledge.
   */
  async promoteToKnowledge(ctx: TenantContext, sourceId: string) {
    requirePermission(ctx, 'source:promote');
    const source = await this.getById(ctx, sourceId);
    if (source.promotedToKnowledge) return source;
    const [row] = await this.db
      .update(sources)
      .set({ promotedToKnowledge: true, updatedAt: new Date(), version: source.version + 1 })
      .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, ctx.workspaceId)))
      .returning();
    if (!row) throw new NotFoundError('Source');
    return row;
  }

  async structureCounts(versionId: string) {
    const [sections] = await this.db
      .select({
        headings: sql<number>`count(*) filter (where ${sourceSections.kind} = 'heading')`,
        clauses: sql<number>`count(*) filter (where ${sourceSections.clause} is not null)`,
        tables: sql<number>`count(*) filter (where ${sourceSections.kind} = 'table')`,
        definitions: sql<number>`count(*) filter (where ${sourceSections.kind} = 'definition')`,
      })
      .from(sourceSections)
      .where(eq(sourceSections.sourceVersionId, versionId));

    const [chunks] = await this.db
      .select({ value: count() })
      .from(sourceChunks)
      .where(eq(sourceChunks.sourceVersionId, versionId));

    return {
      headings: Number(sections?.headings ?? 0),
      clauses: Number(sections?.clauses ?? 0),
      tables: Number(sections?.tables ?? 0),
      definitions: Number(sections?.definitions ?? 0),
      chunks: Number(chunks?.value ?? 0),
    };
  }

  /** Inputs to the knowledge-health score. The formula itself lives in the API layer. */
  async healthMetrics(ctx: TenantContext) {
    requirePermission(ctx, 'source:read');
    const scope = and(visibleSourcePredicate(ctx), eq(sources.promotedToKnowledge, true));

    const [row] = await this.db
      .select({
        total: count(),
        ready: sql<number>`count(*) filter (where ${sources.status} = 'ready')`,
        failed: sql<number>`count(*) filter (where ${sources.status} = 'failed')`,
        needsReview: sql<number>`count(*) filter (where ${sources.status} in ('needs_review','quarantined'))`,
        processing: sql<number>`count(*) filter (where ${sources.status} in ('pending','scanning','extracting','indexing','validating'))`,
        missingMetadata: sql<number>`count(*) filter (where ${sources.effectiveDate} is null or jsonb_array_length(${sources.tags}) = 0)`,
        outdated: sql<number>`count(*) filter (where ${sources.lastSyncedAt} < now() - interval '180 days')`,
      })
      .from(sources)
      .where(scope);

    const [unlinked] = await this.db
      .select({ value: count() })
      .from(sources)
      .where(and(scope, isNull(sources.currentVersionId)));

    const dupeGroups = await this.db
      .select({ sha: sourceVersions.sha256 })
      .from(sourceVersions)
      .innerJoin(sources, eq(sources.id, sourceVersions.sourceId))
      .where(and(scope, eq(sourceVersions.isCurrent, true)))
      .groupBy(sourceVersions.sha256)
      .having(sql`count(*) > 1`);

    const [permissionIssues] = await this.db
      .select({ value: count() })
      .from(sources)
      .where(
        and(
          scope,
          sql`NOT EXISTS (SELECT 1 FROM ${sourcePermissions} sp WHERE sp.source_id = ${sources.id})`,
        ),
      );

    return {
      total: Number(row?.total ?? 0),
      ready: Number(row?.ready ?? 0),
      failed: Number(row?.failed ?? 0),
      needsReview: Number(row?.needsReview ?? 0),
      processing: Number(row?.processing ?? 0),
      missingMetadata: Number(row?.missingMetadata ?? 0),
      outdated: Number(row?.outdated ?? 0),
      unlinkedContent: Number(unlinked?.value ?? 0),
      duplicates: dupeGroups.length,
      permissionIssues: Number(permissionIssues?.value ?? 0),
    };
  }

  /** Guard used before any bulk mutation so one unauthorized ID fails the whole batch. */
  async assertAllVisible(ctx: TenantContext, sourceIds: string[]) {
    const visible = await this.filterVisibleSourceIds(ctx, sourceIds);
    if (visible.length !== sourceIds.length) {
      throw new AuthorizationError('source:read', 'One or more sources are not accessible to you');
    }
  }
}
