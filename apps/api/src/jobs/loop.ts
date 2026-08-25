import type { AppDeps } from '../context.js';
import { runJob, type JobRecord } from './runner.js';

export interface WorkerLoopOptions {
  /** How long to wait when the queue is empty before polling again. */
  idleMs?: number;
  /** How many jobs to run concurrently in this process. */
  concurrency?: number;
  /** A `running` job untouched for this long is assumed abandoned and requeued. */
  staleAfterMs?: number;
}

/**
 * In-process job loop, used by the Node deployment and by tests.
 *
 * On Cloudflare the same `runJob` is invoked from a Queues consumer instead; the claim is
 * `FOR UPDATE SKIP LOCKED` either way, so any number of processes can drain the queue
 * without ever handling the same job twice.
 */
export function startWorkerLoop(deps: AppDeps, options: WorkerLoopOptions = {}): () => void {
  const idleMs = options.idleMs ?? 500;
  const concurrency = options.concurrency ?? 2;
  const staleAfterMs = options.staleAfterMs ?? 5 * 60_000;

  let stopped = false;
  let lastReclaim = 0;

  const workers = Array.from({ length: concurrency }, (_, slot) => runSlot(slot));

  async function runSlot(slot: number): Promise<void> {
    const logger = deps.logger.child({ workerSlot: slot });

    while (!stopped) {
      try {
        // Periodically requeue jobs a crashed process left mid-flight.
        if (Date.now() - lastReclaim > 60_000) {
          lastReclaim = Date.now();
          const reclaimed = await deps.repos.jobs.reclaimStale(staleAfterMs);
          if (reclaimed > 0) logger.warn('jobs.reclaimed', { count: reclaimed });
        }

        const claimed = await deps.repos.jobs.claimNext();
        if (!claimed) {
          await sleep(idleMs);
          continue;
        }

        const record: JobRecord = {
          id: claimed.id,
          organizationId: claimed.organizationId,
          workspaceId: claimed.workspaceId,
          kind: claimed.kind,
          traceId: claimed.traceId,
          payload: claimed.payload,
          attempt: claimed.attempt,
          maxAttempts: claimed.maxAttempts,
          createdByUserId: claimed.createdByUserId,
        };

        await runJob(deps, record).catch(() => {
          // runJob has already recorded the failure and scheduled any retry; swallowing
          // here keeps one bad job from stopping the loop.
        });
      } catch (error) {
        logger.error('worker.loop_error', {
          error: error instanceof Error ? error.message : String(error),
        });
        await sleep(2000);
      }
    }
  }

  return () => {
    stopped = true;
    void Promise.allSettled(workers);
  };
}

/** Drains the queue once and returns. Used by integration tests to run jobs inline. */
export async function drainQueue(deps: AppDeps, maxJobs = 50): Promise<number> {
  let processed = 0;

  for (let i = 0; i < maxJobs; i += 1) {
    const claimed = await deps.repos.jobs.claimNext();
    if (!claimed) break;

    await runJob(deps, {
      id: claimed.id,
      organizationId: claimed.organizationId,
      workspaceId: claimed.workspaceId,
      kind: claimed.kind,
      traceId: claimed.traceId,
      payload: claimed.payload,
      attempt: claimed.attempt,
      maxAttempts: claimed.maxAttempts,
      createdByUserId: claimed.createdByUserId,
    }).catch(() => {});

    processed += 1;
  }

  return processed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
