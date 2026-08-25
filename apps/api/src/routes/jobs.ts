import { Hono } from 'hono';
import type { JobView } from '@uxe/contracts';
import type { schema } from '@uxe/db';
import type { AppBindings, AppDeps } from '../context.js';
import { ApiError } from '../errors.js';
import { requireId } from '../middleware/validate.js';

type JobRow = typeof schema.processingJobs.$inferSelect;

/** Projects a stored job row onto the wire contract. */
export function toJobView(job: JobRow): JobView {
  return {
    id: job.id,
    kind: job.kind as JobView['kind'],
    status: job.status as JobView['status'],
    percent: job.percent,
    stages: job.stages.map((s) => ({
      key: s.key,
      label: s.label,
      state: s.state as JobView['stages'][number]['state'],
      detail: s.detail,
      percent: s.percent,
    })),
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    error: job.error
      ? {
          code: String(job.error.code ?? 'internal_error'),
          message: String(job.error.message ?? 'The job failed.'),
          retryable: Boolean(job.error.retryable ?? false),
          traceId: String(job.error.traceId ?? job.traceId),
        }
      : null,
    resultRef: job.resultRef
      ? { kind: job.resultRef.kind as JobView['resultRef'] extends null ? never : 'message', id: job.resultRef.id }
      : null,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  } as JobView;
}

export function jobRoutes(deps: AppDeps) {
  const app = new Hono<AppBindings>();

  app.get('/:id', async (c) => {
    const tenant = c.get('tenant');
    if (!tenant) throw ApiError.unauthenticated();
    const job = await deps.repos.jobs.getById(tenant, requireId(c, 'id'));
    return c.json(toJobView(job));
  });

  app.get('/:id/attempts', async (c) => {
    const tenant = c.get('tenant');
    if (!tenant) throw ApiError.unauthenticated();
    const id = requireId(c, 'id');
    await deps.repos.jobs.getById(tenant, id);
    const attempts = await deps.repos.jobs.listAttempts(id);
    return c.json(
      attempts.map((a) => ({
        attempt: a.attempt,
        status: a.status,
        stage: a.stage,
        message: a.message,
        durationMs: a.durationMs,
        metrics: a.metrics,
        startedAt: a.startedAt.toISOString(),
        finishedAt: a.finishedAt?.toISOString() ?? null,
      })),
    );
  });

  /**
   * Manual retry.
   *
   * The stored `resultRef` is deliberately preserved, so a job that already produced an
   * artifact before failing on a later stage cannot create a second one when retried.
   */
  app.post('/:id/retry', async (c) => {
    const tenant = c.get('tenant');
    if (!tenant) throw ApiError.unauthenticated();
    const id = requireId(c, 'id');

    const existing = await deps.repos.jobs.getById(tenant, id);
    if (existing.status === 'succeeded') {
      throw ApiError.conflict('That job already completed successfully; there is nothing to retry.');
    }
    if (existing.createdByUserId && existing.createdByUserId !== tenant.userId) {
      // Retrying somebody else's job is an admin action.
      const canManage = ['owner', 'admin'].includes(tenant.role);
      if (!canManage) throw ApiError.forbidden('Only the job owner or an admin can retry this job.');
    }

    const job = await deps.repos.jobs.retry(tenant, id);

    await deps.repos.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: tenant.userId,
      actorName: c.get('session')?.user.fullName ?? 'Unknown',
      action: 'job.retried',
      category: 'source',
      targetType: 'job',
      targetId: id,
      targetLabel: job.kind,
      traceId: tenant.traceId,
      summary: `Retried ${job.kind.replace(/_/g, ' ')} job (attempt ${job.attempt + 1}).`,
    });

    return c.json(toJobView(job));
  });

  return app;
}
