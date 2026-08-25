import type { Context } from 'hono';
import { AuthorizationError, NotFoundError, VersionConflictError } from '@uxe/db';
import { ProviderError } from '@uxe/rag';
import { OAuthError } from '@uxe/auth';
import type { ErrorCode } from '@uxe/contracts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly options: {
      details?: Record<string, unknown>;
      fieldErrors?: Record<string, string[]>;
      retryable?: boolean;
      retryAfterSeconds?: number;
    } = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(message: string, fieldErrors?: Record<string, string[]>) {
    return new ApiError(400, 'validation_failed', message, { fieldErrors: fieldErrors ?? {} });
  }
  static unauthenticated(message = 'Sign in to continue.') {
    return new ApiError(401, 'unauthenticated', message);
  }
  static sessionExpired() {
    return new ApiError(401, 'session_expired', 'Your session has expired. Sign in again to continue.');
  }
  static forbidden(message = 'You do not have permission to perform this action.') {
    return new ApiError(403, 'forbidden', message);
  }
  static notFound(resource = 'Resource') {
    return new ApiError(404, 'not_found', `${resource} not found.`);
  }
  static conflict(message: string) {
    return new ApiError(409, 'conflict', message);
  }
  static rateLimited(retryAfterSeconds: number) {
    return new ApiError(429, 'rate_limited', 'Too many requests. Please slow down.', {
      retryable: true,
      retryAfterSeconds,
    });
  }
  static internal(message = 'Something went wrong on our side.') {
    return new ApiError(500, 'internal_error', message, { retryable: true });
  }
}

/**
 * Maps every error the stack can raise onto the single error envelope.
 *
 * Two rules are load-bearing:
 *  - a repository `NotFoundError` from a cross-tenant probe stays a 404, so the existence
 *    of another tenant's row is never disclosed through a status-code difference;
 *  - unexpected errors never leak their message to the client. The message is logged with
 *    the traceId, and the client receives only that traceId to quote in support.
 */
export function toErrorResponse(
  error: unknown,
  traceId: string,
): { status: number; body: Record<string, unknown>; headers: Record<string, string>; logLevel: 'warn' | 'error' } {
  const headers: Record<string, string> = {};

  if (error instanceof ApiError) {
    if (error.options.retryAfterSeconds !== undefined) {
      headers['retry-after'] = String(error.options.retryAfterSeconds);
    }
    return {
      status: error.status,
      logLevel: error.status >= 500 ? 'error' : 'warn',
      headers,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.options.details ? { details: error.options.details } : {}),
          ...(error.options.fieldErrors ? { fieldErrors: error.options.fieldErrors } : {}),
          traceId,
          retryable: error.options.retryable ?? false,
        },
      },
    };
  }

  if (error instanceof AuthorizationError) {
    return {
      status: 403,
      logLevel: 'warn',
      headers,
      body: { error: { code: 'forbidden', message: error.message, traceId, retryable: false } },
    };
  }

  if (error instanceof NotFoundError) {
    return {
      status: 404,
      logLevel: 'warn',
      headers,
      body: { error: { code: 'not_found', message: error.message, traceId, retryable: false } },
    };
  }

  if (error instanceof VersionConflictError) {
    return {
      status: 409,
      logLevel: 'warn',
      headers,
      body: {
        error: {
          code: 'version_conflict',
          message: error.message,
          details: { expected: error.expected, actual: error.actual },
          traceId,
          retryable: false,
        },
      },
    };
  }

  if (error instanceof ProviderError) {
    if (error.retryable) headers['retry-after'] = '30';
    return {
      status: error.code === 'rate_limited' ? 429 : 502,
      logLevel: 'error',
      headers,
      body: {
        error: {
          code: 'provider_unavailable',
          message: error.message,
          // The detail is safe to surface: it is what the operator needs to fix the config.
          details: error.detail ? { detail: error.detail, provider_code: error.code } : { provider_code: error.code },
          traceId,
          retryable: error.retryable,
        },
      },
    };
  }

  if (error instanceof OAuthError) {
    return {
      status: 400,
      logLevel: 'warn',
      headers,
      body: { error: { code: 'validation_failed', message: error.message, traceId, retryable: false } },
    };
  }

  return {
    status: 500,
    logLevel: 'error',
    headers,
    body: {
      error: {
        code: 'internal_error',
        message: 'Something went wrong on our side. Quote the reference below if you contact support.',
        traceId,
        retryable: true,
      },
    },
  };
}

export function respondWithError(c: Context, error: unknown, traceId: string) {
  const mapped = toErrorResponse(error, traceId);
  for (const [key, value] of Object.entries(mapped.headers)) c.header(key, value);
  return c.json(mapped.body, mapped.status as never);
}
