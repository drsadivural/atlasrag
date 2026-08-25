import type { MiddlewareHandler } from 'hono';
import { sha256Hex } from '@uxe/auth';
import type { AppBindings, AppDeps } from '../context.js';
import { ApiError } from '../errors.js';

/**
 * Idempotency for mutations that create work or artifacts.
 *
 * A repeated request with the same key returns the ORIGINAL response instead of doing the
 * work twice. The request body is hashed and compared, so reusing a key with different
 * content is a 409 rather than a silently wrong replay — that distinction is what stops a
 * client from accidentally receiving somebody else's result.
 *
 * Job creation is additionally guarded at the database level by a unique index on
 * (workspace_id, kind, idempotency_key), so even a race between two identical in-flight
 * requests produces one job.
 */
export function idempotency(deps: AppDeps): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    if (c.req.method !== 'POST' && c.req.method !== 'PATCH') return next();

    const key = c.req.header('idempotency-key');
    if (!key) return next();

    if (key.length < 8 || key.length > 128) {
      throw ApiError.badRequest('Idempotency-Key must be between 8 and 128 characters.');
    }

    const tenant = c.get('tenant');
    const session = c.get('session');
    if (!tenant || !session) return next();

    const endpoint = `${c.req.method} ${c.req.routePath ?? c.req.path}`;
    const rawBody = await c.req.raw.clone().text();
    const requestHash = await sha256Hex(rawBody);

    const existing = await deps.repos.idempotency.find(tenant.workspaceId, endpoint, key);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ApiError(
          409,
          'idempotency_conflict',
          'This Idempotency-Key was already used with a different request body.',
        );
      }
      c.header('idempotency-replayed', 'true');
      return c.json(existing.responseBody, existing.statusCode as never);
    }

    await next();

    // Only successful mutations are recorded. A failed request must remain retryable with
    // the same key, otherwise a transient outage would permanently poison it.
    if (c.res.status >= 200 && c.res.status < 300) {
      try {
        const body = (await c.res.clone().json()) as Record<string, unknown>;
        await deps.repos.idempotency.save({
          workspaceId: tenant.workspaceId,
          userId: session.userId,
          endpoint,
          idempotencyKey: key,
          requestHash,
          statusCode: c.res.status,
          responseBody: body,
        });
      } catch {
        // A non-JSON success (a stream, a redirect) simply is not replayable; the
        // database-level job guard still prevents duplicate work.
      }
    }
  };
}
