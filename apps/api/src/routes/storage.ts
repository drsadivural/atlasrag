import { Hono } from 'hono';
import type { AppBindings, AppDeps } from '../context.js';
import { ApiError } from '../errors.js';
import { FilesystemStorage } from '../services/storage.js';

/**
 * Serves objects for the local filesystem storage driver.
 *
 * The route is unauthenticated by design: it is reached through an HMAC-signed, expiring
 * URL issued only after a permission check. The signature covers the bucket, key and
 * expiry, so the link cannot be edited to reach a different object or to outlive its
 * window. In production this driver is refused outright and R2 presigned URLs are used.
 */
export function storageRoutes(deps: AppDeps) {
  const app = new Hono<AppBindings>();

  app.get('/:bucket', async (c) => {
    const bucket = c.req.param('bucket');
    if (bucket !== 'originals' && bucket !== 'artifacts') throw ApiError.notFound();

    if (!(deps.services.storage instanceof FilesystemStorage)) {
      throw ApiError.notFound();
    }

    const params = new URL(c.req.url).searchParams;
    const key = params.get('key');
    if (!key) throw ApiError.notFound();

    const valid = await deps.services.storage.verifySignature(params, bucket, key);
    if (!valid) {
      throw new ApiError(403, 'forbidden', 'This download link has expired or is not valid.');
    }

    const bytes = await deps.services.storage.get(bucket, key);
    if (!bytes) throw ApiError.notFound('File');

    const fileName = (params.get('filename') ?? 'download').replace(/[^\w\s.-]/g, '');
    // Always an attachment with a fixed content type: rendering a user-supplied document
    // inline would let an uploaded HTML file execute on this origin.
    c.header('content-type', 'application/octet-stream');
    c.header('content-disposition', `attachment; filename="${fileName}"`);
    c.header('cache-control', 'private, no-store');
    c.header('x-content-type-options', 'nosniff');
    return c.body(bytes as unknown as ArrayBuffer);
  });

  return app;
}
