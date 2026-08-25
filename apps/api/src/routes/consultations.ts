import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  ConsultationsQuery,
  CreateConsultationRequest,
  CreateCorrectionRequest,
  CreateReportRequest,
  CreateReviewRequest,
  CreateUploadRequest,
  PostMessageRequest,
  UpdateConsultationRequest,
  type ConsultationDetail,
  type ConsultationMessage,
  type ConsultationSummary,
} from '@uxe/contracts';
import type { TenantContext } from '@uxe/db';
import type { AppBindings, AppDeps } from '../context.js';
import { ApiError } from '../errors.js';
import { body, query, requireId, validateJson, validateQuery } from '../middleware/validate.js';
import { clientIp, requirePermission, userAgent } from '../middleware/index.js';
import { RateLimitBuckets } from '../services/rate-limit.js';
import { buildStorageKey } from '../services/storage.js';
import { toJobView } from './jobs.js';

export function consultationRoutes(deps: AppDeps) {
  const app = new Hono<AppBindings>();

  /* ---------------------------------------------------------------------- */
  /* List and create                                                        */
  /* ---------------------------------------------------------------------- */

  app.get(
    '/',
    requirePermission('consultation:read'),
    validateQuery(ConsultationsQuery),
    async (c) => {
      const tenant = c.get('tenant');
      if (!tenant) throw ApiError.unauthenticated();
      const params = query<typeof ConsultationsQuery._output>(c);

      const { items, total } = await deps.repos.consultations.list(tenant, params);
      const owners = new Map<string, string>();
      for (const item of items) {
        if (owners.has(item.ownerUserId)) continue;
        const user = await deps.repos.identity.findUserById(item.ownerUserId);
        owners.set(item.ownerUserId, user?.fullName ?? 'Unknown');
      }

      const summaries: ConsultationSummary[] = items.map((item) => ({
        id: item.id,
        title: item.title,
        status: item.status as ConsultationSummary['status'],
        taskMode: item.taskMode as ConsultationSummary['taskMode'],
        documentCount: item.documentCount,
        sourceCount: item.sourceCount,
        complianceScore: item.complianceScore,
        pinned: item.pinned,
        ownerId: item.ownerUserId,
        ownerName: owners.get(item.ownerUserId) ?? 'Unknown',
        lastMessageAt: item.lastMessageAt?.toISOString() ?? null,
        updatedAt: item.updatedAt.toISOString(),
        createdAt: item.createdAt.toISOString(),
      }));

      return c.json({
        items: summaries,
        total,
        page: params.page,
        pageSize: params.pageSize,
        totalPages: Math.ceil(total / params.pageSize),
      });
    },
  );

  app.post(
    '/',
    requirePermission('consultation:create'),
    validateJson(CreateConsultationRequest),
    async (c) => {
      const tenant = c.get('tenant');
      if (!tenant) throw ApiError.unauthenticated();
      const input = body<typeof CreateConsultationRequest._output>(c);

      const consultation = await deps.repos.consultations.create(tenant, input);
      if (input.sourceIds.length > 0) {
        await deps.repos.consultations.setSources(
          tenant,
          consultation.id,
          input.sourceIds,
          'governing',
        );
      }

      await deps.repos.audit.record({
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
        actorUserId: tenant.userId,
        actorName: c.get('session')?.user.fullName ?? 'Unknown',
        action: 'consultation.created',
        category: 'consultation',
        targetType: 'consultation',
        targetId: consultation.id,
        targetLabel: consultation.title,
        ipAddress: clientIp(c),
        userAgent: userAgent(c),
        traceId: tenant.traceId,
        summary: `Started consultation "${consultation.title}".`,
      });

      return c.json(await buildDetail(deps, c, consultation.id), 201);
    },
  );

  app.get('/:id', requirePermission('consultation:read'), async (c) => {
    const tenant = c.get('tenant');
    if (!tenant) throw ApiError.unauthenticated();
    return c.json(await buildDetail(deps, c, requireId(c, 'id')));
  });

  app.patch(
    '/:id',
    requirePermission('consultation:update'),
    validateJson(UpdateConsultationRequest),
    async (c) => {
      const tenant = c.get('tenant');
      if (!tenant) throw ApiError.unauthenticated();
      const id = requireId(c, 'id');
      const input = body<typeof UpdateConsultationRequest._output>(c);

      const patch: Record<string, unknown> = {};
      for (const key of [
        'title',
        'status',
        'taskMode',
        'pinned',
        'answerStyle',
        'outputFormat',
      ] as const) {
        if (input[key] !== undefined) patch[key] = input[key];
      }
      if (input.evidenceDetail !== undefined) patch.evidenceDetail = input.evidenceDetail;
      if (input.responseControls !== undefined) patch.responseControls = input.responseControls;

      await deps.repos.consultations.update(tenant, id, input.version, patch);

      if (input.sourceIds !== undefined) {
        await deps.repos.consultations.setSources(tenant, id, input.sourceIds, 'governing');
      }

      return c.json(await buildDetail(deps, c, id));
    },
  );

  app.delete('/:id', requirePermission('consultation:delete'), async (c) => {
    const tenant = c.get('tenant');
    if (!tenant) throw ApiError.unauthenticated();
    const id = requireId(c, 'id');
    const consultation = await deps.repos.consultations.getById(tenant, id);
    await deps.repos.consultations.softDelete(tenant, id);

    await deps.repos.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: tenant.userId,
      actorName: c.get('session')?.user.fullName ?? 'Unknown',
      action: 'consultation.deleted',
      category: 'deletion',
      targetType: 'consultation',
      targetId: id,
      targetLabel: consultation.title,
      traceId: tenant.traceId,
      summary: `Deleted consultation "${consultation.title}".`,
    });

    return c.json({ ok: true as const });
  });

  /* ---------------------------------------------------------------------- */
  /* Messages                                                               */
  /* ---------------------------------------------------------------------- */

  app.post(
    '/:id/messages',
    requirePermission('consultation:update'),
    validateJson(PostMessageRequest),
    async (c) => {
      const tenant = c.get('tenant');
      if (!tenant) throw ApiError.unauthenticated();
      const id = requireId(c, 'id');
      const input = body<typeof PostMessageRequest._output>(c);

      const limit = await deps.services.rateLimiter.check(
        RateLimitBuckets.consultByWorkspace(tenant.workspaceId),
        deps.env.RATE_LIMIT_CONSULT_PER_HOUR,
        3600,
      );
      if (!limit.allowed) throw ApiError.rateLimited(limit.retryAfterSeconds);

      const consultation = await deps.repos.consultations.getById(tenant, id);

      const userMessage = await deps.repos.consultations.appendMessage(tenant, {
        consultationId: id,
        role: 'user',
        text: input.text,
        taskMode: input.taskMode,
        answerStyle: input.answerStyle,
        parentMessageId: input.parentMessageId,
      });

      if (input.attachmentIds.length > 0) {
        await deps.repos.consultations.bindAttachmentsToMessage(
          tenant,
          userMessage.id,
          input.attachmentIds,
        );
      }

      // The assistant row is created up front and left empty. Persisting the result onto a
      // row that already exists is what makes a refresh mid-generation safe: the client
      // always has something to poll, and the stream is a convenience rather than the
      // only delivery path.
      const assistantMessage = await deps.repos.consultations.appendMessage(tenant, {
        consultationId: id,
        role: 'assistant',
        text: '',
        taskMode: input.taskMode,
        answerStyle: input.answerStyle,
      });

      const { job } = await deps.repos.jobs.enqueue(tenant, {
        kind: 'consultation_answer',
        idempotencyKey: input.idempotencyKey,
        payload: {
          consultationId: id,
          userMessageId: userMessage.id,
          assistantMessageId: assistantMessage.id,
          question: input.text,
          taskMode: input.taskMode,
          answerStyle: input.answerStyle,
        },
        targetType: 'consultation',
        targetId: id,
        priority: 5,
      });

      await deps.repos.consultations.update(tenant, id, consultation.version, {
        status: 'processing',
        taskMode: input.taskMode,
      });

      const message = await toMessageView(deps, tenant, assistantMessage, job.id, job.status);
      return c.json({ message, job: toJobView(job) }, 202);
    },
  );

  app.post(
    '/:id/messages/:messageId/feedback',
    requirePermission('consultation:update'),
    async (c) => {
      const tenant = c.get('tenant');
      if (!tenant) throw ApiError.unauthenticated();
      const messageId = requireId(c, 'messageId');
      const input = (await c.req.json()) as { feedback?: 'up' | 'down' | null };
      await deps.repos.consultations.setFeedback(tenant, messageId, input.feedback ?? null);
      return c.json({ ok: true as const });
    },
  );

  app.post('/:id/cancel', requirePermission('consultation:update'), async (c) => {
    const tenant = c.get('tenant');
    if (!tenant) throw ApiError.unauthenticated();
    const id = requireId(c, 'id');
    await deps.repos.consultations.getById(tenant, id);
    const cancelled = await deps.repos.jobs.cancelForTarget(tenant, 'consultation', id);
    return c.json({ ok: true as const, cancelled });
  });

  /* ---------------------------------------------------------------------- */
  /* Uploads (consultation inputs, not knowledge)                           */
  /* ---------------------------------------------------------------------- */

  app.post(
    '/:id/uploads',
    requirePermission('consultation:update'),
    validateJson(CreateUploadRequest),
    async (c) => {
      const tenant = c.get('tenant');
      if (!tenant) throw ApiError.unauthenticated();
      const id = requireId(c, 'id');
      const input = body<typeof CreateUploadRequest._output>(c);
      await deps.repos.consultations.getById(tenant, id);

      const tickets = [];
      for (const file of input.files) {
        if (file.sizeBytes > deps.env.MAX_UPLOAD_BYTES) {
          throw new ApiError(
            413,
            'payload_too_large',
            `${file.fileName} exceeds the upload limit.`,
          );
        }

        // Consultation uploads are inputs, NOT knowledge. `promotedToKnowledge` stays false
        // until somebody explicitly promotes them, which is what keeps rule 6 true.
        const source = await deps.repos.sources.create(tenant, {
          title: file.fileName.replace(/\.[A-Za-z0-9]{1,6}$/, ''),
          documentType: 'unknown',
          tags: ['consultation-input'],
          accessScope: 'workspace',
          promotedToKnowledge: false,
          status: 'pending',
        });

        const storageKey = buildStorageKey({
          organizationId: tenant.organizationId,
          workspaceId: tenant.workspaceId,
          kind: 'upload',
          id: source.id,
          fileName: file.fileName,
        });

        const ticket = await deps.repos.uploads.create(tenant, {
          sourceId: source.id,
          consultationId: id,
          fileName: file.fileName,
          contentType: file.contentType,
          declaredBytes: file.sizeBytes,
          storageKey,
          promoteToKnowledge: false,
          tags: ['consultation-input'],
          accessScope: 'workspace',
        });

        tickets.push({
          uploadId: ticket.id,
          sourceId: source.id,
          fileName: file.fileName,
          // Relative: see the note on the same field in the sources route.
          uploadUrl: `/api/v1/sources/uploads/${ticket.id}/content`,
          method: 'PUT' as const,
          headers: { 'content-type': file.contentType },
          expiresAt: ticket.expiresAt.toISOString(),
          maxBytes: deps.env.MAX_UPLOAD_BYTES,
        });
      }

      return c.json({ tickets }, 201);
    },
  );

  /* ---------------------------------------------------------------------- */
  /* Reviews, reports, corrections                                          */
  /* ---------------------------------------------------------------------- */

  app.post(
    '/:id/reviews',
    requirePermission('review:create'),
    validateJson(CreateReviewRequest),
    async (c) => {
      const tenant = c.get('tenant');
      if (!tenant) throw ApiError.unauthenticated();
      const id = requireId(c, 'id');
      const input = body<typeof CreateReviewRequest._output>(c);

      await deps.repos.consultations.getById(tenant, id);
      await deps.repos.sources.assertAllVisible(tenant, [
        ...input.projectSourceIds,
        ...input.governingSourceIds,
      ]);

      // Pin the versions in use so the review remains reproducible even if a source updates.
      await deps.repos.consultations.setSources(tenant, id, input.governingSourceIds, 'governing');
      await deps.repos.consultations.setSources(tenant, id, input.projectSourceIds, 'project');

      const review = await deps.repos.consultations.createReview(tenant, {
        consultationId: id,
        projectSourceIds: input.projectSourceIds,
        governingSourceIds: input.governingSourceIds,
        scopeNote: input.scopeNote ?? null,
      });

      const assistantMessage = await deps.repos.consultations.appendMessage(tenant, {
        consultationId: id,
        role: 'assistant',
        text: '',
        taskMode: 'check_compliance',
        answerStyle: input.answerStyle,
      });

      const { job } = await deps.repos.jobs.enqueue(tenant, {
        kind: 'compliance_review',
        idempotencyKey: input.idempotencyKey,
        payload: {
          consultationId: id,
          reviewId: review.id,
          assistantMessageId: assistantMessage.id,
          answerStyle: input.answerStyle,
          scopeNote: input.scopeNote ?? null,
        },
        targetType: 'consultation',
        targetId: id,
        priority: 8,
      });

      return c.json(
        { job: toJobView(job), reviewId: review.id, messageId: assistantMessage.id },
        202,
      );
    },
  );

  app.post(
    '/:id/reports',
    requirePermission('report:create'),
    validateJson(CreateReportRequest),
    async (c) => {
      const tenant = c.get('tenant');
      if (!tenant) throw ApiError.unauthenticated();
      const id = requireId(c, 'id');
      const input = body<typeof CreateReportRequest._output>(c);
      await deps.repos.consultations.getById(tenant, id);

      if (!input.reviewId && !input.messageId) {
        throw ApiError.badRequest(
          'Choose the review or the answer this report should be built from.',
        );
      }

      const { job } = await deps.repos.jobs.enqueue(tenant, {
        kind: 'report_generate',
        idempotencyKey: input.idempotencyKey,
        payload: {
          consultationId: id,
          reviewId: input.reviewId,
          messageId: input.messageId,
          format: input.format,
          kind: input.kind,
          title: input.title ?? null,
        },
        targetType: 'consultation',
        targetId: id,
        priority: 3,
      });

      return c.json({ job: toJobView(job) }, 202);
    },
  );

  app.post(
    '/:id/corrections',
    requirePermission('correction:create'),
    validateJson(CreateCorrectionRequest),
    async (c) => {
      const tenant = c.get('tenant');
      if (!tenant) throw ApiError.unauthenticated();
      const id = requireId(c, 'id');
      const input = body<typeof CreateCorrectionRequest._output>(c);

      await deps.repos.consultations.getById(tenant, id);
      await deps.repos.sources.assertAllVisible(tenant, [input.sourceId]);

      const { job } = await deps.repos.jobs.enqueue(tenant, {
        kind: 'correction_plan',
        idempotencyKey: input.idempotencyKey,
        payload: {
          consultationId: id,
          sourceId: input.sourceId,
          reviewId: input.reviewId,
          findingIds: input.findingIds,
          instructions: input.instructions ?? null,
        },
        targetType: 'consultation',
        targetId: id,
        priority: 6,
      });

      return c.json({ job: toJobView(job) }, 202);
    },
  );

  /* ---------------------------------------------------------------------- */
  /* Streaming                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Server-sent events for job progress and completed answers.
   *
   * The stream is a live view over durable state, not the state itself. Every event it
   * emits is already persisted, so a reconnect simply resumes from the database and a
   * dropped connection never loses a result.
   */
  app.get('/:id/stream', requirePermission('consultation:read'), async (c) => {
    const tenant = c.get('tenant');
    if (!tenant) throw ApiError.unauthenticated();
    const id = requireId(c, 'id');
    await deps.repos.consultations.getById(tenant, id);

    return streamSSE(c, async (stream) => {
      const seenStages = new Map<string, string>();
      const deliveredMessages = new Set<string>();
      const startedAt = Date.now();
      // Bounded so a forgotten tab cannot hold a connection open indefinitely.
      const maxDurationMs = 10 * 60_000;

      let aborted = false;
      stream.onAbort(() => {
        aborted = true;
      });

      while (!aborted && Date.now() - startedAt < maxDurationMs) {
        const jobs = await deps.repos.jobs.listForTarget(tenant, 'consultation', id);
        const active = jobs.filter((j) => j.status === 'queued' || j.status === 'running');

        for (const job of jobs) {
          for (const stage of job.stages) {
            const key = `${job.id}:${stage.key}`;
            if (seenStages.get(key) === stage.state) continue;
            seenStages.set(key, stage.state);
            await stream.writeSSE({
              event: 'stage',
              data: JSON.stringify({ type: 'stage', jobId: job.id, stage }),
            });
          }

          if (job.status === 'failed' || job.status === 'dead_letter') {
            await stream.writeSSE({
              event: 'job',
              data: JSON.stringify({ type: 'job', job: toJobView(job) }),
            });
          }

          if (job.status === 'succeeded' && job.resultRef?.kind === 'message') {
            if (deliveredMessages.has(job.resultRef.id)) continue;
            deliveredMessages.add(job.resultRef.id);
            const row = await deps.repos.consultations.getMessage(tenant, job.resultRef.id);
            const view = await toMessageView(deps, tenant, row, job.id, job.status);
            await stream.writeSSE({
              event: 'message',
              data: JSON.stringify({ type: 'message', message: view }),
            });
          }
        }

        if (active.length === 0 && deliveredMessages.size > 0) {
          await stream.writeSSE({
            event: 'done',
            data: JSON.stringify({
              type: 'done',
              messageId: [...deliveredMessages].at(-1) ?? null,
            }),
          });
          break;
        }

        if (active.length === 0) {
          await stream.writeSSE({
            event: 'done',
            data: JSON.stringify({ type: 'done', messageId: null }),
          });
          break;
        }

        // A heartbeat keeps intermediaries from closing an idle connection.
        await stream.writeSSE({
          event: 'heartbeat',
          data: JSON.stringify({ type: 'heartbeat', at: new Date().toISOString() }),
        });
        await stream.sleep(700);
      }
    });
  });

  return app;
}

