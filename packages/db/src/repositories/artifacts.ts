import { and, count, desc, eq, gte, ilike, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  auditEvents,
  uploadTickets,
  correctionChanges,
  correctionPlans,
  consultations,
  deletionRequests,
  generatedArtifacts,
  idempotencyRecords,
  modelConfigurations,
  processingJobs,
  reports,
  retentionPolicies,
  sources,
} from '../schema/index.js';
import { newId } from '../ids.js';
import {
  NotFoundError,
  VersionConflictError,
  requirePermission,
  type TenantContext,
} from '../tenant.js';

export class ArtifactRepository {
  constructor(private readonly db: Database) {}

  async create(
    ctx: TenantContext,
    input: {
      kind: string;
      title: string;
      documentType: string;
      contentType: string;
      storageKey: string;
      sizeBytes: number;
      sha256: string;
      consultationId?: string | null;
      reviewId?: string | null;
      planId?: string | null;
      sourceId?: string | null;
      sourceVersionId?: string | null;
      generatorDescriptor: string;
      changeLog?: Array<Record<string, unknown>>;
      disclosures?: string[];
      validation?: Record<string, unknown>;
      retainUntil?: Date | null;
      status?: string;
    },
  ) {
    const [row] = await this.db
      .insert(generatedArtifacts)
      .values({
        id: newId(),
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
        kind: input.kind,
        title: input.title,
        documentType: input.documentType,
        contentType: input.contentType,
        storageKey: input.storageKey,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256,
        consultationId: input.consultationId ?? null,
        reviewId: input.reviewId ?? null,
        planId: input.planId ?? null,
        sourceId: input.sourceId ?? null,
        sourceVersionId: input.sourceVersionId ?? null,
        generatorDescriptor: input.generatorDescriptor,
        changeLog: input.changeLog ?? [],
        disclosures: input.disclosures ?? [],
        validation: input.validation ?? {},
        retainUntil: input.retainUntil ?? null,
        status: input.status ?? 'ready',
        createdByUserId: ctx.userId,
      })
      .returning();
    if (!row) throw new Error('Failed to create artifact');
    return row;
  }

