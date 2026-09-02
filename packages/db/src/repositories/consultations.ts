import { and, count, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  citations,
  complianceReviews,
  consultationParticipants,
  consultationSources,
  consultations,
  findings,
  messageAttachments,
  messages,
  requirements,
  sourceVersions,
  sources,
} from '../schema/index.js';
import { newId } from '../ids.js';
import {
  AuthorizationError,
  NotAuthorityError,
  NotFoundError,
  VersionConflictError,
  hasPermission,
  requirePermission,
  type TenantContext,
} from '../tenant.js';
import { visibleSourcePredicate } from './sources.js';

/**
 * A consultation is visible when it belongs to the caller's workspace and either the
 * caller owns it, is a listed participant, or holds `consultation:read_all`
 * (Reviewer and above). Owning a workspace does not by itself expose every colleague's
 * private consultation, which is why the participant join exists.
 */
function visibleConsultationPredicate(ctx: TenantContext) {
  const tenantScope = and(
    eq(consultations.workspaceId, ctx.workspaceId),
    eq(consultations.organizationId, ctx.organizationId),
    isNull(consultations.deletedAt),
  );

  if (hasPermission(ctx, 'consultation:read_all')) return tenantScope;

  return and(
    tenantScope,
    or(
      eq(consultations.ownerUserId, ctx.userId),
      sql`EXISTS (
        SELECT 1 FROM ${consultationParticipants} cp
        WHERE cp.consultation_id = ${consultations.id} AND cp.user_id = ${ctx.userId}
      )`,
    ),
  );
}

/**
 * The name a consultation is created with, and the only one an attachment may replace.
 *
 * Kept here rather than compared inline so the check and the value cannot drift: if the
 * default ever changes, renaming stops silently working instead of loudly failing.
 */
export const DEFAULT_CONSULTATION_TITLE = 'New consultation';
const DEFAULT_TITLE = DEFAULT_CONSULTATION_TITLE;

export class ConsultationRepository {
  constructor(private readonly db: Database) {}

  async list(
    ctx: TenantContext,
    params: { q?: string; status?: string; pinned?: boolean; page: number; pageSize: number },
  ) {
    requirePermission(ctx, 'consultation:read');
    const filters = [visibleConsultationPredicate(ctx)];
    if (params.status && params.status !== 'all') {
      filters.push(eq(consultations.status, params.status));
    }
    if (params.pinned !== undefined) filters.push(eq(consultations.pinned, params.pinned));
    if (params.q?.trim()) filters.push(ilike(consultations.title, `%${params.q.trim()}%`));

    const where = and(...filters);
    const [items, totalRow] = await Promise.all([
      this.db
        .select()
        .from(consultations)
        .where(where)
        .orderBy(desc(consultations.pinned), desc(consultations.updatedAt))
        .limit(params.pageSize)
        .offset((params.page - 1) * params.pageSize),
      this.db.select({ value: count() }).from(consultations).where(where),
    ]);

    const ids = items.map((i) => i.id);
    const counts = ids.length
      ? await this.db
          .select({
            consultationId: consultationSources.consultationId,
            role: consultationSources.role,
            value: count(),
          })
          .from(consultationSources)
          .where(inArray(consultationSources.consultationId, ids))
          .groupBy(consultationSources.consultationId, consultationSources.role)
      : [];

    const byId = new Map<string, { governing: number; project: number }>();
    for (const row of counts) {
      const entry = byId.get(row.consultationId) ?? { governing: 0, project: 0 };
      if (row.role === 'project') entry.project = Number(row.value);
      else entry.governing = Number(row.value);
      byId.set(row.consultationId, entry);
    }

    return {
      items: items.map((c) => ({
        ...c,
        sourceCount: byId.get(c.id)?.governing ?? 0,
        documentCount: byId.get(c.id)?.project ?? 0,
      })),
      total: Number(totalRow[0]?.value ?? 0),
    };
  }

