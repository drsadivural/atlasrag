import type { Context, MiddlewareHandler } from 'hono';
import type { z } from 'zod';
import type { AppBindings } from '../context.js';
import { ApiError } from '../errors.js';

/**
 * Schema validation with field-level errors.
 *
 * Errors are shaped as `{ field: [messages] }` so the browser can attach each message to
 * the input that produced it rather than showing one opaque banner.
 */
export function validateJson<T extends z.ZodTypeAny>(schema: T): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw ApiError.badRequest('Request body must be valid JSON.');
    }

    const result = schema.safeParse(raw);
    if (!result.success) {
      throw ApiError.badRequest(
        'Please correct the highlighted fields.',
        fieldErrors(result.error),
      );
    }

    // Stashed under a symbol-free key the route reads via `validated()`.
    (c.req as unknown as { valid_json?: unknown }).valid_json = result.data;
    await next();
  };
}

export function validateQuery<T extends z.ZodTypeAny>(schema: T): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const raw = Object.fromEntries(new URL(c.req.url).searchParams.entries());
    const result = schema.safeParse(raw);
    if (!result.success) {
      throw ApiError.badRequest(
        'One or more query parameters are invalid.',
        fieldErrors(result.error),
      );
    }
    (c.req as unknown as { valid_query?: unknown }).valid_query = result.data;
    await next();
  };
}

export function body<T>(c: Context): T {
  return (c.req as unknown as { valid_json: T }).valid_json;
}

export function query<T>(c: Context): T {
  return (c.req as unknown as { valid_query: T }).valid_query;
}

function fieldErrors(error: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join('.') : '_root';
    (out[path] ??= []).push(issue.message);
  }
  return out;
}

/** Validates a path parameter that must be a ULID, so a malformed id 404s cleanly. */
export function requireId(c: Context, name: string): string {
  const value = c.req.param(name);
  if (!value || !/^[0-7][0-9ABCDEFGHJKMNPQRSTVWXYZ]{25}$/.test(value)) {
    throw ApiError.notFound();
  }
  return value;
}
