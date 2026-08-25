import { buildApp, type BuiltApp } from './app.js';
import { drainQueue } from './jobs/loop.js';
import { KvRateLimiter, type KvNamespaceLike } from './services/rate-limit.js';

/**
 * Cloudflare Workers entry point.
 *
 * The Hono app itself is runtime-agnostic; everything runtime-specific lives here. Two
 * differences from the Node entry:
 *
 *  - configuration arrives as bindings rather than `process.env`, so the app is built per
 *    isolate on first request instead of once at module load;
 *  - there is no long-lived process to host the job loop, so the queue is drained by a
 *    scheduled trigger instead.
 */

/*
 * The two runtime types this entry needs, declared structurally.
 *
 * `@cloudflare/workers-types` would supply them, but it also replaces the global lib with
 * the Workers one, and this package compiles against `@types/node` for the WebCrypto
 * surfaces the auth package uses. Two interfaces are cheaper than that collision.
 */
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  /** Present from Wrangler 4; Hono's own signature requires it. */
  props: unknown;
  exports?: unknown;
}

interface ScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
}

interface Bindings {
  HYPERDRIVE?: { connectionString: string };
  RATE_LIMIT_KV?: KvNamespaceLike;
  [key: string]: unknown;
}

/**
 * Built once per isolate and reused. Rebuilding per request would open a new database
 * pool on every call, which is the fastest way to exhaust a connection limit.
 */
let built: BuiltApp | null = null;

function app(bindings: Bindings): BuiltApp {
  if (built) return built;

  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(bindings)) {
    if (typeof value === 'string') env[key] = value;
  }

  // Hyperdrive hands back a normal PostgreSQL URL; the same `postgres` client runs against
  // it unchanged.
  if (bindings.HYPERDRIVE?.connectionString) {
    env.DATABASE_URL = bindings.HYPERDRIVE.connectionString;
  }

  built = buildApp({
    env,
    // KV is eventually consistent, which is acceptable for a limiter and is what the
    // `kv` driver documents. Without a binding the app falls back to the in-memory
    // limiter, which on Workers means per-isolate — enough for local `wrangler dev`,
    // never enough for production, which is why the binding is declared in wrangler.toml.
    ...(bindings.RATE_LIMIT_KV ? { rateLimiter: new KvRateLimiter(bindings.RATE_LIMIT_KV) } : {}),
  });

  return built;
}

export default {
  fetch(request: Request, bindings: Bindings, ctx: ExecutionContext): Response | Promise<Response> {
    return app(bindings).app.fetch(request, bindings, ctx);
  },

  /**
   * Drains whatever work is queued.
   *
   * Jobs are rows claimed with `FOR UPDATE SKIP LOCKED`, so several invocations may run
   * concurrently without ever handling the same job twice, and a run that ends mid-job
   * leaves it to be reclaimed after its stale window.
   */
  async scheduled(_event: ScheduledController, bindings: Bindings, ctx: ExecutionContext) {
    const { deps } = app(bindings);
    ctx.waitUntil(
      drainQueue(deps).catch((error: unknown) => {
        deps.logger.error('worker.scheduled_drain_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }),
    );
  },
};