  async getById(ctx: TenantContext, id: string) {
    requirePermission(ctx, 'consultation:read');
    const [row] = await this.db
      .select()
      .from(consultations)
      .where(and(eq(consultations.id, id), visibleConsultationPredicate(ctx)))
      .limit(1);
    if (!row) throw new NotFoundError('Consultation');
    return row;
  }

  async create(ctx: TenantContext, input: { title: string; taskMode: string }) {
    requirePermission(ctx, 'consultation:create');
    const id = newId();

    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(consultations)
        .values({
          id,
          organizationId: ctx.organizationId,
          workspaceId: ctx.workspaceId,
          title: input.title,
          taskMode: input.taskMode,
          status: 'draft',
          ownerUserId: ctx.userId,
        })
        .returning();
      if (!row) throw new Error('Failed to create consultation');

      await tx.insert(consultationParticipants).values({
        id: newId(),
        consultationId: id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        role: ctx.role,
      });

      return row;
    });
  }

  async update(
    ctx: TenantContext,
    id: string,
    expectedVersion: number,
    patch: Record<string, unknown>,
  ) {
    requirePermission(ctx, 'consultation:update');
    const current = await this.getById(ctx, id);
    if (current.version !== expectedVersion) {
      throw new VersionConflictError('Consultation', expectedVersion, current.version);
    }
    const [row] = await this.db
      .update(consultations)
      .set({ ...patch, version: current.version + 1, updatedAt: new Date() })
      .where(
        and(
          eq(consultations.id, id),
          eq(consultations.workspaceId, ctx.workspaceId),
          eq(consultations.version, expectedVersion),
        ),
      )
      .returning();
    if (!row) throw new VersionConflictError('Consultation', expectedVersion, current.version);
    return row;
  }

  /**
   * Removes a consultation by archiving it.
   *
   * `status` moves with `deletedAt`, because leaving the two to disagree is what produced
   * a workspace full of deleted consultations still labelled `action_required` — read by
   * everything downstream as live work waiting on somebody. A removed consultation is in
   * the archive, and the row now says so.
   */
  async softDelete(ctx: TenantContext, id: string) {
    requirePermission(ctx, 'consultation:delete');
    const current = await this.getById(ctx, id);
    /*
     * Only the owner or an admin may delete; a mere participant may not.
     *
     * Refused with 403 rather than 404. The caller has just read the consultation, so
     * claiming it does not exist hides nothing and misinforms: a reviewer, who can see
     * every consultation in the workspace, was told "Consultation not found" about a row
     * still on their screen. The rule is that they may not delete it, so that is what it
     * says.
     */
    if (current.ownerUserId !== ctx.userId && !hasPermission(ctx, 'workspace:update')) {
      throw new AuthorizationError(
        'consultation:delete',
        'You can only delete consultations you own.',
      );
    }
    await this.db
      .update(consultations)
      .set({ deletedAt: new Date(), status: 'archived', updatedAt: new Date() })
      .where(and(eq(consultations.id, id), eq(consultations.workspaceId, ctx.workspaceId)));
  }

  /* ---------------------------------------------------------------------- */
  /* Source selection                                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Replaces the consultation's sources for one role, pinning the version that is current
   * *right now*. A later source update creates a new version but does not move this
   * consultation onto it, so old citations keep resolving to exactly what was reviewed.
   *
   * The `governing` role is the compliance authority — the text every finding is measured
   * against — and only the knowledge base may hold it. A file uploaded inside ConsultNow is
   * the thing being inspected, never the thing it is inspected against, and that has to
   * hold on the server: the role travels in the request body, so a client asking for a
   * drawing to govern is one HTTP call away. Non-knowledge ids are dropped here rather than
   * rejected, because the same call legitimately carries a mixed selection.
   *
   * Uploading a document through the Knowledge page is what makes it an authority. Nothing
   * else does.
   */
  async setSources(
    ctx: TenantContext,
    consultationId: string,
    sourceIds: string[],
    role: 'governing' | 'project' = 'governing',
  ) {
    requirePermission(ctx, 'consultation:update');
    await this.getById(ctx, consultationId);

    const visible = await this.db
      .select({ id: sources.id, currentVersionId: sources.currentVersionId })
      .from(sources)
      .where(
        and(
          inArray(sources.id, sourceIds.length ? sourceIds : ['-']),
          visibleSourcePredicate(ctx),
          // Only the knowledge base may govern; see the note above.
          role === 'governing' ? eq(sources.promotedToKnowledge, true) : undefined,
        ),
      );

    return this.db.transaction(async (tx) => {
      await tx
        .delete(consultationSources)
        .where(
          and(
            eq(consultationSources.consultationId, consultationId),
            eq(consultationSources.role, role),
          ),
        );

      const rows = visible
        .filter((s) => s.currentVersionId !== null)
        .map((s) => ({
          id: newId(),
          consultationId,
          sourceId: s.id,
          sourceVersionId: s.currentVersionId as string,
          workspaceId: ctx.workspaceId,
          role,
        }));

      if (rows.length > 0) await tx.insert(consultationSources).values(rows);
      return rows.length;
    });
  }

  async addSource(
    ctx: TenantContext,
    consultationId: string,
    sourceId: string,
    sourceVersionId: string,
    role: 'governing' | 'project',
  ) {
    if (role === 'governing' && !(await this.isKnowledgeBaseSource(ctx, sourceId))) {
      throw new NotAuthorityError(sourceId);
    }
    /*
     * `returning()` is empty when the conflict clause swallowed the insert, and that
     * difference decides whether the consultation is renamed below.
     *
     * A document already attached as governing — which every approved source is, on a
     * consultation opened without a narrowed list — hits the conflict and changes nothing.
     * Renaming on the attempt rather than the insert named consultations after whichever
     * code they were being checked against.
     */
    const [attached] = await this.db
      .insert(consultationSources)
      .values({
        id: newId(),
        consultationId,
        sourceId,
        sourceVersionId,
        workspaceId: ctx.workspaceId,
        role,
      })
      .onConflictDoNothing()
      .returning({ id: consultationSources.id });

    if (attached && role === 'project') await this.nameAfterDocument(consultationId, sourceId);
  }

  /**
   * Gives the consultation the name of the document sent into it for review.
   *
   * Every consultation is created as "New consultation" and nobody renames it, so the list
   * of past consultations was three hundred rows of the same four words — no way to find
   * the one about a particular drawing, which is the only reason anybody opens the list.
   *
   * Two rules keep it honest. Only the default name is replaced, so a title somebody typed
   * is never overwritten by an attachment. And only the first document names it: a second
   * drawing added later does not rewrite the name the consultation has been known by.
   */
  private async nameAfterDocument(consultationId: string, sourceId: string): Promise<void> {
    const [source] = await this.db
      .select({ title: sources.title })
      .from(sources)
      .where(eq(sources.id, sourceId))
      .limit(1);
    if (!source?.title.trim()) return;

    await this.db
      .update(consultations)
      .set({ title: source.title.trim().slice(0, 200), updatedAt: new Date() })
      .where(and(eq(consultations.id, consultationId), eq(consultations.title, DEFAULT_TITLE)));
  }

  /** True only for a document published through the knowledge base. */
  private async isKnowledgeBaseSource(ctx: TenantContext, sourceId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: sources.id })
      .from(sources)
      .where(
        and(
          eq(sources.id, sourceId),
          visibleSourcePredicate(ctx),
          eq(sources.promotedToKnowledge, true),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  async listSources(ctx: TenantContext, consultationId: string) {
    await this.getById(ctx, consultationId);
    return this.db
      .select({
        sourceId: consultationSources.sourceId,
        sourceVersionId: consultationSources.sourceVersionId,
        role: consultationSources.role,
        title: sources.title,
        documentType: sources.documentType,
        status: sources.status,
        effectiveDate: sources.effectiveDate,
        version: sourceVersions.version,
        pages: sourceVersions.pages,
      })
      .from(consultationSources)
      .innerJoin(sources, eq(sources.id, consultationSources.sourceId))
      .innerJoin(sourceVersions, eq(sourceVersions.id, consultationSources.sourceVersionId))
      .where(eq(consultationSources.consultationId, consultationId));
  }

  /* ---------------------------------------------------------------------- */
  /* Messages                                                               */
  /* ---------------------------------------------------------------------- */

  async listMessages(ctx: TenantContext, consultationId: string) {
    await this.getById(ctx, consultationId);
    return this.db
      .select()
      .from(messages)
      .where(and(eq(messages.consultationId, consultationId), isNull(messages.deletedAt)))
      .orderBy(messages.createdAt);
  }

  async appendMessage(
    ctx: TenantContext,
    input: {
      consultationId: string;
      role: string;
      text: string;
      taskMode?: string | null;
      answerStyle?: string | null;
      answer?: Record<string, unknown> | null;
      parentMessageId?: string | null;
      jobId?: string | null;
      authorUserId?: string | null;
    },
  ) {
    const id = newId();
    const [row] = await this.db
      .insert(messages)
      .values({
        id,
        consultationId: input.consultationId,
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
        role: input.role,
        authorUserId: input.authorUserId ?? (input.role === 'user' ? ctx.userId : null),
        text: input.text,
        taskMode: input.taskMode ?? null,
        answerStyle: input.answerStyle ?? null,
        answer: input.answer ?? null,
        parentMessageId: input.parentMessageId ?? null,
        jobId: input.jobId ?? null,
      })
      .returning();
    if (!row) throw new Error('Failed to append message');

    await this.db
      .update(consultations)
      .set({ lastMessageAt: row.createdAt, updatedAt: new Date() })
      .where(eq(consultations.id, input.consultationId));

    return row;
  }

  /**
   * Persists the finished answer independently of the SSE stream, so a refresh or a
   * dropped connection never loses a result the user already paid for.
   */
  async completeMessage(
    messageId: string,
    patch: {
      text?: string;
      answer?: Record<string, unknown> | null;
      error?: Record<string, unknown> | null;
    },
  ) {
    await this.db.update(messages).set(patch).where(eq(messages.id, messageId));
  }

  async setFeedback(ctx: TenantContext, messageId: string, feedback: 'up' | 'down' | null) {
    const [row] = await this.db
      .select({ consultationId: messages.consultationId })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.workspaceId, ctx.workspaceId)))
      .limit(1);
    if (!row) throw new NotFoundError('Message');
    await this.getById(ctx, row.consultationId);
    await this.db.update(messages).set({ feedback }).where(eq(messages.id, messageId));
  }

  async getMessage(ctx: TenantContext, messageId: string) {
    const [row] = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.workspaceId, ctx.workspaceId)))
      .limit(1);
    if (!row) throw new NotFoundError('Message');
    await this.getById(ctx, row.consultationId);
    return row;
  }

  /* ---------------------------------------------------------------------- */
  /* Attachments                                                            */
  /* ---------------------------------------------------------------------- */

  async addAttachment(
    ctx: TenantContext,
    input: {
      consultationId: string;
      messageId?: string | null;
      sourceId: string | null;
      sourceVersionId: string | null;
      fileName: string;
      contentType: string;
      documentType: string;
      sizeBytes: number;
      storageKey: string;
      sha256?: string | null;
      status?: string;
    },
  ) {
    const [row] = await this.db
      .insert(messageAttachments)
      .values({
        id: newId(),
        consultationId: input.consultationId,
        messageId: input.messageId ?? null,
        workspaceId: ctx.workspaceId,
        sourceId: input.sourceId,
        sourceVersionId: input.sourceVersionId,
        fileName: input.fileName,
        contentType: input.contentType,
        documentType: input.documentType,
        sizeBytes: input.sizeBytes,
        storageKey: input.storageKey,
        sha256: input.sha256 ?? null,
        status: input.status ?? 'pending',
      })
      .returning();
    if (!row) throw new Error('Failed to add attachment');
    return row;
  }

  async listAttachments(consultationId: string) {
    return this.db
      .select()
      .from(messageAttachments)
      .where(eq(messageAttachments.consultationId, consultationId))
      .orderBy(messageAttachments.createdAt);
  }

  async bindAttachmentsToMessage(ctx: TenantContext, messageId: string, attachmentIds: string[]) {
    if (attachmentIds.length === 0) return;
    await this.db
      .update(messageAttachments)
      .set({ messageId })
      .where(
        and(
          inArray(messageAttachments.id, attachmentIds),
          eq(messageAttachments.workspaceId, ctx.workspaceId),
        ),
      );
  }

  /* ---------------------------------------------------------------------- */
  /* Participants                                                           */
  /* ---------------------------------------------------------------------- */

  async listParticipants(consultationId: string) {
    return this.db
      .select()
      .from(consultationParticipants)
      .where(eq(consultationParticipants.consultationId, consultationId));
  }

  async addParticipant(ctx: TenantContext, consultationId: string, userId: string, role: string) {
    requirePermission(ctx, 'consultation:share');
    await this.getById(ctx, consultationId);
    await this.db
      .insert(consultationParticipants)
      .values({ id: newId(), consultationId, userId, workspaceId: ctx.workspaceId, role })
      .onConflictDoNothing();
  }

  /* ---------------------------------------------------------------------- */
  /* Reviews, requirements and findings                                     */
  /* ---------------------------------------------------------------------- */

  async createReview(
    ctx: TenantContext,
    input: {
      consultationId: string;
      projectSourceIds: string[];
      governingSourceIds: string[];
      scopeNote?: string | null;
    },
  ) {
    requirePermission(ctx, 'review:create');
    const [row] = await this.db
      .insert(complianceReviews)
      .values({
        id: newId(),
        consultationId: input.consultationId,
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
        projectSourceIds: input.projectSourceIds,
        governingSourceIds: input.governingSourceIds,
        scopeNote: input.scopeNote ?? null,
        status: 'running',
        createdByUserId: ctx.userId,
      })
      .returning();
    if (!row) throw new Error('Failed to create review');
    return row;
  }

  /**
   * The most recent completed review for a consultation.
   *
   * "Correct this document" means "correct it against what we just found", so the caller
   * does not have to know a review identifier to express that.
   */
  async latestCompletedReview(ctx: TenantContext, consultationId: string) {
    const [row] = await this.db
      .select()
      .from(complianceReviews)
      .where(
        and(
          eq(complianceReviews.consultationId, consultationId),
          eq(complianceReviews.workspaceId, ctx.workspaceId),
          eq(complianceReviews.status, 'complete'),
        ),
      )
      .orderBy(desc(complianceReviews.createdAt))
      .limit(1);
    return row ?? null;
  }

  async getReview(ctx: TenantContext, reviewId: string) {
    const [row] = await this.db
      .select()
      .from(complianceReviews)
      .where(
        and(eq(complianceReviews.id, reviewId), eq(complianceReviews.workspaceId, ctx.workspaceId)),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Review');
    await this.getById(ctx, row.consultationId);
    return row;
  }

  async saveRequirements(
    ctx: TenantContext,
    reviewId: string,
    rows: Array<{
      id: string;
      sourceId: string;
      sourceVersionId: string;
      sectionId: string | null;
      reference: string;
      title: string;
      obligationText: string;
      modality: string;
      citationId: string | null;
      exceptions: string[];
      crossReferences: string[];
      ordinal: number;
    }>,
  ) {
    if (rows.length === 0) return;
    await this.db
      .insert(requirements)
      .values(rows.map((r) => ({ ...r, reviewId, workspaceId: ctx.workspaceId })))
      .onConflictDoNothing();
  }

  async saveFindings(
    ctx: TenantContext,
    reviewId: string,
    rows: Array<{
      id: string;
      requirementId: string;
      result: string;
      risk: string;
      finding: string;
      projectEvidenceCitationIds: string[];
      governingCitationIds: string[];
      missingEvidence: string[];
      conflicts: Array<{ description: string; citationIds: string[] }>;
      recommendedAction: string | null;
      confidence: number;
    }>,
  ) {
    if (rows.length === 0) return;
    await this.db
      .insert(findings)
      .values(rows.map((r) => ({ ...r, reviewId, workspaceId: ctx.workspaceId })))
      .onConflictDoNothing();
  }

  async finalizeReview(
    reviewId: string,
    patch: {
      status: string;
      messageId?: string | null;
      requirementsTotal: number;
      compliantCount: number;
      nonCompliantCount: number;
      needsEvidenceCount: number;
      notAssessedCount: number;
      evidenceCoverage: number;
      confidence: number;
      riskLevel: string;
    },
  ) {
    await this.db
      .update(complianceReviews)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(complianceReviews.id, reviewId));
  }

  async listFindings(ctx: TenantContext, reviewId: string) {
    await this.getReview(ctx, reviewId);
    return this.db
      .select({ finding: findings, requirement: requirements })
      .from(findings)
      .innerJoin(requirements, eq(requirements.id, findings.requirementId))
      .where(eq(findings.reviewId, reviewId))
      .orderBy(requirements.ordinal);
  }

  async listRequirements(ctx: TenantContext, reviewId: string) {
    await this.getReview(ctx, reviewId);
    return this.db
      .select()
      .from(requirements)
      .where(eq(requirements.reviewId, reviewId))
      .orderBy(requirements.ordinal);
  }

  /* ---------------------------------------------------------------------- */
  /* Citations                                                              */
  /* ---------------------------------------------------------------------- */

  async saveCitations(ctx: TenantContext, rows: Array<Record<string, unknown>>) {
    if (rows.length === 0) return;
    await this.db
      .insert(citations)
      .values(
        rows.map((r) => ({
          ...r,
          organizationId: ctx.organizationId,
          workspaceId: ctx.workspaceId,
        })) as never,
      )
      .onConflictDoNothing();
  }

  /**
   * Resolves a citation for the viewer. The join through `visibleSourcePredicate` is the
   * reason a lower-permission user cannot open a citation that points at a restricted
   * source, even if they somehow learn its ID.
   */
  async getCitation(ctx: TenantContext, citationId: string) {
    const [row] = await this.db
      .select({ citation: citations, source: sources, version: sourceVersions })
      .from(citations)
      .innerJoin(sources, eq(sources.id, citations.sourceId))
      .innerJoin(sourceVersions, eq(sourceVersions.id, citations.sourceVersionId))
      .where(
        and(
          eq(citations.id, citationId),
          eq(citations.workspaceId, ctx.workspaceId),
          visibleSourcePredicate(ctx),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Citation');
    return row;
  }

  async listCitationsForMessage(ctx: TenantContext, messageId: string) {
    return this.db
      .select()
      .from(citations)
      .where(and(eq(citations.messageId, messageId), eq(citations.workspaceId, ctx.workspaceId)))
      .orderBy(citations.createdAt);
  }

  async listCitationsForReview(ctx: TenantContext, reviewId: string) {
    return this.db
      .select()
      .from(citations)
      .where(and(eq(citations.reviewId, reviewId), eq(citations.workspaceId, ctx.workspaceId)));
  }
}
