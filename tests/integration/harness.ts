import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, type Database } from '@uxe/db';
import { runMigrations } from '@uxe/db/migrate';
import { createLogger } from '@uxe/observability';
import { buildApp, type BuiltApp } from '../../apps/api/src/app.js';
import { startWorkerLoop } from '../../apps/api/src/jobs/loop.js';
import { ConsoleEmailDriver } from '../../apps/api/src/services/email.js';
import { FilesystemStorage } from '../../apps/api/src/services/storage.js';

/**
 * Integration harness.
 *
 * Runs the real application against a real PostgreSQL database, real migrations, real
 * repositories and the real document worker. The only substitutions are a temporary
 * filesystem bucket instead of R2 and the console email driver, both of which implement
 * the same interfaces the production drivers do.
 */

export interface Harness {
  app: BuiltApp['app'];
  deps: BuiltApp['deps'];
  db: Database;
  email: ConsoleEmailDriver;
  storagePath: string;
  /** Clears the in-memory rate-limit windows so one case cannot throttle the next. */
  resetRateLimits: () => void;
  close: () => Promise<void>;
}

const TEST_ENV = {
  NODE_ENV: 'test',
  APP_ENV: 'development',
  LOG_LEVEL: 'error',
  LOG_FORMAT: 'json',
  API_PORT: '8788',
  PUBLIC_APP_URL: 'http://localhost:5173',
  PUBLIC_API_URL: 'http://localhost:8788',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
  SESSION_SECRET: 'integration-test-session-secret-value-32b',
  CSRF_SECRET: 'integration-test-csrf-secret-value-32-bytes',
  ENCRYPTION_KEY: Buffer.from(new Uint8Array(32).fill(11)).toString('base64'),
  STORAGE_DRIVER: 'filesystem',
  EMAIL_DRIVER: 'console',
  EMAIL_FROM: 'ayumi@uxe.test',
  DOCUMENT_WORKER_URL: process.env.DOCUMENT_WORKER_URL ?? 'http://127.0.0.1:8000',
  DOCUMENT_WORKER_TOKEN: process.env.DOCUMENT_WORKER_TOKEN ?? 'dev-worker-token',
  RATE_LIMIT_DRIVER: 'memory',
  EMBEDDING_PROVIDER: 'deterministic',
  CHAT_PROVIDER: 'extractive',
} as const;

let migrated = false;

export async function createHarness(overrides: Record<string, string> = {}): Promise<Harness> {
  const url = process.env.DATABASE_URL;
  if (!url)
    throw new Error('DATABASE_URL is not set; tests/integration/setup.ts should have set it.');

  if (!migrated) {
    await runMigrations(url);
    migrated = true;
  }

  const handle = createDb({ url, max: 5 });

  const storagePath = await mkdtemp(join(tmpdir(), 'uxe-test-storage-'));
  const logger = createLogger({
    level: 'error',
    format: 'json',
    service: 'uxe-api-test',
    environment: 'test',
    version: '1.0.0',
  });
  const email = new ConsoleEmailDriver(logger);

  const built = buildApp({
    env: { ...TEST_ENV, DATABASE_URL: url, STORAGE_LOCAL_PATH: storagePath, ...overrides },
    db: handle.db,
    storage: new FilesystemStorage(storagePath, TEST_ENV.SESSION_SECRET, TEST_ENV.PUBLIC_API_URL),
    email,
    logger,
  });

  // The same in-process loop the Node deployment runs, so tests exercise the real
  // claim/run/retry path rather than a test-only shortcut.
  const stopWorker = startWorkerLoop(built.deps, { idleMs: 100, concurrency: 2 });

  return {
    app: built.app,
    deps: built.deps,
    db: handle.db,
    email,
    storagePath,
    resetRateLimits: () => {
      const limiter = built.deps.services.rateLimiter as { resetAll?: () => void };
      limiter.resetAll?.();
    },
    close: async () => {
      stopWorker();
      await new Promise((resolve) => setTimeout(resolve, 250));
      await handle.sql.end({ timeout: 5 });
      await rm(storagePath, { recursive: true, force: true });
    },
  };
}

