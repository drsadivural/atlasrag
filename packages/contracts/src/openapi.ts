import { z } from 'zod';
import * as A from './api.js';
import * as E from './evidence.js';
import { ApiErrorBody } from './primitives.js';

type JsonSchema = Record<string, unknown>;

interface OperationSpec {
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  operationId: string;
  summary: string;
  tag: string;
  /** Permission required by the server; documented so integrators can predict a 403. */
  permission?: string;
  request?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  response?: z.ZodTypeAny;
  status?: number;
  /** Mutations that create work or artifacts require an Idempotency-Key header. */
  idempotent?: boolean;
  public?: boolean;
}

const OPERATIONS: OperationSpec[] = [
  // --- auth ---------------------------------------------------------------
  { method: 'post', path: '/api/v1/auth/register', operationId: 'authRegister', summary: 'Create an account and its first organization/workspace', tag: 'auth', request: A.RegisterRequest, response: A.LoginResponse, public: true },
  { method: 'post', path: '/api/v1/auth/login', operationId: 'authLogin', summary: 'Sign in with email and password', tag: 'auth', request: A.LoginRequest, response: A.LoginResponse, public: true },
  { method: 'post', path: '/api/v1/auth/logout', operationId: 'authLogout', summary: 'Revoke the current session', tag: 'auth', response: z.object({ ok: z.literal(true) }) },
  { method: 'get', path: '/api/v1/auth/session', operationId: 'authSession', summary: 'Return the current session, workspace and permission set', tag: 'auth', response: A.SessionResponse },
  { method: 'post', path: '/api/v1/auth/mfa/verify', operationId: 'authMfaVerify', summary: 'Complete an MFA challenge', tag: 'auth', request: A.MfaVerifyRequest, response: A.SessionResponse, public: true },
  { method: 'post', path: '/api/v1/auth/mfa/enroll', operationId: 'authMfaEnroll', summary: 'Start TOTP enrolment', tag: 'auth', response: z.object({ secret: z.string(), otpauthUrl: z.string(), factorId: z.string() }) },
  { method: 'post', path: '/api/v1/auth/mfa/activate', operationId: 'authMfaActivate', summary: 'Activate TOTP after verifying a code', tag: 'auth', request: z.object({ factorId: z.string(), code: z.string() }), response: z.object({ ok: z.literal(true), recoveryCodes: z.array(z.string()) }) },
  { method: 'post', path: '/api/v1/auth/forgot-password', operationId: 'authForgotPassword', summary: 'Send a password reset link', tag: 'auth', request: A.ForgotPasswordRequest, response: z.object({ ok: z.literal(true) }), public: true },
  { method: 'post', path: '/api/v1/auth/reset-password', operationId: 'authResetPassword', summary: 'Set a new password using a reset token', tag: 'auth', request: A.ResetPasswordRequest, response: z.object({ ok: z.literal(true) }), public: true },
  { method: 'post', path: '/api/v1/auth/verify-email', operationId: 'authVerifyEmail', summary: 'Confirm an email address', tag: 'auth', request: A.VerifyEmailRequest, response: z.object({ ok: z.literal(true) }), public: true },
  { method: 'post', path: '/api/v1/auth/magic-link', operationId: 'authMagicLink', summary: 'Send a one-time sign-in link', tag: 'auth', request: A.MagicLinkRequest, response: z.object({ ok: z.literal(true) }), public: true },
  { method: 'get', path: '/api/v1/auth/sessions', operationId: 'authListSessions', summary: 'List active device sessions', tag: 'auth', response: z.array(A.DeviceSession) },
  { method: 'delete', path: '/api/v1/auth/sessions/{id}', operationId: 'authRevokeSession', summary: 'Revoke one device session', tag: 'auth', response: z.object({ ok: z.literal(true) }) },

  // --- dashboard ----------------------------------------------------------
  { method: 'get', path: '/api/v1/dashboard', operationId: 'getDashboard', summary: 'Dashboard KPIs, activity, outcomes and attention items', tag: 'dashboard', permission: 'workspace:read', query: A.DashboardQuery, response: A.DashboardResponse },

  // --- consultations ------------------------------------------------------
  { method: 'get', path: '/api/v1/consultations', operationId: 'listConsultations', summary: 'List consultations visible to the caller', tag: 'consultations', permission: 'consultation:read', query: A.ConsultationsQuery },
  { method: 'post', path: '/api/v1/consultations', operationId: 'createConsultation', summary: 'Start a consultation', tag: 'consultations', permission: 'consultation:create', request: A.CreateConsultationRequest, response: A.ConsultationDetail, status: 201 },
  { method: 'get', path: '/api/v1/consultations/{id}', operationId: 'getConsultation', summary: 'Full consultation with messages, sources and evidence', tag: 'consultations', permission: 'consultation:read', response: A.ConsultationDetail },
  { method: 'patch', path: '/api/v1/consultations/{id}', operationId: 'updateConsultation', summary: 'Rename, re-scope or change answer settings', tag: 'consultations', permission: 'consultation:update', request: A.UpdateConsultationRequest, response: A.ConsultationDetail },
  { method: 'delete', path: '/api/v1/consultations/{id}', operationId: 'deleteConsultation', summary: 'Soft-delete a consultation', tag: 'consultations', permission: 'consultation:delete', response: z.object({ ok: z.literal(true) }) },
  { method: 'post', path: '/api/v1/consultations/{id}/messages', operationId: 'postMessage', summary: 'Ask a question and queue a grounded answer', tag: 'consultations', permission: 'consultation:update', request: A.PostMessageRequest, response: z.object({ message: A.ConsultationMessage, job: A.JobView }), status: 202, idempotent: true },
  { method: 'post', path: '/api/v1/consultations/{id}/cancel', operationId: 'cancelConsultationWork', summary: 'Cancel in-flight generation', tag: 'consultations', permission: 'consultation:update', response: z.object({ ok: z.literal(true), cancelled: z.number().int() }) },
  { method: 'post', path: '/api/v1/consultations/{id}/uploads', operationId: 'createConsultationUpload', summary: 'Attach customer documents as consultation inputs', tag: 'consultations', permission: 'consultation:update', request: A.CreateUploadRequest, response: z.object({ tickets: z.array(A.UploadTicket) }), status: 201 },
  { method: 'post', path: '/api/v1/consultations/{id}/reviews', operationId: 'createReview', summary: 'Run a requirement-by-requirement compliance review', tag: 'consultations', permission: 'review:create', request: A.CreateReviewRequest, response: z.object({ job: A.JobView }), status: 202, idempotent: true },
  { method: 'post', path: '/api/v1/consultations/{id}/reports', operationId: 'createReport', summary: 'Generate an evidence-backed report artifact', tag: 'consultations', permission: 'report:create', request: A.CreateReportRequest, response: z.object({ job: A.JobView }), status: 202, idempotent: true },
  { method: 'post', path: '/api/v1/consultations/{id}/corrections', operationId: 'createCorrection', summary: 'Build a reviewable correction plan', tag: 'consultations', permission: 'correction:create', request: A.CreateCorrectionRequest, response: z.object({ job: A.JobView }), status: 202, idempotent: true },
  { method: 'get', path: '/api/v1/consultations/{id}/stream', operationId: 'streamConsultation', summary: 'Server-sent events for answers and job progress', tag: 'consultations', permission: 'consultation:read', response: A.StreamEvent },
  { method: 'patch', path: '/api/v1/corrections/{planId}', operationId: 'decideCorrection', summary: 'Accept, reject or edit individual proposed changes', tag: 'corrections', permission: 'correction:decide', request: A.DecideCorrectionRequest, response: A.CorrectionPlan },
  { method: 'post', path: '/api/v1/corrections/{planId}/generate', operationId: 'generateCorrection', summary: 'Produce the corrected edition from accepted changes only', tag: 'corrections', permission: 'correction:generate', request: A.GenerateCorrectionRequest, response: z.object({ job: A.JobView }), status: 202, idempotent: true },
  { method: 'get', path: '/api/v1/corrections/{planId}', operationId: 'getCorrection', summary: 'Correction plan with side-by-side diff', tag: 'corrections', permission: 'correction:create', response: A.CorrectionPlan },

  // --- jobs ---------------------------------------------------------------
  { method: 'get', path: '/api/v1/jobs/{id}', operationId: 'getJob', summary: 'Job status, stages and failure reason', tag: 'jobs', response: A.JobView },
  { method: 'post', path: '/api/v1/jobs/{id}/retry', operationId: 'retryJob', summary: 'Retry a failed job without duplicating artifacts', tag: 'jobs', response: A.JobView, idempotent: true },

  // --- sources ------------------------------------------------------------
  { method: 'get', path: '/api/v1/sources', operationId: 'listSources', summary: 'Knowledge base sources the caller may see', tag: 'sources', permission: 'source:read', query: A.SourcesQuery, response: A.SourcesResponse },
  { method: 'post', path: '/api/v1/sources/uploads', operationId: 'createSourceUpload', summary: 'Request resumable upload tickets', tag: 'sources', permission: 'source:create', request: A.CreateUploadRequest, response: z.object({ tickets: z.array(A.UploadTicket) }), status: 201 },
  { method: 'post', path: '/api/v1/sources/connectors', operationId: 'createConnector', summary: 'Connect Drive/OneDrive/SharePoint/URL or paste text', tag: 'sources', permission: 'source:create', request: A.CreateConnectorRequest, response: z.object({ sourceId: z.string(), job: A.JobView }), status: 202, idempotent: true },
  { method: 'get', path: '/api/v1/sources/{id}', operationId: 'getSource', summary: 'Source detail, versions, permissions and processing log', tag: 'sources', permission: 'source:read', response: A.SourceDetail },
  { method: 'patch', path: '/api/v1/sources/{id}', operationId: 'updateSource', summary: 'Rename, retag, re-scope or archive a source', tag: 'sources', permission: 'source:update', request: A.UpdateSourceRequest, response: A.SourceDetail },
  { method: 'post', path: '/api/v1/sources/{id}/reprocess', operationId: 'reprocessSource', summary: 'Re-run extraction and indexing', tag: 'sources', permission: 'source:reprocess', response: z.object({ job: A.JobView }), status: 202, idempotent: true },
  { method: 'post', path: '/api/v1/sources/{id}/sync', operationId: 'syncSource', summary: 'Pull the latest connector content', tag: 'sources', permission: 'source:reprocess', response: z.object({ job: A.JobView }), status: 202, idempotent: true },
  { method: 'get', path: '/api/v1/sources/{id}/versions', operationId: 'listSourceVersions', summary: 'Immutable version lineage', tag: 'sources', permission: 'source:read', response: z.array(A.SourceVersionSummary) },
  { method: 'post', path: '/api/v1/sources/bulk', operationId: 'bulkSourceAction', summary: 'Tag, re-scope, reprocess, archive, export or delete in bulk', tag: 'sources', permission: 'source:update', request: A.BulkSourceActionRequest, response: z.object({ affected: z.number().int() }) },

  // --- citations & artifacts ---------------------------------------------
  { method: 'get', path: '/api/v1/citations/{id}', operationId: 'resolveCitation', summary: 'Open a citation at its exact location with highlight offsets', tag: 'citations', permission: 'source:read', response: A.CitationResolution },
  { method: 'get', path: '/api/v1/artifacts', operationId: 'listArtifacts', summary: 'Report and corrected-document library', tag: 'artifacts', permission: 'artifact:read', query: A.ReportsQuery },
  { method: 'get', path: '/api/v1/artifacts/{id}/download', operationId: 'downloadArtifact', summary: 'Short-lived signed download for an artifact', tag: 'artifacts', permission: 'artifact:download', response: z.object({ url: z.string(), expiresAt: z.string(), fileName: z.string() }) },

  // --- audit, users, settings --------------------------------------------
  { method: 'get', path: '/api/v1/audit-events', operationId: 'listAuditEvents', summary: 'Immutable audit log', tag: 'audit', permission: 'audit:read', query: A.AuditQuery },
  { method: 'get', path: '/api/v1/users', operationId: 'listUsers', summary: 'Workspace members and their access', tag: 'users', permission: 'member:read', response: z.array(A.WorkspaceUser) },
  { method: 'post', path: '/api/v1/users/invite', operationId: 'inviteUser', summary: 'Invite a member', tag: 'users', permission: 'member:invite', request: A.InviteUserRequest, response: A.WorkspaceUser, status: 201 },
  { method: 'patch', path: '/api/v1/users/{id}', operationId: 'updateUser', summary: 'Change role, suspend, or revoke sessions', tag: 'users', permission: 'member:update', request: A.UpdateUserRequest, response: A.WorkspaceUser },
  { method: 'get', path: '/api/v1/settings', operationId: 'getSettings', summary: 'Workspace settings and model configuration', tag: 'settings', permission: 'settings:read', response: z.object({ settings: A.WorkspaceSettings, models: z.array(A.ModelConfiguration) }) },
  { method: 'patch', path: '/api/v1/settings', operationId: 'updateSettings', summary: 'Update workspace settings', tag: 'settings', permission: 'settings:update', request: A.UpdateSettingsRequest, response: A.WorkspaceSettings },
  { method: 'post', path: '/api/v1/settings/models', operationId: 'upsertModelConfig', summary: 'Configure a provider for a capability', tag: 'settings', permission: 'settings:models', request: A.UpsertModelConfigRequest, response: A.ModelConfiguration },
  { method: 'post', path: '/api/v1/settings/models/{id}/test', operationId: 'testModelConfig', summary: 'Verify provider credentials and report health', tag: 'settings', permission: 'settings:models', response: A.ModelConfiguration },

  // --- health -------------------------------------------------------------
  { method: 'get', path: '/api/v1/health', operationId: 'health', summary: 'Liveness', tag: 'system', response: A.HealthResponse, public: true },
  { method: 'get', path: '/api/v1/ready', operationId: 'ready', summary: 'Readiness including database and document worker', tag: 'system', response: A.HealthResponse, public: true },
];

