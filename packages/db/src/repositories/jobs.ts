import { and, asc, count, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { jobAttempts, processingJobs } from '../schema/index.js';
import { newId } from '../ids.js';
import { NotFoundError, type TenantContext } from '../tenant.js';

export interface JobStageRecord {
  key: string;
  label: string;
  state: 'pending' | 'running' | 'complete' | 'failed' | 'skipped';
  detail: string | null;
  percent: number | null;
}

/** The stage list shown in the Knowledge Base indexing panel, in pipeline order. */
export const INGEST_STAGES: JobStageRecord[] = [
  { key: 'malware_scan', label: 'Malware scan', state: 'pending', detail: null, percent: null },
  { key: 'extraction', label: 'Extraction / OCR', state: 'pending', detail: null, percent: null },
  {
    key: 'structure_analysis',
    label: 'Structure analysis',
    state: 'pending',
    detail: null,
    percent: null,
  },
  { key: 'chunking', label: 'Chunking', state: 'pending', detail: null, percent: null },
  { key: 'embeddings', label: 'Embeddings', state: 'pending', detail: null, percent: null },
  { key: 'lexical_index', label: 'Lexical index', state: 'pending', detail: null, percent: null },
  { key: 'citation_map', label: 'Citation map', state: 'pending', detail: null, percent: null },
  { key: 'validation', label: 'Validation', state: 'pending', detail: null, percent: null },
];

export const ANSWER_STAGES: JobStageRecord[] = [
  {
    key: 'permissions',
    label: 'Resolving permissions',
    state: 'pending',
    detail: null,
    percent: null,
  },
  { key: 'retrieval', label: 'Hybrid retrieval', state: 'pending', detail: null, percent: null },
  { key: 'rerank', label: 'Reranking evidence', state: 'pending', detail: null, percent: null },
  { key: 'analysis', label: 'Analysis', state: 'pending', detail: null, percent: null },
  {
    key: 'verification',
    label: 'Citation verification',
    state: 'pending',
    detail: null,
    percent: null,
  },
  { key: 'assembly', label: 'Assembling answer', state: 'pending', detail: null, percent: null },
];

export const REVIEW_STAGES: JobStageRecord[] = [
  {
    key: 'permissions',
    label: 'Resolving permissions',
    state: 'pending',
    detail: null,
    percent: null,
  },
  {
    key: 'requirements',
    label: 'Building requirement set',
    state: 'pending',
    detail: null,
    percent: null,
  },
  {
    key: 'evidence',
    label: 'Testing requirements against documents',
    state: 'pending',
    detail: null,
    percent: null,
  },
  {
    key: 'conflicts',
    label: 'Conflict and exception checks',
    state: 'pending',
    detail: null,
    percent: null,
  },
  {
    key: 'verification',
    label: 'Citation verification',
    state: 'pending',
    detail: null,
    percent: null,
  },
  {
    key: 'scoring',
    label: 'Coverage and confidence',
    state: 'pending',
    detail: null,
    percent: null,
  },
];

export const CORRECTION_STAGES: JobStageRecord[] = [
  { key: 'plan', label: 'Reading accepted changes', state: 'pending', detail: null, percent: null },
  {
    key: 'generate',
    label: 'Writing derivative document',
    state: 'pending',
    detail: null,
    percent: null,
  },
  {
    key: 'validate',
    label: 'Re-opening and validating output',
    state: 'pending',
    detail: null,
    percent: null,
  },
  {
    key: 'store',
    label: 'Storing artifact and change log',
    state: 'pending',
    detail: null,
    percent: null,
  },
];

export const REPORT_STAGES: JobStageRecord[] = [
  {
    key: 'collect',
    label: 'Collecting verified evidence',
    state: 'pending',
    detail: null,
    percent: null,
  },
  { key: 'render', label: 'Rendering document', state: 'pending', detail: null, percent: null },
  { key: 'validate', label: 'Validating output', state: 'pending', detail: null, percent: null },
  { key: 'store', label: 'Storing artifact', state: 'pending', detail: null, percent: null },
];

export function stagesFor(kind: string): JobStageRecord[] {
  switch (kind) {
    case 'source_ingest':
    case 'source_reprocess':
    case 'source_sync':
      return INGEST_STAGES.map((s) => ({ ...s }));
    case 'consultation_answer':
      return ANSWER_STAGES.map((s) => ({ ...s }));
    case 'compliance_review':
      return REVIEW_STAGES.map((s) => ({ ...s }));
    case 'correction_generate':
    case 'correction_plan':
      return CORRECTION_STAGES.map((s) => ({ ...s }));
    case 'report_generate':
      return REPORT_STAGES.map((s) => ({ ...s }));
    default:
      return [];
  }
}

export class JobRepository {
  constructor(private readonly db: Database) {}

  /**
   * Enqueues a job, or returns the existing one when the same idempotency key is replayed.
   * This is the single guard that keeps a double-clicked "Generate corrected PDF" button
   * from producing two artifacts.
   */
  async enqueue(
    ctx: TenantContext,
    input: {
      kind: string;
      idempotencyKey: string;
      payload: Record<string, unknown>;
      targetType?: string | null;
      targetId?: string | null;
      priority?: number;
      maxAttempts?: number;
    },
  ): Promise<{ job: typeof processingJobs.$inferSelect; created: boolean }> {
    const existing = await this.db
      .select()
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.workspaceId, ctx.workspaceId),
          eq(processingJobs.kind, input.kind),
          eq(processingJobs.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);

    if (existing[0]) return { job: existing[0], created: false };

    const [row] = await this.db
      .insert(processingJobs)
      .values({
        id: newId(),
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
        kind: input.kind,
        status: 'queued',
        idempotencyKey: input.idempotencyKey,
        traceId: ctx.traceId,
        payload: input.payload,
        stages: stagesFor(input.kind),
        priority: input.priority ?? 0,
        maxAttempts: input.maxAttempts ?? 3,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        createdByUserId: ctx.userId,
        nextAttemptAt: new Date(),
      })
      .onConflictDoNothing()
      .returning();

    if (!row) {
      // Lost a race with a concurrent identical request; return the winner.
      const [winner] = await this.db
        .select()
        .from(processingJobs)
        .where(
          and(
            eq(processingJobs.workspaceId, ctx.workspaceId),
            eq(processingJobs.kind, input.kind),
            eq(processingJobs.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (!winner) throw new Error('Failed to enqueue job');
      return { job: winner, created: false };
    }

    return { job: row, created: true };
  }

  async getById(ctx: TenantContext, jobId: string) {
    const [row] = await this.db
      .select()
      .from(processingJobs)
      .where(and(eq(processingJobs.id, jobId), eq(processingJobs.workspaceId, ctx.workspaceId)))
      .limit(1);
    if (!row) throw new NotFoundError('Job');
    return row;
  }

  /**
   * Claims the next runnable job with `FOR UPDATE SKIP LOCKED`, so multiple worker
   * processes can drain the queue concurrently without ever handling the same job twice.
   */
  async claimNext(kinds?: string[]): Promise<typeof processingJobs.$inferSelect | null> {
    const kindFilter = kinds?.length ? sql`AND kind = ANY(${sql.param(kinds)}::text[])` : sql``;

    const rows = await this.db.execute(sql`
      UPDATE processing_jobs SET
        status = 'running',
        attempt = attempt + 1,
        started_at = COALESCE(started_at, now()),
        updated_at = now()
      WHERE id = (
        SELECT id FROM processing_jobs
        WHERE status IN ('queued')
          AND (next_attempt_at IS NULL OR next_attempt_at <= now())
          ${kindFilter}
        ORDER BY priority DESC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING *
    `);

    const list = rows as unknown as Array<Record<string, unknown>>;
    const first = Array.isArray(list) ? list[0] : undefined;
    if (!first) return null;
    return this.rowToJob(first);
  }

  private rowToJob(r: Record<string, unknown>): typeof processingJobs.$inferSelect {
    return {
      id: String(r.id),
      organizationId: String(r.organization_id),
      workspaceId: String(r.workspace_id),
      kind: String(r.kind),
      status: String(r.status),
      idempotencyKey: String(r.idempotency_key),
      traceId: String(r.trace_id),
      priority: Number(r.priority),
      payload: (r.payload ?? {}) as Record<string, unknown>,
      stages: (r.stages ?? []) as JobStageRecord[],
      percent: Number(r.percent),
      attempt: Number(r.attempt),
      maxAttempts: Number(r.max_attempts),
      nextAttemptAt: r.next_attempt_at ? new Date(String(r.next_attempt_at)) : null,
      error: (r.error ?? null) as Record<string, unknown> | null,
      resultRef: (r.result_ref ?? null) as { kind: string; id: string } | null,
      targetType:
        r.target_type === null || r.target_type === undefined ? null : String(r.target_type),
      targetId: r.target_id === null || r.target_id === undefined ? null : String(r.target_id),
      createdByUserId:
        r.created_by_user_id === null || r.created_by_user_id === undefined
          ? null
          : String(r.created_by_user_id),
      startedAt: r.started_at ? new Date(String(r.started_at)) : null,
      finishedAt: r.finished_at ? new Date(String(r.finished_at)) : null,
      version: Number(r.version),
      createdAt: new Date(String(r.created_at)),
      updatedAt: new Date(String(r.updated_at)),
    };
  }

  async beginAttempt(jobId: string, attempt: number, workspaceId: string) {
    await this.db
      .insert(jobAttempts)
      .values({
        id: newId(),
        jobId,
        workspaceId,
        attempt,
        status: 'running',
        startedAt: new Date(),
      })
      .onConflictDoNothing();
  }

  async updateStage(
    jobId: string,
    stageKey: string,
    state: JobStageRecord['state'],
    detail?: string | null,
    percent?: number | null,
  ) {
    const [job] = await this.db
      .select({ stages: processingJobs.stages })
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId))
      .limit(1);
    if (!job) return null;

    const stages = job.stages.map((s) =>
      s.key === stageKey
        ? { ...s, state, detail: detail ?? s.detail, percent: percent ?? s.percent }
        : s,
    );
    const done = stages.filter((s) => s.state === 'complete' || s.state === 'skipped').length;
    const overall = stages.length > 0 ? Math.round((done / stages.length) * 100) : 0;

    await this.db
      .update(processingJobs)
      .set({ stages, percent: overall, updatedAt: new Date() })
      .where(eq(processingJobs.id, jobId));

    return { stages, percent: overall, stage: stages.find((s) => s.key === stageKey) ?? null };
  }

  async succeed(
    jobId: string,
    resultRef: { kind: string; id: string } | null,
    metrics: Record<string, unknown> = {},
  ) {
    const now = new Date();
    const [job] = await this.db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId))
      .limit(1);
    if (!job) return;

    const stages = job.stages.map((s) =>
      s.state === 'pending' || s.state === 'running' ? { ...s, state: 'complete' as const } : s,
    );

    await this.db
      .update(processingJobs)
      .set({
        status: 'succeeded',
        percent: 100,
        stages,
        resultRef,
        finishedAt: now,
        error: null,
        updatedAt: now,
      })
      .where(eq(processingJobs.id, jobId));

    await this.db
      .update(jobAttempts)
      .set({
        status: 'succeeded',
        finishedAt: now,
        metrics,
        durationMs: now.getTime() - job.createdAt.getTime(),
      })
      .where(and(eq(jobAttempts.jobId, jobId), eq(jobAttempts.attempt, job.attempt)));
  }

  /**
   * Records a failure. Retryable failures are rescheduled with exponential backoff plus
   * jitter; a job that exhausts its attempts moves to `dead_letter` rather than vanishing.
   */
  async fail(
    jobId: string,
    error: { code: string; message: string; retryable: boolean; traceId: string },
    jitterSeed = Math.random(),
  ) {
    const now = new Date();
    const [job] = await this.db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId))
      .limit(1);
    if (!job) return null;

    const canRetry = error.retryable && job.attempt < job.maxAttempts;
    const backoffSeconds = Math.min(600, 2 ** job.attempt * 5);
    const jitter = backoffSeconds * 0.25 * jitterSeed;
    const nextAttemptAt = canRetry
      ? new Date(now.getTime() + (backoffSeconds + jitter) * 1000)
      : null;

    const stages = job.stages.map((s) =>
      s.state === 'running' ? { ...s, state: 'failed' as const, detail: error.message } : s,
    );

    await this.db
      .update(processingJobs)
      .set({
        status: canRetry ? 'queued' : job.attempt >= job.maxAttempts ? 'dead_letter' : 'failed',
        error,
        stages,
        nextAttemptAt,
        finishedAt: canRetry ? null : now,
        updatedAt: now,
      })
      .where(eq(processingJobs.id, jobId));

    await this.db
      .update(jobAttempts)
      .set({ status: 'failed', error, finishedAt: now })
      .where(and(eq(jobAttempts.jobId, jobId), eq(jobAttempts.attempt, job.attempt)));

    return { willRetry: canRetry, nextAttemptAt };
  }

  /**
   * Manual retry from the UI. Resets the attempt window but keeps `resultRef`, so a job
   * that already produced an artifact will not create a second one.
   */
  async retry(ctx: TenantContext, jobId: string) {
    const job = await this.getById(ctx, jobId);
    if (job.status === 'running' || job.status === 'queued') return job;
    const [row] = await this.db
      .update(processingJobs)
      .set({
        status: 'queued',
        error: null,
        nextAttemptAt: new Date(),
        maxAttempts: job.maxAttempts + 1,
        finishedAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(processingJobs.id, jobId), eq(processingJobs.workspaceId, ctx.workspaceId)))
      .returning();
    if (!row) throw new NotFoundError('Job');
    return row;
  }

  async cancelForTarget(ctx: TenantContext, targetType: string, targetId: string) {
    const result = await this.db
      .update(processingJobs)
      .set({ status: 'cancelled', finishedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(processingJobs.workspaceId, ctx.workspaceId),
          eq(processingJobs.targetType, targetType),
          eq(processingJobs.targetId, targetId),
          inArray(processingJobs.status, ['queued', 'running']),
        ),
      )
      .returning({ id: processingJobs.id });
    return result.length;
  }

  async listAttempts(jobId: string) {
    return this.db
      .select()
      .from(jobAttempts)
      .where(eq(jobAttempts.jobId, jobId))
      .orderBy(asc(jobAttempts.attempt));
  }

  async listForTarget(ctx: TenantContext, targetType: string, targetId: string) {
    return this.db
      .select()
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.workspaceId, ctx.workspaceId),
          eq(processingJobs.targetType, targetType),
          eq(processingJobs.targetId, targetId),
        ),
      )
      .orderBy(asc(processingJobs.createdAt));
  }

  /** Failed and dead-lettered jobs power the dashboard "Needs attention" rail. */
  async listFailed(ctx: TenantContext, limit = 10) {
    return this.db
      .select()
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.workspaceId, ctx.workspaceId),
          inArray(processingJobs.status, ['failed', 'dead_letter']),
        ),
      )
      .orderBy(asc(processingJobs.updatedAt))
      .limit(limit);
  }

  async countByStatus(ctx: TenantContext) {
    const rows = await this.db
      .select({ status: processingJobs.status, value: count() })
      .from(processingJobs)
      .where(eq(processingJobs.workspaceId, ctx.workspaceId))
      .groupBy(processingJobs.status);
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.value)]));
  }

  /** Requeues jobs that a crashed worker left in `running`. */
  async reclaimStale(olderThanMs: number) {
    const cutoff = new Date(Date.now() - olderThanMs);
    const rows = await this.db
      .update(processingJobs)
      .set({ status: 'queued', nextAttemptAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(processingJobs.status, 'running'),
          lte(processingJobs.updatedAt, cutoff),
          or(isNull(processingJobs.finishedAt), sql`true`),
        ),
      )
      .returning({ id: processingJobs.id });
    return rows.length;
  }
}
