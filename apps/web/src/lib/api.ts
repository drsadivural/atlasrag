import type { ApiErrorBody } from '@uxe/contracts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors: Record<string, string[]> = {},
    readonly traceId: string = '',
    readonly retryable = false,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when the session is gone and the user must sign in again. */
  get isAuthError(): boolean {
    return this.code === 'unauthenticated' || this.code === 'session_expired';
  }
}

/**
 * The CSRF token, kept in memory.
 *
 * Deliberately not in localStorage: an XSS that can read storage could then forge a
 * state-changing request. It is re-read from the session endpoint on load, and the server
 * still validates it against the session's own secret.
 */
let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

/** Called when a request returns 401 so the app can route to sign-in exactly once. */
type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler = () => {};

export function setUnauthorizedHandler(handler: UnauthorizedHandler): void {
  onUnauthorized = handler;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  body?: unknown;
  /** Sent as Idempotency-Key so a retry cannot duplicate work or artifacts. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Raw bytes for an upload; skips JSON encoding. */
  rawBody?: BodyInit;
  headers?: Record<string, string>;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { ...options.headers };

  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (csrfToken && method !== 'GET') headers['x-csrf-token'] = csrfToken;
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;

  const response = await fetch(path.startsWith('http') ? path : `/api/v1${path}`, {
    method,
    headers,
    // Same-origin in dev (via the Vite proxy) and in production, so the HttpOnly session
    // cookie travels without CORS credentials games.
    credentials: 'same-origin',
    body: options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    signal: options.signal ?? null,
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const envelope = parsed as ApiErrorBody | null;
    const error = new ApiError(
      response.status,
      envelope?.error?.code ?? 'internal_error',
      envelope?.error?.message ?? `Request failed with status ${response.status}.`,
      envelope?.error?.fieldErrors ?? {},
      envelope?.error?.traceId ?? response.headers.get('x-trace-id') ?? '',
      envelope?.error?.retryable ?? false,
      (envelope?.error?.details as Record<string, unknown>) ?? {},
    );

    // A dead session must not leave the user staring at a permission error on every panel.
    if (error.isAuthError) onUnauthorized();
    throw error;
  }

  return parsed as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => apiRequest<T>(path, { signal }),
  post: <T>(path: string, body?: unknown, idempotencyKey?: string) =>
    apiRequest<T>(path, { method: 'POST', body, ...(idempotencyKey ? { idempotencyKey } : {}) }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => apiRequest<T>(path, { method: 'DELETE' }),
};

/**
 * Uploads bytes to an upload ticket with progress reporting.
 *
 * XMLHttpRequest rather than fetch: fetch still cannot report upload progress in browsers,
 * and a 1,300-page regulation uploading with no feedback is indistinguishable from a hang.
 */
export function uploadFile(
  url: string,
  file: File,
  options: {
    onProgress?: (percent: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<{ sourceId: string; versionId: string; duplicate: boolean; message?: string; job: unknown }> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', url, true);
    request.withCredentials = true;
    request.setRequestHeader('content-type', file.type || 'application/octet-stream');
    if (csrfToken) request.setRequestHeader('x-csrf-token', csrfToken);

    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        options.onProgress?.(Math.round((event.loaded / event.total) * 100));
      }
    });

    request.addEventListener('load', () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(request.responseText) as Record<string, unknown>;
      } catch {
        body = {};
      }

      if (request.status >= 200 && request.status < 300) {
        resolve(body as never);
      } else {
        const envelope = body as unknown as ApiErrorBody;
        reject(
          new ApiError(
            request.status,
            envelope?.error?.code ?? 'internal_error',
            envelope?.error?.message ?? 'The upload failed.',
            envelope?.error?.fieldErrors ?? {},
            envelope?.error?.traceId ?? '',
            envelope?.error?.retryable ?? true,
          ),
        );
      }
    });

    request.addEventListener('error', () =>
      reject(new ApiError(0, 'network_error', 'The upload could not reach the server.', {}, '', true)),
    );
    request.addEventListener('abort', () =>
      reject(new ApiError(0, 'cancelled', 'The upload was cancelled.', {}, '', false)),
    );

    options.signal?.addEventListener('abort', () => request.abort());
    request.send(file);
  });
}

/** A client-side idempotency key. Stable per user action, not per retry. */
export function newIdempotencyKey(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID()}`;
}
