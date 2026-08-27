import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, deletedAt, id, rowVersion, updatedAt } from './columns.js';
import { users, workspaces } from './tenancy.js';

export const processingJobs = pgTable(
  'processing_jobs',
  {
    id: id(),
    organizationId: text('organization_id').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('queued'),
    /**
     * Two requests with the same key produce one job. This is what stops a double-click
     * or a network retry from generating a second corrected document.
     */
    idempotencyKey: text('idempotency_key').notNull(),
    /** Correlates every log line, span and audit event produced by this job. */
    traceId: text('trace_id').notNull(),
    priority: integer('priority').notNull().default(0),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    stages: jsonb('stages')
      .$type<
        Array<{
          key: string;
          label: string;
          state: string;
          detail: string | null;
          percent: number | null;
        }>
      >()
      .notNull()
      .default([]),
    percent: real('percent').notNull().default(0),
    attempt: integer('attempt').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    /** Set when the job is retryable and waiting for its backoff window to elapse. */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'date' }),
    error: jsonb('error').$type<Record<string, unknown> | null>(),
    /** Where the successful output landed, so a retry can detect existing work. */
    resultRef: jsonb('result_ref').$type<{ kind: string; id: string } | null>(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    version: rowVersion(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('processing_jobs_idem_key').on(t.workspaceId, t.kind, t.idempotencyKey),
    index('processing_jobs_queue_idx').on(t.status, t.nextAttemptAt, t.priority),
    index('processing_jobs_tenant_idx').on(t.workspaceId, t.status),
    index('processing_jobs_target_idx').on(t.targetType, t.targetId),
  ],
);

export const jobAttempts = pgTable(
  'job_attempts',
  {
    id: id(),
    jobId: text('job_id')
      .notNull()
      .references(() => processingJobs.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').notNull(),
    attempt: integer('attempt').notNull(),
    status: text('status').notNull(),
    stage: text('stage'),
    message: text('message'),
    error: jsonb('error').$type<Record<string, unknown> | null>(),
    durationMs: integer('duration_ms'),
    /** Retrieval config, model descriptor, token and cost metrics — kept for audit. */
    metrics: jsonb('metrics').$type<Record<string, unknown>>().notNull().default({}),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('job_attempts_key').on(t.jobId, t.attempt),
    index('job_attempts_job_idx').on(t.jobId),
  ],
);

export const modelConfigurations = pgTable(
  'model_configurations',
  {
    id: id(),
    organizationId: text('organization_id').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    capability: text('capability').notNull(), // chat | embedding | ocr | rerank | document_generation
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    /** none | low | medium | high | xhigh, or null for a model with no reasoning mode. */
    reasoningEffort: text('reasoning_effort'),
    isPrimary: boolean('is_primary').notNull().default(true),
    isFallback: boolean('is_fallback').notNull().default(false),
    enabled: boolean('enabled').notNull().default(true),
    /** AES-256-GCM ciphertext. There is no API path that reads this back out. */
    credentialEncrypted: text('credential_encrypted'),
    /** Last four characters only — enough to recognise a key, useless to anyone else. */
    credentialLast4: text('credential_last4'),
    health: text('health').notNull().default('unknown'),
    healthDetail: text('health_detail'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true, mode: 'date' }),
    /** Circuit breaker: while set, this provider is skipped and the fallback is used. */
    circuitOpenUntil: timestamp('circuit_open_until', { withTimezone: true, mode: 'date' }),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    tokensUsed30d: integer('tokens_used_30d').notNull().default(0),
    requestsUsed30d: integer('requests_used_30d').notNull().default(0),
    quotaLimit: integer('quota_limit'),
    version: rowVersion(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('model_configurations_key').on(t.workspaceId, t.capability, t.provider, t.model),
    index('model_configurations_tenant_idx').on(t.workspaceId, t.capability, t.isPrimary),
  ],
);

/**
 * Append-only. There is no UPDATE or DELETE path in the repository layer, and the
 * migration revokes those rights from the application role.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: id(),
    organizationId: text('organization_id').notNull(),
    workspaceId: text('workspace_id'),
    actorUserId: text('actor_user_id'),
    actorName: text('actor_name').notNull().default('system'),
    actorType: text('actor_type').notNull().default('user'),
    action: text('action').notNull(),
    category: text('category').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    targetLabel: text('target_label'),
    result: text('result').notNull().default('success'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    traceId: text('trace_id').notNull(),
    summary: text('summary').notNull(),
    /** Redacted diffs only — never raw secrets or full document content. */
    before: jsonb('before').$type<Record<string, unknown> | null>(),
    after: jsonb('after').$type<Record<string, unknown> | null>(),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_events_tenant_idx').on(t.organizationId, t.createdAt),
    index('audit_events_workspace_idx').on(t.workspaceId, t.category, t.createdAt),
    index('audit_events_actor_idx').on(t.actorUserId, t.createdAt),
    index('audit_events_target_idx').on(t.targetType, t.targetId),
  ],
);