  async getById(ctx: TenantContext, id: string) {
    requirePermission(ctx, 'artifact:read');
    const [row] = await this.db
      .select()
      .from(generatedArtifacts)
      .where(
        and(
          eq(generatedArtifacts.id, id),
          eq(generatedArtifacts.workspaceId, ctx.workspaceId),
          isNull(generatedArtifacts.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Artifact');
    return row;
  }

  async list(
    ctx: TenantContext,
    params: {
      q?: string;
      kind?: string;
      status?: string;
      consultationId?: string;
      page: number;
      pageSize: number;
    },
  ) {
    requirePermission(ctx, 'artifact:read');
    const filters = [
      eq(generatedArtifacts.workspaceId, ctx.workspaceId),
      isNull(generatedArtifacts.deletedAt),
    ];
    if (params.kind && params.kind !== 'all')
      filters.push(eq(generatedArtifacts.kind, params.kind));
    if (params.status && params.status !== 'all') {
      filters.push(eq(generatedArtifacts.status, params.status));
    }
    if (params.consultationId) {
      filters.push(eq(generatedArtifacts.consultationId, params.consultationId));
    }
    if (params.q?.trim()) filters.push(ilike(generatedArtifacts.title, `%${params.q.trim()}%`));

    const where = and(...filters);
    const [items, totalRow] = await Promise.all([
      this.db
        .select({
          artifact: generatedArtifacts,
          consultationTitle: consultations.title,
          sourceTitle: sources.title,
        })
        .from(generatedArtifacts)
        .leftJoin(consultations, eq(consultations.id, generatedArtifacts.consultationId))
        .leftJoin(sources, eq(sources.id, generatedArtifacts.sourceId))
        .where(where)
        .orderBy(desc(generatedArtifacts.createdAt))
        .limit(params.pageSize)
        .offset((params.page - 1) * params.pageSize),
      this.db.select({ value: count() }).from(generatedArtifacts).where(where),
    ]);

    return { items, total: Number(totalRow[0]?.value ?? 0) };
  }

  async setStatus(id: string, status: string, patch: Record<string, unknown> = {}) {
    await this.db
      .update(generatedArtifacts)
      .set({ status, ...patch })
      .where(eq(generatedArtifacts.id, id));
  }

  async softDelete(ctx: TenantContext, id: string) {
    requirePermission(ctx, 'artifact:delete');
    await this.getById(ctx, id);
    await this.db
      .update(generatedArtifacts)
      .set({ deletedAt: new Date(), status: 'archived' })
      .where(
        and(eq(generatedArtifacts.id, id), eq(generatedArtifacts.workspaceId, ctx.workspaceId)),
      );
  }

  async createReport(
    ctx: TenantContext,
    input: {
      artifactId: string;
      kind: string;
      title: string;
      summary?: string | null;
      consultationId?: string | null;
      reviewId?: string | null;
    },
  ) {
    const [row] = await this.db
      .insert(reports)
      .values({
        id: newId(),
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
        artifactId: input.artifactId,
        kind: input.kind,
        title: input.title,
        summary: input.summary ?? null,
        consultationId: input.consultationId ?? null,
        reviewId: input.reviewId ?? null,
        createdByUserId: ctx.userId,
      })
      .returning();
    return row ?? null;
  }
}

export class CorrectionRepository {
  constructor(private readonly db: Database) {}

  async createPlan(
    ctx: TenantContext,
    input: {
      consultationId: string;
      sourceId: string;
      sourceVersionId: string;
      reviewId?: string | null;
      outputStrategy: string;
      limitations: string[];
      signatureNotice: string | null;
      instructions?: string | null;
    },
  ) {
    requirePermission(ctx, 'correction:create');
    const [row] = await this.db
      .insert(correctionPlans)
      .values({
        id: newId(),
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
        consultationId: input.consultationId,
        sourceId: input.sourceId,
        sourceVersionId: input.sourceVersionId,
        reviewId: input.reviewId ?? null,
        outputStrategy: input.outputStrategy,
        limitations: input.limitations,
        signatureNotice: input.signatureNotice,
        instructions: input.instructions ?? null,
        status: 'draft',
        createdByUserId: ctx.userId,
      })
      .returning();
    if (!row) throw new Error('Failed to create correction plan');
    return row;
  }

  async getPlan(ctx: TenantContext, planId: string) {
    const [row] = await this.db
      .select()
      .from(correctionPlans)
      .where(and(eq(correctionPlans.id, planId), eq(correctionPlans.workspaceId, ctx.workspaceId)))
      .limit(1);
    if (!row) throw new NotFoundError('Correction plan');
    return row;
  }

  /**
   * Every correction plan for a consultation, newest first.
   *
   * Without this a plan is only reachable through the job that created it, so a page
   * refresh loses the review the user was in the middle of.
   */
  async listPlansForConsultation(ctx: TenantContext, consultationId: string) {
    return this.db
      .select()
      .from(correctionPlans)
      .where(
        and(
          eq(correctionPlans.consultationId, consultationId),
          eq(correctionPlans.workspaceId, ctx.workspaceId),
        ),
      )
      .orderBy(desc(correctionPlans.createdAt));
  }

  async addChanges(
    ctx: TenantContext,
    planId: string,
    changes: Array<{
      ordinal: number;
      locatorLabel: string;
      pageNumber: number | null;
      paragraphIndex: number | null;
      sheetName: string | null;
      cellRange: string | null;
      slideNumber: number | null;
      charStart: number | null;
      charEnd: number | null;
      currentContent: string;
      proposedContent: string;
      reason: string;
      governingCitationId: string | null;
      findingId: string | null;
      risk: string;
      confidence: number;
    }>,
  ) {
    if (changes.length === 0) return [];
    const rows = changes.map((c) => ({
      id: newId(),
      planId,
      workspaceId: ctx.workspaceId,
      status: 'proposed',
      ...c,
    }));
    await this.db.insert(correctionChanges).values(rows);
    return rows;
  }

  async listChanges(ctx: TenantContext, planId: string) {
    await this.getPlan(ctx, planId);
    return this.db
      .select()
      .from(correctionChanges)
      .where(eq(correctionChanges.planId, planId))
      .orderBy(correctionChanges.ordinal);
  }

  /**
   * Records accept/reject/edit decisions. Optimistic concurrency on the plan stops two
   * reviewers silently overwriting one another's decisions.
   */
  async decide(
    ctx: TenantContext,
    planId: string,
    expectedVersion: number,
    decisions: Array<{ changeId: string; status: string; editedContent: string | null }>,
  ) {
    requirePermission(ctx, 'correction:decide');
    const plan = await this.getPlan(ctx, planId);
    if (plan.version !== expectedVersion) {
      throw new VersionConflictError('Correction plan', expectedVersion, plan.version);
    }

    await this.db.transaction(async (tx) => {
      for (const d of decisions) {
        await tx
          .update(correctionChanges)
          .set({
            status: d.status,
            editedContent: d.editedContent,
            decidedByUserId: ctx.userId,
            decidedAt: new Date(),
          })
          .where(
            and(
              eq(correctionChanges.id, d.changeId),
              eq(correctionChanges.planId, planId),
              eq(correctionChanges.workspaceId, ctx.workspaceId),
            ),
          );
      }

      const remaining = await tx
        .select({ value: count() })
        .from(correctionChanges)
        .where(and(eq(correctionChanges.planId, planId), eq(correctionChanges.status, 'proposed')));

      await tx
        .update(correctionPlans)
        .set({
          version: plan.version + 1,
          status: Number(remaining[0]?.value ?? 0) === 0 ? 'ready' : 'draft',
          updatedAt: new Date(),
        })
        .where(eq(correctionPlans.id, planId));
    });

    return this.getPlan(ctx, planId);
  }

  /** Only accepted and hand-edited changes are ever written into a derivative document. */
  async acceptedChanges(ctx: TenantContext, planId: string) {
    return this.db
      .select()
      .from(correctionChanges)
      .where(
        and(
          eq(correctionChanges.planId, planId),
          eq(correctionChanges.workspaceId, ctx.workspaceId),
          inArray(correctionChanges.status, ['accepted', 'edited']),
        ),
      )
      .orderBy(correctionChanges.ordinal);
  }

  async setPlanStatus(planId: string, status: string, patch: Record<string, unknown> = {}) {
    await this.db
      .update(correctionPlans)
      .set({ status, ...patch, updatedAt: new Date() })
      .where(eq(correctionPlans.id, planId));
  }
}

export class AuditRepository {
  constructor(private readonly db: Database) {}

  /**
   * Append-only. There is intentionally no update or delete method on this repository,
   * and the migration revokes UPDATE/DELETE on the table from the application role.
   */
  async record(input: {
    organizationId: string;
    workspaceId: string | null;
    actorUserId: string | null;
    actorName: string;
    actorType?: string;
    action: string;
    category: string;
    targetType?: string | null;
    targetId?: string | null;
    targetLabel?: string | null;
    result?: string;
    ipAddress?: string | null;
    userAgent?: string | null;
    traceId: string;
    summary: string;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  }) {
    await this.db.insert(auditEvents).values({
      id: newId(),
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      actorName: input.actorName,
      actorType: input.actorType ?? 'user',
      action: input.action,
      category: input.category,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      targetLabel: input.targetLabel ?? null,
      result: input.result ?? 'success',
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      traceId: input.traceId,
      summary: input.summary,
      before: input.before ?? null,
      after: input.after ?? null,
    });
  }

  async list(
    ctx: TenantContext,
    params: {
      q?: string;
      category?: string;
      actorId?: string;
      result?: string;
      from?: Date;
      to?: Date;
      page: number;
      pageSize: number;
    },
  ) {
    requirePermission(ctx, 'audit:read');
    const filters = [eq(auditEvents.organizationId, ctx.organizationId)];
    filters.push(
      or(eq(auditEvents.workspaceId, ctx.workspaceId), isNull(auditEvents.workspaceId)) ??
        sql`true`,
    );
    if (params.category && params.category !== 'all') {
      filters.push(eq(auditEvents.category, params.category));
    }
    if (params.actorId) filters.push(eq(auditEvents.actorUserId, params.actorId));
    if (params.result && params.result !== 'all')
      filters.push(eq(auditEvents.result, params.result));
    if (params.from) filters.push(gte(auditEvents.createdAt, params.from));
    if (params.to) filters.push(lte(auditEvents.createdAt, params.to));
    if (params.q?.trim()) {
      const term = `%${params.q.trim()}%`;
      filters.push(
        or(
          ilike(auditEvents.summary, term),
          ilike(auditEvents.action, term),
          ilike(auditEvents.targetLabel, term),
        ) ?? sql`true`,
      );
    }

    const where = and(...filters);
    const [items, totalRow] = await Promise.all([
      this.db
        .select()
        .from(auditEvents)
        .where(where)
        .orderBy(desc(auditEvents.createdAt))
        .limit(params.pageSize)
        .offset((params.page - 1) * params.pageSize),
      this.db.select({ value: count() }).from(auditEvents).where(where),
    ]);

    return { items, total: Number(totalRow[0]?.value ?? 0) };
  }
}

export class SettingsRepository {
  constructor(private readonly db: Database) {}

  /**
   * Removes a configuration outright.
   *
   * There is no soft delete here: the row holds an encrypted provider credential, and
   * "removed" has to mean the key is gone, not hidden. A primary that is deleted leaves the
   * capability without one, and the resolver falls back to the deterministic engine — which
   * is the correct outcome, and a visible one, rather than a silent switch to another key.
   */
  async deleteModelConfiguration(ctx: TenantContext, id: string) {
    requirePermission(ctx, 'settings:models');
    const [row] = await this.db
      .delete(modelConfigurations)
      .where(
        and(eq(modelConfigurations.id, id), eq(modelConfigurations.workspaceId, ctx.workspaceId)),
      )
      .returning();
    if (!row) throw new NotFoundError('Model configuration');
    return row;
  }

  async listModelConfigurations(ctx: TenantContext) {
    requirePermission(ctx, 'settings:read');
    return this.db
      .select()
      .from(modelConfigurations)
      .where(eq(modelConfigurations.workspaceId, ctx.workspaceId))
      .orderBy(modelConfigurations.capability, desc(modelConfigurations.isPrimary));
  }

  /** Returns the primary configuration for a capability, skipping open circuit breakers. */
  async primaryFor(ctx: TenantContext, capability: string) {
    const rows = await this.db
      .select()
      .from(modelConfigurations)
      .where(
        and(
          eq(modelConfigurations.workspaceId, ctx.workspaceId),
          eq(modelConfigurations.capability, capability),
          eq(modelConfigurations.enabled, true),
        ),
      )
      .orderBy(desc(modelConfigurations.isPrimary));

    const now = new Date();
    const usable = rows.filter((r) => !r.circuitOpenUntil || r.circuitOpenUntil < now);
    return usable[0] ?? rows[0] ?? null;
  }

  async fallbackFor(ctx: TenantContext, capability: string) {
    const [row] = await this.db
      .select()
      .from(modelConfigurations)
      .where(
        and(
          eq(modelConfigurations.workspaceId, ctx.workspaceId),
          eq(modelConfigurations.capability, capability),
          eq(modelConfigurations.isFallback, true),
          eq(modelConfigurations.enabled, true),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async upsertModelConfiguration(
    ctx: TenantContext,
    input: {
      capability: string;
      provider: string;
      model: string;
      reasoningEffort: string | null;
      isPrimary: boolean;
      isFallback: boolean;
      enabled: boolean;
      credentialEncrypted: string | null;
      credentialLast4: string | null;
    },
  ) {
    requirePermission(ctx, 'settings:models');
    return this.db.transaction(async (tx) => {
      if (input.isPrimary) {
        await tx
          .update(modelConfigurations)
          .set({ isPrimary: false })
          .where(
            and(
              eq(modelConfigurations.workspaceId, ctx.workspaceId),
              eq(modelConfigurations.capability, input.capability),
            ),
          );
      }

      const [row] = await tx
        .insert(modelConfigurations)
        .values({
          id: newId(),
          organizationId: ctx.organizationId,
          workspaceId: ctx.workspaceId,
          capability: input.capability,
          provider: input.provider,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          isPrimary: input.isPrimary,
          isFallback: input.isFallback,
          enabled: input.enabled,
          credentialEncrypted: input.credentialEncrypted,
          credentialLast4: input.credentialLast4,
          health:
            input.provider === 'deterministic'
              ? 'healthy'
              : input.credentialEncrypted
                ? 'unknown'
                : 'unconfigured',
        })
        .onConflictDoUpdate({
          target: [
            modelConfigurations.workspaceId,
            modelConfigurations.capability,
            modelConfigurations.provider,
            modelConfigurations.model,
          ],
          set: {
            reasoningEffort: input.reasoningEffort,
            isPrimary: input.isPrimary,
            isFallback: input.isFallback,
            enabled: input.enabled,
            // A null credential on update means "leave the stored key alone" — and the
            // hint has to move with it, or the list would name a key that is no longer there.
            ...(input.credentialEncrypted
              ? {
                  credentialEncrypted: input.credentialEncrypted,
                  credentialLast4: input.credentialLast4,
                }
              : {}),
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!row) throw new Error('Failed to save model configuration');
      return row;
    });
  }

  async setModelHealth(
    id: string,
    health: string,
    detail: string | null,
    opts: { openCircuitMs?: number; resetFailures?: boolean } = {},
  ) {
    await this.db
      .update(modelConfigurations)
      .set({
        health,
        healthDetail: detail,
        lastCheckedAt: new Date(),
        consecutiveFailures: opts.resetFailures
          ? 0
          : sql`${modelConfigurations.consecutiveFailures} + 1`,
        circuitOpenUntil: opts.openCircuitMs ? new Date(Date.now() + opts.openCircuitMs) : null,
        updatedAt: new Date(),
      })
      .where(eq(modelConfigurations.id, id));
  }

  async recordUsage(id: string, tokens: number) {
    await this.db
      .update(modelConfigurations)
      .set({
        tokensUsed30d: sql`${modelConfigurations.tokensUsed30d} + ${tokens}`,
        requestsUsed30d: sql`${modelConfigurations.requestsUsed30d} + 1`,
      })
      .where(eq(modelConfigurations.id, id));
  }

  async getModelConfiguration(ctx: TenantContext, id: string) {
    const [row] = await this.db
      .select()
      .from(modelConfigurations)
      .where(
        and(eq(modelConfigurations.id, id), eq(modelConfigurations.workspaceId, ctx.workspaceId)),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Model configuration');
    return row;
  }

  async getRetentionPolicy(ctx: TenantContext) {
    const [row] = await this.db
      .select()
      .from(retentionPolicies)
      .where(eq(retentionPolicies.workspaceId, ctx.workspaceId))
      .limit(1);
    if (row) return row;
    const [created] = await this.db
      .insert(retentionPolicies)
      .values({
        id: newId(),
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
      })
      .onConflictDoNothing()
      .returning();
    return created ?? null;
  }

  async updateRetentionPolicy(ctx: TenantContext, patch: Record<string, unknown>) {
    requirePermission(ctx, 'settings:retention');
    await this.getRetentionPolicy(ctx);
    const [row] = await this.db
      .update(retentionPolicies)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(retentionPolicies.workspaceId, ctx.workspaceId))
      .returning();
    return row ?? null;
  }

  async createDeletionRequest(
    ctx: TenantContext,
    input: { targetType: string; targetId: string; reason?: string; graceDays: number },
  ) {
    const [row] = await this.db
      .insert(deletionRequests)
      .values({
        id: newId(),
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
        requestedByUserId: ctx.userId,
        targetType: input.targetType,
        targetId: input.targetId,
        reason: input.reason ?? null,
        scheduledFor: new Date(Date.now() + input.graceDays * 86_400_000),
      })
      .returning();
    return row ?? null;
  }

  async dueDeletions(limit = 50) {
    return this.db
      .select()
      .from(deletionRequests)
      .where(
        and(eq(deletionRequests.status, 'pending'), lte(deletionRequests.scheduledFor, new Date())),
      )
      .limit(limit);
  }

  /** Records the proof-of-completion payload alongside the completed request. */
  async completeDeletion(id: string, proof: Record<string, unknown>) {
    await this.db
      .update(deletionRequests)
      .set({ status: 'completed', completedAt: new Date(), proof, updatedAt: new Date() })
      .where(eq(deletionRequests.id, id));
  }
}

export class IdempotencyRepository {
  constructor(private readonly db: Database) {}

  async find(workspaceId: string, endpoint: string, key: string) {
    const [row] = await this.db
      .select()
      .from(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.workspaceId, workspaceId),
          eq(idempotencyRecords.endpoint, endpoint),
          eq(idempotencyRecords.idempotencyKey, key),
          sql`${idempotencyRecords.expiresAt} > now()`,
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async save(input: {
    workspaceId: string;
    userId: string;
    endpoint: string;
    idempotencyKey: string;
    requestHash: string;
    statusCode: number;
    responseBody: Record<string, unknown>;
    ttlHours?: number;
  }) {
    await this.db
      .insert(idempotencyRecords)
      .values({
        id: newId(),
        workspaceId: input.workspaceId,
        userId: input.userId,
        endpoint: input.endpoint,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        statusCode: input.statusCode,
        responseBody: input.responseBody,
        expiresAt: new Date(Date.now() + (input.ttlHours ?? 24) * 3_600_000),
      })
      .onConflictDoNothing();
  }

  async purgeExpired() {
    const rows = await this.db
      .delete(idempotencyRecords)
      .where(sql`${idempotencyRecords.expiresAt} < now()`)
      .returning({ id: idempotencyRecords.id });
    return rows.length;
  }
}

export class UploadTicketRepository {
  constructor(private readonly db: Database) {}

  async create(
    ctx: TenantContext,
    input: {
      sourceId: string;
      consultationId?: string | null;
      fileName: string;
      contentType: string;
      declaredBytes: number;
      storageKey: string;
      promoteToKnowledge: boolean;
      tags: string[];
      accessScope: string;
      ttlHours?: number;
    },
  ) {
    const [row] = await this.db
      .insert(uploadTickets)
      .values({
        id: newId(),
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        sourceId: input.sourceId,
        consultationId: input.consultationId ?? null,
        fileName: input.fileName,
        contentType: input.contentType,
        declaredBytes: input.declaredBytes,
        storageKey: input.storageKey,
        promoteToKnowledge: input.promoteToKnowledge,
        tags: input.tags,
        accessScope: input.accessScope,
        expiresAt: new Date(Date.now() + (input.ttlHours ?? 2) * 3_600_000),
      })
      .returning();
    if (!row) throw new Error('Failed to create upload ticket');
    return row;
  }

  /** Only the ticket's own creator, in its own workspace, may complete it. */
  async findPending(ctx: TenantContext, ticketId: string) {
    const [row] = await this.db
      .select()
      .from(uploadTickets)
      .where(
        and(
          eq(uploadTickets.id, ticketId),
          eq(uploadTickets.workspaceId, ctx.workspaceId),
          eq(uploadTickets.userId, ctx.userId),
          eq(uploadTickets.status, 'pending'),
          sql`${uploadTickets.expiresAt} > now()`,
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async markReceived(ticketId: string, receivedBytes: number) {
    await this.db
      .update(uploadTickets)
      .set({ status: 'received', receivedBytes, completedAt: new Date() })
      .where(eq(uploadTickets.id, ticketId));
  }

  async purgeExpired() {
    const rows = await this.db
      .delete(uploadTickets)
      .where(and(eq(uploadTickets.status, 'pending'), sql`${uploadTickets.expiresAt} < now()`))
      .returning({ id: uploadTickets.id });
    return rows.length;
  }
}

/** Aggregates per-stage progress across in-flight ingestion jobs for the pipeline panel. */
export class PipelineRepository {
  constructor(private readonly db: Database) {}

  async recentIngestJobs(workspaceId: string, limit = 200) {
    return this.db
      .select({
        id: processingJobs.id,
        stages: processingJobs.stages,
        status: processingJobs.status,
        // Carried so a blocked stage can name the document that blocked it rather than
        // only counting it, and so the view can keep the newest attempt per document.
        targetId: processingJobs.targetId,
        startedAt: processingJobs.startedAt,
        createdAt: processingJobs.createdAt,
      })
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.workspaceId, workspaceId),
          inArray(processingJobs.kind, ['source_ingest', 'source_reprocess', 'source_sync']),
        ),
      )
      .orderBy(desc(processingJobs.createdAt))
      .limit(limit);
  }

  /**
   * Titles for a set of sources, so a stage can name the document it is stuck on.
   *
   * Deleted sources are left out, and a caller that finds no title should drop the entry:
   * a job outlives the document it ran on, and a pipeline that still lists a document
   * somebody removed is reporting work that no longer matters.
   */
  async titlesForSources(sourceIds: string[]): Promise<Map<string, string>> {
    if (sourceIds.length === 0) return new Map();
    const rows = await this.db
      .select({ id: sources.id, title: sources.title })
      .from(sources)
      .where(and(inArray(sources.id, sourceIds), isNull(sources.deletedAt)));
    return new Map(rows.map((row) => [row.id, row.title]));
  }
}