/** Every table the suite writes to, ordered so foreign keys never block the truncate. */
export async function truncateAll(db: Database): Promise<void> {
  await db.execute(
    `DO $$
     DECLARE statements CURSOR FOR
       SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tablename <> 'schema_migrations';
     BEGIN
       FOR stmt IN statements LOOP
         EXECUTE 'ALTER TABLE ' || quote_ident(stmt.tablename) || ' DISABLE TRIGGER USER';
       END LOOP;
       FOR stmt IN statements LOOP
         EXECUTE 'TRUNCATE TABLE ' || quote_ident(stmt.tablename) || ' CASCADE';
       END LOOP;
       FOR stmt IN statements LOOP
         EXECUTE 'ALTER TABLE ' || quote_ident(stmt.tablename) || ' ENABLE TRIGGER USER';
       END LOOP;
     END $$;`,
  );
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
  raw: Response;
}

/**
 * One browser-like client: keeps cookies, tracks the CSRF token, and sends the Origin
 * header a browser would send. Anything the real client must do to be allowed through, the
 * test client must do too — otherwise the tests would pass against a server that rejects
 * every real request.
 */
export class Client {
  private cookies = new Map<string, string>();
  csrfToken: string | null = null;

  constructor(
    private readonly harness: Harness,
    readonly origin = 'http://localhost:5173',
  ) {}

  cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  setCookie(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  clearCookies(): void {
    this.cookies.clear();
    this.csrfToken = null;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      rawBody?: Uint8Array | string;
      headers?: Record<string, string>;
      idempotencyKey?: string;
      omitCsrf?: boolean;
      origin?: string | null;
    } = {},
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { ...options.headers };
    const cookie = this.cookieHeader();
    if (cookie) headers['cookie'] = cookie;

    const origin = options.origin === null ? null : (options.origin ?? this.origin);
    if (origin) headers['origin'] = origin;

    if (options.body !== undefined) headers['content-type'] ??= 'application/json';
    // An explicitly supplied token wins, so a test can send a forged one.
    if (this.csrfToken && method !== 'GET' && !options.omitCsrf && !headers['x-csrf-token']) {
      headers['x-csrf-token'] = this.csrfToken;
    }
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;

    const response = await this.harness.app.request(`http://localhost:8788/api/v1${path}`, {
      method,
      headers,
      body: (options.rawBody ??
        (options.body === undefined ? undefined : JSON.stringify(options.body))) as
        Uint8Array | string | undefined,
    });

    for (const value of response.headers.getSetCookie()) {
      const [pair] = value.split(';');
      const index = pair?.indexOf('=') ?? -1;
      if (index > 0 && pair) {
        const name = pair.slice(0, index);
        const cookieValue = pair.slice(index + 1);
        if (cookieValue === '' || /Max-Age=0/i.test(value)) this.cookies.delete(name);
        else this.cookies.set(name, cookieValue);
      }
    }

    const text = await response.clone().text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    return { status: response.status, body: body as T, headers: response.headers, raw: response };
  }

  get<T = unknown>(path: string, options?: Parameters<Client['request']>[2]) {
    return this.request<T>('GET', path, options);
  }
  post<T = unknown>(path: string, body?: unknown, options?: Parameters<Client['request']>[2]) {
    return this.request<T>('POST', path, { ...options, body });
  }
  patch<T = unknown>(path: string, body?: unknown, options?: Parameters<Client['request']>[2]) {
    return this.request<T>('PATCH', path, { ...options, body });
  }
  delete<T = unknown>(path: string, options?: Parameters<Client['request']>[2]) {
    return this.request<T>('DELETE', path, options);
  }

  /** Reads the session so the CSRF token is available for state-changing requests. */
  async refreshCsrf(): Promise<void> {
    const session = await this.get<{ csrfToken?: string }>('/auth/session');
    this.csrfToken = session.body?.csrfToken ?? null;
  }
}

export interface RegisteredAccount {
  client: Client;
  email: string;
  password: string;
  userId: string;
  organizationId: string;
  workspaceId: string;
}

let accountCounter = 0;

/**
 * Registers an owner through the real endpoints — no direct inserts — so the account under
 * test is created exactly the way a real one is.
 */