export const retentionPolicies = pgTable(
  'retention_policies',
  {
    id: id(),
    organizationId: text('organization_id').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    consultationDays: integer('consultation_days').notNull().default(365),
    artifactDays: integer('artifact_days').notNull().default(365),
    auditDays: integer('audit_days').notNull().default(730),
    purgeGraceDays: integer('purge_grace_days').notNull().default(30),
    /** While true, nothing in this workspace is purged regardless of age. */
    legalHold: boolean('legal_hold').notNull().default(false),
    lastPurgeAt: timestamp('last_purge_at', { withTimezone: true, mode: 'date' }),
    version: rowVersion(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('retention_policies_workspace_key').on(t.workspaceId)],
);

export const deletionRequests = pgTable(
  'deletion_requests',
  {
    id: id(),
    organizationId: text('organization_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    requestedByUserId: text('requested_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    targetType: text('target_type').notNull(), // source | consultation | artifact | user | workspace
    targetId: text('target_id').notNull(),
    reason: text('reason'),
    status: text('status').notNull().default('pending'), // pending | scheduled | completed | cancelled
    scheduledFor: timestamp('scheduled_for', { withTimezone: true, mode: 'date' }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    /** Counts of rows and storage objects actually removed — the proof-of-completion event. */
    proof: jsonb('proof').$type<Record<string, unknown> | null>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('deletion_requests_tenant_idx').on(t.workspaceId, t.status),
    index('deletion_requests_schedule_idx').on(t.status, t.scheduledFor),
  ],
);

/**
 * Records the exact response returned for an idempotency key so a repeat request can be
 * answered identically without re-executing the mutation.
 */
export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull(),
    userId: text('user_id').notNull(),
    endpoint: text('endpoint').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    /** Hash of the request body: the same key with a different body is a 409, not a replay. */
    requestHash: text('request_hash').notNull(),
    statusCode: integer('status_code').notNull(),
    responseBody: jsonb('response_body').$type<Record<string, unknown>>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('idempotency_records_key').on(t.workspaceId, t.endpoint, t.idempotencyKey),
    index('idempotency_records_expiry_idx').on(t.expiresAt),
  ],
);

/** Durable rate-limit counters. Workers KV fronts this in production; the table is the source of truth. */
export const rateLimitCounters = pgTable(
  'rate_limit_counters',
  {
    id: id(),
    bucket: text('bucket').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true, mode: 'date' }).notNull(),
    count: integer('count').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => [
    uniqueIndex('rate_limit_counters_key').on(t.bucket, t.windowStart),
    index('rate_limit_counters_expiry_idx').on(t.expiresAt),
  ],
);

export const uploadTickets = pgTable(
  'upload_tickets',
  {
    id: id(),
    organizationId: text('organization_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    userId: text('user_id').notNull(),
    consultationId: text('consultation_id'),
    sourceId: text('source_id').notNull(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    declaredBytes: integer('declared_bytes').notNull(),
    storageKey: text('storage_key').notNull(),
    /** Consultation uploads default to false and require an explicit promote action. */
    promoteToKnowledge: boolean('promote_to_knowledge').notNull().default(false),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    accessScope: text('access_scope').notNull().default('workspace'),
    receivedBytes: integer('received_bytes').notNull().default(0),
    status: text('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('upload_tickets_tenant_idx').on(t.workspaceId, t.status),
    index('upload_tickets_source_idx').on(t.sourceId),
  ],
);
