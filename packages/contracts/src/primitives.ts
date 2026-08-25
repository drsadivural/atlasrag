import { z } from 'zod';

/**
 * Identifiers are ULID-shaped (Crockford base32, 26 chars, lexicographically sortable).
 * They are non-enumerable, which matters because IDs appear in URLs the browser can see.
 */
export const ULID_REGEX = /^[0-7][0-9ABCDEFGHJKMNPQRSTVWXYZ]{25}$/;
export const Id = z.string().regex(ULID_REGEX, 'must be a ULID');
export type Id = z.infer<typeof Id>;

export const Sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'must be a lowercase sha-256 hex digest');

/** All timestamps crossing the wire are ISO-8601 in UTC. */
export const Timestamp = z.iso.datetime({ offset: true });

export const Email = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(320)
  .refine((v) => /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(v), 'must be a valid email address');

/**
 * Passwords are checked for length and composition here so the browser can show the
 * same message the server enforces. Breach-list checks happen server-side only.
 */
export const Password = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(256, 'Use at most 256 characters')
  .refine((v) => /[a-z]/.test(v), 'Add a lowercase letter')
  .refine((v) => /[A-Z]/.test(v), 'Add an uppercase letter')
  .refine((v) => /[0-9]/.test(v), 'Add a number');

export const Slug = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'lowercase letters, numbers and hyphens only');

export const Locale = z.enum(['en', 'ja']);
export type Locale = z.infer<typeof Locale>;

export const ThemePreference = z.enum(['light', 'dark', 'system']);
export type ThemePreference = z.infer<typeof ThemePreference>;

/** Roles are ordered from most to least privileged; `rankOfRole` relies on this order. */
export const Role = z.enum([
  'owner',
  'admin',
  'consultant',
  'knowledge_manager',
  'reviewer',
  'member',
  'read_only',
]);
export type Role = z.infer<typeof Role>;

export const ROLE_ORDER: readonly Role[] = [
  'owner',
  'admin',
  'consultant',
  'knowledge_manager',
  'reviewer',
  'member',
  'read_only',
] as const;

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  consultant: 'Consultant',
  knowledge_manager: 'Knowledge Manager',
  reviewer: 'Reviewer',
  member: 'Member',
  read_only: 'Read Only',
};

export const DocumentType = z.enum([
  'pdf',
  'docx',
  'xlsx',
  'pptx',
  'csv',
  'html',
  'image',
  'text',
  'markdown',
  'archive',
  'unknown',
]);
export type DocumentType = z.infer<typeof DocumentType>;

export const SourceStatus = z.enum([
  'pending',
  'scanning',
  'extracting',
  'indexing',
  'validating',
  'ready',
  'needs_review',
  'failed',
  'archived',
  'quarantined',
]);
export type SourceStatus = z.infer<typeof SourceStatus>;

export const JobStatus = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'dead_letter',
]);
export type JobStatus = z.infer<typeof JobStatus>;

export const JobKind = z.enum([
  'source_ingest',
  'source_reprocess',
  'source_sync',
  'consultation_answer',
  'compliance_review',
  'report_generate',
  'correction_plan',
  'correction_generate',
  'retention_purge',
]);
export type JobKind = z.infer<typeof JobKind>;

/** Pagination is cursor-free on purpose: the tables are tenant-scoped and bounded. */
export const PageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type PageQuery = z.infer<typeof PageQuery>;

export const paginated = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.number().int().min(0),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
    totalPages: z.number().int().min(0),
  });

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * Every API failure uses this envelope. `traceId` is surfaced in the UI so a user can
 * quote it in a support request, and `retryable` drives whether a Retry button appears.
 */
export const ApiErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
    traceId: z.string(),
    retryable: z.boolean().default(false),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

export const ERROR_CODES = [
  'validation_failed',
  'unauthenticated',
  'session_expired',
  'mfa_required',
  'email_unverified',
  'forbidden',
  /** Distinct from `forbidden`: the client should refresh the session token and retry. */
  'csrf_failed',
  'not_found',
  'conflict',
  'version_conflict',
  'rate_limited',
  'payload_too_large',
  'unsupported_media_type',
  'idempotency_conflict',
  'provider_unavailable',
  'provider_unconfigured',
  'quarantined_content',
  'insufficient_evidence',
  'internal_error',
  'dependency_unavailable',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
