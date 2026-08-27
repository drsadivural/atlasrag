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
  // Every interface by default, because a container has to be reachable from outside it.
  // A deployment that fronts the API with a proxy or a tunnel should narrow this to
  // 127.0.0.1 so the only way in is through the front door.
  API_HOST: z.string().min(1).default('0.0.0.0'),
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
  // Leave unset to let it follow the mail driver — see `requiresEmailVerification`.
  REQUIRE_EMAIL_VERIFICATION: z.enum(['true', 'false']).optional(),
  EMAIL_FROM: z.string().default('UXE Consulting AI <no-reply@example.com>'),
  RESEND_API_KEY: z.string().default(''),

  /* --- Government Edition ------------------------------------------------ */
  /**
   * UAE PASS. Every field is required together: a half-configured provider is worse than
   * an absent one, because the button would render and then fail at the redirect.
   */
  UAE_PASS_ENVIRONMENT: z.enum(['staging', 'production']).default('staging'),
  UAE_PASS_ISSUER: z.string().default(''),
  UAE_PASS_AUTHORIZATION_ENDPOINT: z.string().default(''),
  UAE_PASS_TOKEN_ENDPOINT: z.string().default(''),
  UAE_PASS_USERINFO_ENDPOINT: z.string().default(''),
  UAE_PASS_CLIENT_ID: z.string().default(''),
  /** Server-side only. Never reaches a browser bundle. */
  UAE_PASS_CLIENT_SECRET: z.string().default(''),
  UAE_PASS_SCOPES: z.string().default('openid profile email'),
  UAE_PASS_ACR_VALUES: z.string().default('urn:safelayer:tws:policies:authentication:level:low'),

  /** Government SSO. Uses the Microsoft OIDC adapter unless an issuer is given. */
  GOV_SSO_ISSUER: z.string().default(''),
  GOV_SSO_CLIENT_ID: z.string().default(''),
  GOV_SSO_CLIENT_SECRET: z.string().default(''),
  /** Comma separated. Empty means no tenant is accepted, which fails closed. */
  GOV_SSO_ALLOWED_TENANTS: z.string().default(''),

  /** Comma separated. Which address domains may sign in at all. */
  GOV_ALLOWED_EMAIL_DOMAINS: z.string().default('gov.ae'),
  /** Where an authenticated government user lands. */
  GOV_POST_LOGIN_ROUTE: z.string().default('/dashboard'),
  /**
   * Only claim data residency when the deployment actually satisfies it. Off by default,
   * because the honest default for an unverified deployment is to say less.
   */
  GOV_DATA_RESIDENCY_STATEMENT: z.enum(['true', 'false']).default('false'),

  GOV_URL_PRIVACY: z.string().default('/legal/privacy'),
  GOV_URL_SECURITY: z.string().default('/legal/security'),
  GOV_URL_ACCESSIBILITY: z.string().default('/legal/accessibility'),
  GOV_URL_SUPPORT: z.string().default('/support'),
  GOV_URL_STATUS: z.string().default(''),
  GOV_URL_INCIDENT: z.string().default(''),
  GOV_URL_UAE_PASS_HELP: z.string().default(''),
  GOV_URL_SSO_HELP: z.string().default(''),

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
  /*
   * Per signed-in user, not per IP, so a whole ministry behind one address is not one
   * budget. The number has to clear what an attentive person actually generates: the
   * knowledge list, a source detail, a consultation and a correction plan each poll every
   * two to two and a half seconds while work is outstanding, which is around 110 requests
   * a minute before they touch anything, and a page they navigate to costs another dozen.
   * 300 left a single tab close enough to the ceiling that a second one crossed it, and
   * what a user got for reading their own documents in two windows was "Too many
   * requests". 600 carries three busy tabs and still refuses anything trying to enumerate
   * a corpus.
   */
  RATE_LIMIT_API_PER_MINUTE: z.coerce.number().int().min(1).default(600),
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
  /*
   * The two public URLs have to describe the same deployment.
   *
   * PUBLIC_APP_URL is where every OAuth callback sends the browser back to. Left at its
   * local-development default on a deployment that is actually reachable at a public
   * address, nothing complains and nothing looks wrong — until somebody finishes a Google
   * consent screen and lands on "localhost refused to connect", holding an authorization
   * code that went nowhere.
   */
  const localApp = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(env.PUBLIC_APP_URL);
  const localApi = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(env.PUBLIC_API_URL);
  if (localApp && !localApi) {
    issues.push(
      `PUBLIC_APP_URL is ${env.PUBLIC_APP_URL} while PUBLIC_API_URL is ${env.PUBLIC_API_URL}. ` +
        'Every OAuth callback returns the browser to PUBLIC_APP_URL, so a local value here ' +
        'sends anyone completing a connector sign-in to a machine that is not theirs.',
    );
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

/**
 * Whether a new account must confirm its address before it can sign in.
 *
 * Unset, this follows the mail driver: the `console` driver writes the message to a log
 * instead of delivering it, so requiring confirmation there would leave every new account
 * waiting on an email that is never coming. A deployment that can actually send mail gets
 * the check; one that cannot does not gate people behind it.
 */
/** Domains whose addresses may sign in. Empty list means the check is off. */
export function allowedGovernmentDomains(env: AppEnv): string[] {
  return env.GOV_ALLOWED_EMAIL_DOMAINS.split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}

export interface UaePassConfig {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  acrValues: string;
  environment: 'staging' | 'production';
}

/**
 * The UAE PASS configuration, or null when this deployment has none.
 *
 * All-or-nothing on purpose: a partially set provider would render an enabled button that
 * fails at the redirect, which is worse for the person pressing it than a disabled one
 * with a message naming what an administrator has to supply.
 */
export function uaePassConfig(env: AppEnv): UaePassConfig | null {
  const required = [
    env.UAE_PASS_ISSUER,
    env.UAE_PASS_AUTHORIZATION_ENDPOINT,
    env.UAE_PASS_TOKEN_ENDPOINT,
    env.UAE_PASS_USERINFO_ENDPOINT,
    env.UAE_PASS_CLIENT_ID,
    env.UAE_PASS_CLIENT_SECRET,
  ];
  if (required.some((value) => !value)) return null;

  return {
    issuer: env.UAE_PASS_ISSUER,
    authorizationEndpoint: env.UAE_PASS_AUTHORIZATION_ENDPOINT,
    tokenEndpoint: env.UAE_PASS_TOKEN_ENDPOINT,
    userinfoEndpoint: env.UAE_PASS_USERINFO_ENDPOINT,
    clientId: env.UAE_PASS_CLIENT_ID,
    clientSecret: env.UAE_PASS_CLIENT_SECRET,
    scopes: env.UAE_PASS_SCOPES,
    acrValues: env.UAE_PASS_ACR_VALUES,
    environment: env.UAE_PASS_ENVIRONMENT,
  };
}

/** Tenants Government SSO accepts. Empty means none, which fails closed. */
export function allowedSsoTenants(env: AppEnv): string[] {
  return env.GOV_SSO_ALLOWED_TENANTS.split(',')
    .map((tenant) => tenant.trim())
    .filter(Boolean);
}

export function requiresEmailVerification(env: AppEnv): boolean {
  if (env.REQUIRE_EMAIL_VERIFICATION !== undefined) {
    return env.REQUIRE_EMAIL_VERIFICATION === 'true';
  }
  return env.EMAIL_DRIVER !== 'console';
}
