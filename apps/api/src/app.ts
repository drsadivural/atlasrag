import { Hono } from 'hono';
import {
  ArtifactRepository,
  AuditRepository,
  ConsultationRepository,
  CorrectionRepository,
  IdempotencyRepository,
  IdentityRepository,
  JobRepository,
  MetricsRepository,
  PipelineRepository,
  RetrievalRepository,
  SettingsRepository,
  SourceRepository,
  UploadTicketRepository,
  createDb,
  type Database,
} from '@uxe/db';
import {
  type Logger,
  MetricsRegistry,
  Tracer,
  createLogger,
  createOtlpExporter,
} from '@uxe/observability';
import { buildOpenApiDocument } from '@uxe/contracts';
import type { AppBindings, AppDeps, Repositories, Services } from './context.js';
import { loadEnv, type AppEnv } from './env.js';
import {
  cors,
  csrf,
  errorHandler,
  metrics as metricsMiddleware,
  rateLimit,
  requireAuth,
  requireTenant,
  securityHeaders,
  session,
  tracing,
} from './middleware/index.js';
import { idempotency } from './middleware/idempotency.js';
import { authRoutes } from './routes/auth.js';
import { sourceRoutes } from './routes/sources.js';
import { consultationRoutes } from './routes/consultations.js';
import { correctionRoutes } from './routes/corrections.js';
import { jobRoutes } from './routes/jobs.js';
import {
  artifactRoutes,
  auditRoutes,
  citationRoutes,
  dashboardRoutes,
  settingsRoutes,
  systemRoutes,
  userRoutes,
} from './routes/misc.js';
import { storageRoutes } from './routes/storage.js';
import { ConsoleEmailDriver, ResendEmailDriver, type EmailDriver } from './services/email.js';
import { FilesystemStorage, S3Storage, type StorageDriver } from './services/storage.js';
import { DocumentWorkerClient } from './services/document-worker.js';
import { MemoryRateLimiter, type RateLimiter } from './services/rate-limit.js';
import { buildProviders } from './services/providers.js';

export interface BuildOptions {
  env?: Record<string, string | undefined>;
  /** Injected by integration tests so they can share one database handle. */
  db?: Database;
  storage?: StorageDriver;
  email?: EmailDriver;
  logger?: Logger;
  /**
   * Supplied by the Workers entry, which binds a KV-backed limiter. Without it the app
   * uses the in-process limiter, which is correct for a single Node process and is
   * per-isolate — that is, useless — on Workers.
   */
  rateLimiter?: RateLimiter;
}

export interface BuiltApp {
  app: Hono<AppBindings>;
  deps: AppDeps;
}

/**
 * Builds the API.
 *
 * Everything the app touches arrives through `AppDeps`, so the same object runs on
 * Cloudflare Workers (env from the Worker bindings), on Node (env from process.env) and in
 * integration tests (env and database injected). No module reaches for global state.
 */
