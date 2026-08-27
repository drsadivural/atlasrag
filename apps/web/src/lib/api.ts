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

/**
 * Describes field errors the form does not render itself.
 *
 * "Please correct the highlighted fields" with nothing highlighted is a dead end: it names
 * a problem the user has no way to find. Anything the server rejected that the form has no
 * input for is surfaced at form level instead.
 */
export function unrenderedFieldErrors(error: ApiError, rendered: string[]): string | null {
  const shown = new Set(rendered);
  const rest = Object.entries(error.fieldErrors)
    .filter(([field]) => !shown.has(field))
    .map(([field, messages]) => `${field}: ${messages.join(', ')}`);
  return rest.length > 0 ? rest.join('; ') : null;
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
    body:
      options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
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
export interface UploadResult {
  sourceId: string;
  versionId: string;
  duplicate: boolean;
  message?: string;
  job: unknown;
}

/**
 * The largest body sent in one request.
 *
 * Not a limit of this application — the server takes a whole file happily. It is what
 * survives the trip: Cloudflare refuses a request body over 100MB on most plans, and it
 * refuses it at the edge, so a single-shot upload of a large document never arrives at
 * all. 48MB leaves generous headroom for whatever else sits in front of the origin.
 */
export const UPLOAD_CHUNK_BYTES = 48 * 1024 * 1024;

/**
 * Sends a file, in one request or in several.
 *
 * A file that fits goes in one request exactly as before. A larger one is cut into parts,
 * each sent in order and numbered, and the server assembles them; progress is reported
 * across the whole file rather than restarting per part, because that is what the person
 * watching it cares about.
 */
/** How far along an upload is, in bytes as well as in percent. */
export interface UploadProgress {
  percent: number;
  /** Bytes accepted so far, across every part when the file is sent in several. */
  loaded: number;
  total: number;
}

export async function uploadFile(
  url: string,
  file: File,
  options: {
    onProgress?: (progress: UploadProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<UploadResult> {
  if (file.size <= UPLOAD_CHUNK_BYTES) {
    return putBody(url, file, file.type || 'application/octet-stream', options);
  }

  const total = Math.ceil(file.size / UPLOAD_CHUNK_BYTES);
  let sent = 0;
  let last: UploadResult | { complete?: boolean } = {};

  for (let index = 1; index <= total; index += 1) {
    const start = (index - 1) * UPLOAD_CHUNK_BYTES;
    const part = file.slice(start, Math.min(start + UPLOAD_CHUNK_BYTES, file.size));
    const before = sent;

    last = await putBody(url, part, file.type || 'application/octet-stream', {
      ...options,
      headers: { 'x-upload-part': String(index), 'x-upload-parts': String(total) },
      onProgress: (partProgress) => {
        // Across the whole file, not this part: the person watching is waiting for a
        // document, and has no idea it was cut into three.
        const loaded = Math.min(file.size, before + partProgress.loaded);
        options.onProgress?.({
          percent: Math.min(100, Math.round((loaded / file.size) * 100)),
          loaded,
          total: file.size,
        });
      },
    });

    sent = before + part.size;
  }

  return last as UploadResult;
}

function putBody(
  url: string,
  body: Blob,
  contentType: string,
  options: {
    onProgress?: (progress: UploadProgress) => void;
    signal?: AbortSignal;
    headers?: Record<string, string>;
  } = {},
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', url, true);
    request.withCredentials = true;
    request.setRequestHeader('content-type', contentType);
    if (csrfToken) request.setRequestHeader('x-csrf-token', csrfToken);
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      request.setRequestHeader(name, value);
    }

    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        options.onProgress?.({
          percent: Math.round((event.loaded / event.total) * 100),
          loaded: event.loaded,
          total: event.total,
        });
      }
    });

    request.addEventListener('load', () => {
      let body: Record<string, unknown>;
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
      reject(
        new ApiError(0, 'network_error', 'The upload could not reach the server.', {}, '', true),
      ),
    );
    request.addEventListener('abort', () =>
      reject(new ApiError(0, 'cancelled', 'The upload was cancelled.', {}, '', false)),
    );

    options.signal?.addEventListener('abort', () => request.abort());
    request.send(body);
  });
}

/** A client-side idempotency key. Stable per user action, not per retry. */
export function newIdempotencyKey(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID()}`;
}