/* -------------------------------------------------------------------------- */
/* View builders                                                              */
/* -------------------------------------------------------------------------- */

async function buildDetail(
  deps: AppDeps,
  c: Context<AppBindings>,
  id: string,
): Promise<ConsultationDetail> {
  const tenant = c.get('tenant');
  if (!tenant) throw ApiError.unauthenticated();

  const consultation = await deps.repos.consultations.getById(tenant, id);
  const [sources, messages, participants] = await Promise.all([
    deps.repos.consultations.listSources(tenant, id),
    deps.repos.consultations.listMessages(tenant, id),
    deps.repos.consultations.listParticipants(id),
  ]);

  const owner = await deps.repos.identity.findUserById(consultation.ownerUserId);
  const jobs = await deps.repos.jobs.listForTarget(tenant, 'consultation', id);
  const jobByMessage = new Map<string, (typeof jobs)[number]>();
  for (const job of jobs) {
    const messageId = job.payload.assistantMessageId;
    if (typeof messageId === 'string') jobByMessage.set(messageId, job);
  }

  const messageViews: ConsultationMessage[] = [];
  for (const message of messages) {
    const job = jobByMessage.get(message.id);
    messageViews.push(
      await toMessageView(deps, tenant, message, job?.id ?? null, job?.status ?? null),
    );
  }

  const participantViews = await Promise.all(
    participants.map(async (p) => {
      const user = await deps.repos.identity.findUserById(p.userId);
      return {
        userId: p.userId,
        name: user?.fullName ?? 'Unknown',
        avatarUrl: user?.avatarUrl ?? null,
        role: p.role as ConsultationDetail['participants'][number]['role'],
      };
    }),
  );

  return {
    id: consultation.id,
    title: consultation.title,
    status: consultation.status as ConsultationDetail['status'],
    taskMode: consultation.taskMode as ConsultationDetail['taskMode'],
    documentCount: sources.filter((s) => s.role === 'project').length,
    sourceCount: sources.filter((s) => s.role === 'governing').length,
    complianceScore: consultation.complianceScore,
    pinned: consultation.pinned,
    ownerId: consultation.ownerUserId,
    ownerName: owner?.fullName ?? 'Unknown',
    lastMessageAt: consultation.lastMessageAt?.toISOString() ?? null,
    updatedAt: consultation.updatedAt.toISOString(),
    createdAt: consultation.createdAt.toISOString(),
    version: consultation.version,
    answerStyle: consultation.answerStyle as ConsultationDetail['answerStyle'],
    evidenceDetail: consultation.evidenceDetail,
    responseControls: consultation.responseControls,
    outputFormat: consultation.outputFormat as ConsultationDetail['outputFormat'],
    sources: sources.map((s) => ({
      sourceId: s.sourceId,
      sourceVersionId: s.sourceVersionId,
      title: s.title,
      documentType: s.documentType as ConsultationDetail['sources'][number]['documentType'],
      version: s.version,
      role: s.role as 'governing' | 'project',
      pages: s.pages,
      effectiveDate: s.effectiveDate?.toISOString() ?? null,
      status: s.status as ConsultationDetail['sources'][number]['status'],
    })),
    messages: messageViews,
    participants: participantViews,
  };
}

