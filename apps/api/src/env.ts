import { z } from 'zod';

/**
 * Configuration is read once, validated, and then passed explicitly.
 *
 * Nothing downstream touches `process.env`, which is what lets the identical app object
 * run on Cloudflare Workers (where the bindings arrive as an `Env` argument) and on Node.
 */
const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
  );

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  PUBLIC_APP_URL: z.url().default('http://localhost:5173'),
  PUBLIC_API_URL: z.url().default('http://localhost:8787'),
  CORS_ALLOWED_ORIGINS: z.string().default('http://localhost:5173'),

  DATABASE_URL: z.string().min(1),
  DATABASE_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(100).default(10),

  SESSION_SECRET: z.string().min(32),
  CSRF_SECRET: z.string().min(32),
  ENCRYPTION_KEY: z.string().min(43),

  STORAGE_DRIVER: z.enum(['filesystem', 's3']).default('filesystem'),
  STORAGE_LOCAL_PATH: z.string().default('./.data/storage'),
  S3_ENDPOINT: z.string().default(''),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET_ORIGINALS: z.string().default('uxe-originals'),
  S3_BUCKET_ARTIFACTS: z.string().default('uxe-artifacts'),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(86400).default(300),

  DOCUMENT_WORKER_URL: z.string().default('http://127.0.0.1:8099'),
  DOCUMENT_WORKER_TOKEN: z.string().default(''),
  DOCUMENT_WORKER_TIMEOUT_MS: z.coerce.number().int().min(1000).default(180_000),

  MODEL_PROVIDER: z.enum(['deterministic', 'anthropic', 'openai']).default('deterministic'),
  ANTHROPIC_API_KEY: z.string().default(''),
  ANTHROPIC_CHAT_MODEL: z.string().default('claude-sonnet-5'),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_CHAT_MODEL: z.string().default('gpt-4.1'),
  OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  EMBEDDING_PROVIDER: z.enum(['deterministic', 'openai']).default('deterministic'),

  EMAIL_DRIVER: z.enum(['console', 'resend', 'smtp']).default('console'),
  EMAIL_FROM: z.string().default('UXE Consulting AI <no-reply@example.com>'),
  RESEND_API_KEY: z.string().default(''),

  GOOGLE_OAUTH_CLIENT_ID: z.string().default(''),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().default(''),
  MICROSOFT_OAUTH_CLIENT_ID: z.string().default(''),
  MICROSOFT_OAUTH_CLIENT_SECRET: z.string().default(''),
  MICROSOFT_OAUTH_TENANT: z.string().default('common'),

  MAX_UPLOAD_BYTES: z.coerce.number().int().min(1).default(524_288_000),
  MAX_ARCHIVE_ENTRIES: z.coerce.number().int().min(1).default(2000),
  MAX_ARCHIVE_EXPANDED_BYTES: z.coerce.number().int().min(1).default(2_147_483_648),
  MAX_ARCHIVE_COMPRESSION_RATIO: z.coerce.number().int().min(1).default(120),
  MAX_DOCUMENT_PAGES: z.coerce.number().int().min(1).default(5000),
  URL_INGEST_ALLOWED_SCHEMES: z.string().default('https'),
  URL_INGEST_BLOCK_PRIVATE_NETWORKS: boolish.default(true),
  CRAWL_MAX_PAGES: z.coerce.number().int().min(1).default(200),
  CRAWL_MAX_DEPTH: z.coerce.number().int().min(0).default(3),

  RATE_LIMIT_DRIVER: z.enum(['memory', 'kv']).default('memory'),
  RATE_LIMIT_LOGIN_PER_15M: z.coerce.number().int().min(1).default(10),
  RATE_LIMIT_API_PER_MINUTE: z.coerce.number().int().min(1).default(300),
  RATE_LIMIT_UPLOAD_PER_HOUR: z.coerce.number().int().min(1).default(200),
  RATE_LIMIT_CONSULT_PER_HOUR: z.coerce.number().int().min(1).default(120),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(''),
  OTEL_SERVICE_NAME: z.string().default('uxe-api'),
  TRACE_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(1),
  LOG_DOCUMENT_CONTENT: boolish.default(false),

  DEFAULT_RETENTION_DAYS: z.coerce.number().int().min(1).default(365),
  PURGE_GRACE_PERIOD_DAYS: z.coerce.number().int().min(0).default(30),
});

export type AppEnv = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Validates raw configuration. Fails loudly at startup rather than at the first request,
 * because a missing ENCRYPTION_KEY discovered mid-flight would leave provider credentials
 * unreadable and jobs stuck.
 */
export function loadEnv(raw: Record<string, string | undefined>): AppEnv {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }

  const env = parsed.data;

  // Cross-field rules the schema cannot express on its own.
  const issues: string[] = [];
  if (env.APP_ENV === 'production') {
    if (env.STORAGE_DRIVER === 'filesystem') {
      issues.push('STORAGE_DRIVER=filesystem is not permitted in production; use s3/R2.');
    }
    if (!env.PUBLIC_APP_URL.startsWith('https://')) {
      issues.push('PUBLIC_APP_URL must use https in production.');
    }
    if (env.SESSION_SECRET === env.CSRF_SECRET) {
      issues.push('SESSION_SECRET and CSRF_SECRET must be different values.');
    }
    if (env.LOG_DOCUMENT_CONTENT) {
      issues.push('LOG_DOCUMENT_CONTENT must be false in production.');
    }
  }
  if (env.STORAGE_DRIVER === 's3' && (!env.S3_ENDPOINT || !env.S3_ACCESS_KEY_ID)) {
    issues.push('STORAGE_DRIVER=s3 requires S3_ENDPOINT and S3_ACCESS_KEY_ID.');
  }
  if (env.MODEL_PROVIDER === 'anthropic' && !env.ANTHROPIC_API_KEY) {
    issues.push('MODEL_PROVIDER=anthropic requires ANTHROPIC_API_KEY.');
  }
  if (env.MODEL_PROVIDER === 'openai' && !env.OPENAI_API_KEY) {
    issues.push('MODEL_PROVIDER=openai requires OPENAI_API_KEY.');
  }
  if (env.EMBEDDING_PROVIDER === 'openai' && !env.OPENAI_API_KEY) {
    issues.push('EMBEDDING_PROVIDER=openai requires OPENAI_API_KEY.');
  }
  if (env.EMAIL_DRIVER === 'resend' && !env.RESEND_API_KEY) {
    issues.push('EMAIL_DRIVER=resend requires RESEND_API_KEY.');
  }

  try {
    const decoded = atob(env.ENCRYPTION_KEY);
    if (decoded.length !== 32) issues.push('ENCRYPTION_KEY must decode to exactly 32 bytes.');
  } catch {
    issues.push('ENCRYPTION_KEY must be valid base64.');
  }

  if (issues.length > 0) throw new ConfigError(issues);
  return env;
}

export function corsOrigins(env: AppEnv): string[] {
  return env.CORS_ALLOWED_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

export function isProduction(env: AppEnv): boolean {
  return env.APP_ENV === 'production';
}