function toSchema(schema: z.ZodTypeAny): JsonSchema {
  return z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }) as JsonSchema;
}

function pathParams(path: string) {
  return [...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({
    name,
    in: 'path' as const,
    required: true,
    schema: { type: 'string' },
    description: 'ULID identifier',
  }));
}

function queryParams(schema: z.ZodTypeAny | undefined) {
  if (!schema) return [];
  const json = toSchema(schema);
  const props = (json.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((json.required as string[] | undefined) ?? []);
  return Object.entries(props).map(([name, s]) => ({
    name,
    in: 'query' as const,
    required: required.has(name),
    schema: s,
  }));
}

const ERROR_RESPONSE = {
  description: 'Error envelope carrying a machine-readable code and a traceId.',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
};

/**
 * Builds the OpenAPI 3.1 document straight from the Zod schemas the runtime validates
 * with, so documentation cannot drift away from enforcement.
 */
export function buildOpenApiDocument(options: { version: string; serverUrl: string }) {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const op of OPERATIONS) {
    const entry: Record<string, unknown> = {
      operationId: op.operationId,
      summary: op.summary,
      tags: [op.tag],
      parameters: [
        ...pathParams(op.path),
        ...queryParams(op.query),
        ...(op.idempotent
          ? [
              {
                name: 'Idempotency-Key',
                in: 'header' as const,
                required: true,
                schema: { type: 'string', minLength: 8, maxLength: 128 },
                description:
                  'Repeating a request with the same key returns the original job instead of creating duplicate work or artifacts.',
              },
            ]
          : []),
      ],
      security: op.public ? [] : [{ sessionCookie: [] }],
      responses: {
        [String(op.status ?? 200)]: {
          description: 'Success',
          content: op.response
            ? { 'application/json': { schema: toSchema(op.response) } }
            : undefined,
        },
        400: ERROR_RESPONSE,
        ...(op.public ? {} : { 401: ERROR_RESPONSE, 403: ERROR_RESPONSE }),
        404: ERROR_RESPONSE,
        409: ERROR_RESPONSE,
        429: ERROR_RESPONSE,
        500: ERROR_RESPONSE,
      },
    };

    if (op.permission) {
      entry.description = `Requires the \`${op.permission}\` permission. Tenant scope is derived from the session cookie and never from client input.`;
    }
    if (op.request) {
      entry.requestBody = {
        required: true,
        content: { 'application/json': { schema: toSchema(op.request) } },
      };
    }

    const bucket = (paths[op.path] ??= {});
    bucket[op.method] = entry;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'UXE Consulting AI API',
      version: options.version,
      description:
        'Verified answers, exact evidence, corrected documents.\n\n' +
        'Every response is scoped to the tenant derived from the session cookie. ' +
        'Citations are stored records with verified verbatim excerpts, not model-formatted strings.',
      license: { name: 'Proprietary' },
    },
    servers: [{ url: options.serverUrl }],
    tags: [
      { name: 'auth', description: 'Sessions, MFA, password and OAuth sign-in' },
      { name: 'dashboard', description: 'Workspace overview metrics' },
      { name: 'consultations', description: 'The consultant/customer workspace' },
      { name: 'corrections', description: 'Review-first corrected editions' },
      { name: 'sources', description: 'Knowledge base ingestion and versioning' },
      { name: 'citations', description: 'Exact evidence resolution' },
      { name: 'artifacts', description: 'Reports and generated documents' },
      { name: 'jobs', description: 'Asynchronous work' },
      { name: 'audit', description: 'Immutable audit trail' },
      { name: 'users', description: 'Membership and access' },
      { name: 'settings', description: 'Workspace, model and retention configuration' },
      { name: 'system', description: 'Health and readiness' },
    ],
    components: {
      securitySchemes: {
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: 'uxe_session',
          description:
            'HttpOnly, Secure, SameSite=Lax session cookie. State-changing requests must also send the X-CSRF-Token header.',
        },
      },
      schemas: {
        ApiError: toSchema(ApiErrorBody),
        Citation: toSchema(E.Citation),
        StructuredAnswer: toSchema(E.StructuredAnswer),
        Finding: toSchema(E.Finding),
        Requirement: toSchema(E.Requirement),
        JobView: toSchema(A.JobView),
        StreamEvent: toSchema(A.StreamEvent),
      },
    },
    paths,
  };
}

export const OPERATION_INDEX = OPERATIONS.map((o) => ({
  method: o.method.toUpperCase(),
  path: o.path,
  operationId: o.operationId,
  permission: o.permission ?? null,
  idempotent: Boolean(o.idempotent),
  public: Boolean(o.public),
}));