export function buildApp(options: BuildOptions = {}): BuiltApp {
  const env: AppEnv = loadEnv(
    options.env ??
      (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ??
      {},
  );

  const logger =
    options.logger ??
    createLogger({
      level: env.LOG_LEVEL,
      format: env.LOG_FORMAT,
      service: env.OTEL_SERVICE_NAME,
      environment: env.APP_ENV,
      version: '1.0.0',
      redact: { allowDocumentContent: env.LOG_DOCUMENT_CONTENT },
    });

  const tracer = new Tracer(
    env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? createOtlpExporter({
          endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
          serviceName: env.OTEL_SERVICE_NAME,
        })
      : () => {},
    env.TRACE_SAMPLE_RATE,
  );

  const metrics = new MetricsRegistry();
  const db =
    options.db ?? createDb({ url: env.DATABASE_URL, max: env.DATABASE_MAX_CONNECTIONS }).db;

  const repos: Repositories = {
    identity: new IdentityRepository(db),
    sources: new SourceRepository(db),
    consultations: new ConsultationRepository(db),
    retrieval: new RetrievalRepository(db),
    jobs: new JobRepository(db),
    artifacts: new ArtifactRepository(db),
    corrections: new CorrectionRepository(db),
    audit: new AuditRepository(db),
    settings: new SettingsRepository(db),
    idempotency: new IdempotencyRepository(db),
    uploads: new UploadTicketRepository(db),
    pipeline: new PipelineRepository(db),
    metrics: new MetricsRepository(db),
  };

  const storage =
    options.storage ??
    (env.STORAGE_DRIVER === 's3'
      ? new S3Storage({
          endpoint: env.S3_ENDPOINT,
          region: env.S3_REGION,
          accessKeyId: env.S3_ACCESS_KEY_ID,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          bucketOriginals: env.S3_BUCKET_ORIGINALS,
          bucketArtifacts: env.S3_BUCKET_ARTIFACTS,
        })
      : new FilesystemStorage(env.STORAGE_LOCAL_PATH, env.SESSION_SECRET, env.PUBLIC_API_URL));

  const email =
    options.email ??
    (env.EMAIL_DRIVER === 'resend'
      ? new ResendEmailDriver(env.RESEND_API_KEY, env.EMAIL_FROM)
      : new ConsoleEmailDriver(logger));

  const providers = buildProviders(env);

  const services: Services = {
    storage,
    email,
    documentWorker: new DocumentWorkerClient(
      env.DOCUMENT_WORKER_URL,
      env.DOCUMENT_WORKER_TOKEN,
      env.DOCUMENT_WORKER_TIMEOUT_MS,
    ),
    rateLimiter: options.rateLimiter ?? new MemoryRateLimiter(),
    embeddings: providers.embeddings,
    chat: providers.chat,
  };

  const deps: AppDeps = { env, db, repos, services, logger, tracer, metrics };
  const app = new Hono<AppBindings>();

  // Order matters: tracing first so every later layer can log with a traceId, and the
  // error handler immediately after so it can read that traceId when something throws.
  app.use('*', tracing(deps));
  app.use('*', securityHeaders(deps));
  app.use('*', cors(deps));
  app.use('*', metricsMiddleware(deps));
  app.use('/api/*', session(deps));
  app.use('/api/*', rateLimit(deps));
  app.use('/api/*', csrf(deps));

  const v1 = new Hono<AppBindings>();

  // Public: health, readiness, metrics, storage (signature-verified), auth.
  v1.route('/', systemRoutes(deps));
  v1.route('/storage', storageRoutes(deps));
  v1.route('/auth', authRoutes(deps));

  v1.get('/openapi.json', (c) =>
    c.json(buildOpenApiDocument({ version: '1.0.0', serverUrl: deps.env.PUBLIC_API_URL })),
  );

  // Everything below requires an authenticated session AND a resolved workspace.
  const tenantScoped = new Hono<AppBindings>();
  tenantScoped.use('*', requireAuth());
  tenantScoped.use('*', requireTenant(deps));
  tenantScoped.use('*', idempotency(deps));

  tenantScoped.route('/dashboard', dashboardRoutes(deps));
  tenantScoped.route('/sources', sourceRoutes(deps));
  tenantScoped.route('/consultations', consultationRoutes(deps));
  tenantScoped.route('/corrections', correctionRoutes(deps));
  tenantScoped.route('/jobs', jobRoutes(deps));
  tenantScoped.route('/citations', citationRoutes(deps));
  tenantScoped.route('/artifacts', artifactRoutes(deps));
  tenantScoped.route('/audit-events', auditRoutes(deps));
  tenantScoped.route('/users', userRoutes(deps));
  tenantScoped.route('/settings', settingsRoutes(deps));

  v1.route('/', tenantScoped);
  app.route('/api/v1', v1);

  app.onError(errorHandler(deps));

  app.notFound((c) =>
    c.json(
      {
        error: {
          code: 'not_found',
          message: `No route matches ${c.req.method} ${c.req.path}.`,
          traceId: c.get('traceId') ?? 'unknown',
          retryable: false,
        },
      },
      404,
    ),
  );

  return { app, deps };
}
