import type { AppEnv } from './env.js';
import type {
  ArtifactRepository,
  AuditRepository,
  ConsultationRepository,
  CorrectionRepository,
  Database,
  IdempotencyRepository,
  IdentityRepository,
  JobRepository,
  RetrievalRepository,
  SettingsRepository,
  SourceRepository,
  TenantContext,
} from '@uxe/db';
import type { Logger, MetricsRegistry, Tracer } from '@uxe/observability';
import type { ChatProvider, EmbeddingProvider } from '@uxe/rag';
import type { StorageDriver } from './services/storage.js';
import type { EmailDriver } from './services/email.js';
import type { DocumentWorkerClient } from './services/document-worker.js';
import type { RateLimiter } from './services/rate-limit.js';

export interface Repositories {
  identity: IdentityRepository;
  sources: SourceRepository;
  consultations: ConsultationRepository;
  retrieval: RetrievalRepository;
  jobs: JobRepository;
  artifacts: ArtifactRepository;
  corrections: CorrectionRepository;
  audit: AuditRepository;
  settings: SettingsRepository;
  idempotency: IdempotencyRepository;
}

export interface Services {
  storage: StorageDriver;
  email: EmailDriver;
  documentWorker: DocumentWorkerClient;
  rateLimiter: RateLimiter;
  embeddings: EmbeddingProvider;
  chat: ChatProvider;
}

export interface AppDeps {
  env: AppEnv;
  db: Database;
  repos: Repositories;
  services: Services;
  logger: Logger;
  tracer: Tracer;
  metrics: MetricsRegistry;
}

/** The authenticated caller, resolved once per request by the session middleware. */
export interface RequestSession {
  sessionId: string;
  userId: string;
  csrfSecret: string;
  mfaSatisfied: boolean;
  user: {
    id: string;
    email: string;
    fullName: string;
    avatarUrl: string | null;
    title: string | null;
    locale: string;
    theme: string;
    emailVerified: boolean;
    createdAt: Date;
  };
}

/** Hono variable map. `tenant` is only present once a workspace has been resolved. */
export interface AppVariables {
  traceId: string;
  spanId: string;
  requestStart: number;
  session?: RequestSession;
  tenant?: TenantContext;
  logger: Logger;
}

export interface AppBindings {
  Variables: AppVariables;
}