export async function registerOwner(
  harness: Harness,
  options: { organizationName?: string; fullName?: string } = {},
): Promise<RegisteredAccount> {
  accountCounter += 1;
  const email = `owner${accountCounter}@example.test`;
  const password = 'Tr0ubad0ur-Nimbus-42!';
  const client = new Client(harness);

  const registered = await client.post<{ status?: string }>('/auth/register', {
    email,
    password,
    fullName: options.fullName ?? `Owner ${accountCounter}`,
    organizationName: options.organizationName ?? `Org ${accountCounter}`,
    locale: 'en',
    acceptedTerms: true,
  });
  if (registered.status !== 201 && registered.status !== 200) {
    throw new Error(`Registration failed: ${registered.status} ${JSON.stringify(registered.body)}`);
  }

  // The server decides whether this deployment confirms addresses. Follow its answer
  // rather than assuming, so the helper works under either configuration.
  if (registered.body.status === 'email_verification_required') {
    await verifyEmail(harness, client, email);
  }
  await login(client, email, password);

  const session = await client.get<{
    user: { id: string };
    workspace: { id: string; organizationId: string };
  }>('/auth/session');

  return {
    client,
    email,
    password,
    userId: session.body.user.id,
    organizationId: session.body.workspace.organizationId,
    workspaceId: session.body.workspace.id,
  };
}

/** Pulls the verification token out of the email the app actually sent. */
export async function verifyEmail(harness: Harness, client: Client, email: string): Promise<void> {
  const message = harness.email.messagesFor(email).at(-1);
  if (!message) throw new Error(`No email was sent to ${email}`);
  const token = /token=([A-Za-z0-9_-]+)/.exec(`${message.text} ${message.html}`)?.[1];
  if (!token) throw new Error(`No verification token in the email to ${email}`);

  const response = await client.post('/auth/verify-email', { token });
  if (response.status >= 400) {
    throw new Error(`Verification failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
}

export async function login(client: Client, email: string, password: string): Promise<void> {
  const response = await client.post<{ status: string }>('/auth/login', {
    email,
    password,
    rememberMe: false,
  });
  if (response.status !== 200 || response.body.status !== 'authenticated') {
    throw new Error(`Login failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  await client.refreshCsrf();
}

/** Invites a member and signs them in, returning a client scoped to that role. */
export async function addMember(
  harness: Harness,
  owner: RegisteredAccount,
  role: string,
): Promise<{ client: Client; email: string; userId: string }> {
  accountCounter += 1;
  const email = `member${accountCounter}@example.test`;
  const password = 'An0ther-Str0ng-Passphrase!';

  const invite = await owner.client.post<{ id: string; inviteToken?: string }>('/users/invite', {
    email,
    fullName: `Member ${accountCounter}`,
    role,
  });
  if (invite.status >= 400) {
    throw new Error(`Invite failed: ${invite.status} ${JSON.stringify(invite.body)}`);
  }

  const message = harness.email.messagesFor(email).at(-1);
  const token = message
    ? /token=([A-Za-z0-9_-]+)/.exec(`${message.text} ${message.html}`)?.[1]
    : null;
  if (!token) throw new Error(`No invitation token in the email to ${email}`);

  // Accepted through the real endpoint, exactly as the invitation email's link does.
  const client = new Client(harness);
  const accepted = await client.post('/auth/invitations/accept', {
    token,
    fullName: `Member ${accountCounter}`,
    password,
  });
  if (accepted.status >= 400) {
    throw new Error(
      `Accepting the invitation failed: ${accepted.status} ${JSON.stringify(accepted.body)}`,
    );
  }

  client.clearCookies();
  await login(client, email, password);
  const session = await client.get<{ user: { id: string } }>('/auth/session');
  return { client, email, userId: session.body.user.id };
}

/** Polls a job until it leaves the running states, so tests assert on real completion. */
export interface SettledJob {
  status: string;
  error: string;
  stages: Array<{ key: string; label: string; state: string; detail: string | null }>;
  /** What the job produced: the message, artifact, source, review or plan it created. */
  resultRef: { kind: string; id: string } | null;
}

export async function waitForJob(
  client: Client,
  jobId: string,
  timeoutMs = 90_000,
): Promise<SettledJob> {
  const deadline = Date.now() + timeoutMs;
  let last: SettledJob = { status: 'unknown', error: '', stages: [], resultRef: null };

  while (Date.now() < deadline) {
    const response = await client.get<{
      status: string;
      error: { message?: string } | null;
      stages: SettledJob['stages'];
      resultRef: { kind: string; id: string } | null;
    }>(`/jobs/${jobId}`);

    if (response.status === 200) {
      last = {
        status: response.body.status,
        error: response.body.error?.message ?? '',
        stages: response.body.stages ?? [],
        resultRef: response.body.resultRef ?? null,
      };
      if (['succeeded', 'failed', 'cancelled', 'dead_letter'].includes(last.status)) return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `Job ${jobId} did not settle within ${timeoutMs}ms (last status: ${last.status})`,
  );
}