async function toMessageView(
  deps: AppDeps,
  _tenant: TenantContext,
  message: {
    id: string;
    consultationId: string;
    role: string;
    authorUserId: string | null;
    text: string;
    taskMode: string | null;
    answer: Record<string, unknown> | null;
    parentMessageId: string | null;
    feedback: string | null;
    error: Record<string, unknown> | null;
    createdAt: Date;
  },
  jobId: string | null,
  jobStatus: string | null,
): Promise<ConsultationMessage> {
  const author = message.authorUserId
    ? await deps.repos.identity.findUserById(message.authorUserId)
    : null;

  const attachments = await deps.repos.consultations.listAttachments(message.consultationId);

  return {
    id: message.id,
    consultationId: message.consultationId,
    role: message.role as ConsultationMessage['role'],
    authorName: author?.fullName ?? (message.role === 'assistant' ? 'Ayumi' : 'System'),
    authorAvatarUrl:
      author?.avatarUrl ?? (message.role === 'assistant' ? '/assets/consultantgirl.png' : null),
    text: message.text,
    taskMode: (message.taskMode as ConsultationMessage['taskMode']) ?? null,
    answer: (message.answer as ConsultationMessage['answer']) ?? null,
    attachments: attachments
      .filter((a) => a.messageId === message.id)
      .map((a) => ({
        id: a.id,
        fileName: a.fileName,
        documentType: a.documentType as ConsultationMessage['attachments'][number]['documentType'],
        sizeBytes: a.sizeBytes,
        sourceId: a.sourceId,
        sourceVersionId: a.sourceVersionId,
        status: a.status as ConsultationMessage['attachments'][number]['status'],
        pages: null,
        promotedToKnowledge: false,
      })),
    jobId,
    jobStatus: (jobStatus as ConsultationMessage['jobStatus']) ?? null,
    parentMessageId: message.parentMessageId,
    feedback: (message.feedback as 'up' | 'down' | null) ?? null,
    createdAt: message.createdAt.toISOString(),
    error: message.error
      ? {
          code: String(message.error.code ?? 'internal_error'),
          message: String(message.error.message ?? 'Generation failed.'),
          retryable: Boolean(message.error.retryable ?? true),
          traceId: String(message.error.traceId ?? ''),
        }
      : null,
  } satisfies ConsultationMessage;
}
