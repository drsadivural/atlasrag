import { z } from 'zod';
import {
  DocumentType,
  Email,
  Id,
  JobKind,
  JobStatus,
  Locale,
  PageQuery,
  Password,
  Role,
  Sha256,
  Slug,
  SourceStatus,
  ThemePreference,
  Timestamp,
  paginated,
} from './primitives.js';
import {
  AnswerStyle,
  Citation,
  ComplianceResult,
  RiskLevel,
  StructuredAnswer,
  TaskMode,
} from './evidence.js';

/* -------------------------------------------------------------------------- */
/* Auth                                                                       */
/* -------------------------------------------------------------------------- */

export const RegisterRequest = z.object({
  email: Email,
  password: Password,
  fullName: z.string().trim().min(2).max(120),
  organizationName: z.string().trim().min(2).max(120),
  locale: Locale.default('en'),
  acceptedTerms: z.literal(true, { message: 'You must accept the terms to continue' }),
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

export const LoginRequest = z.object({
  email: Email,
  password: z.string().min(1, 'Enter your password'),
  rememberMe: z.boolean().default(false),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const MfaVerifyRequest = z.object({
  challengeId: Id,
  /** Returned by the sign-in response; only its hash is stored server-side. */
  challengeToken: z.string().min(20),
  /**
   * A six-digit authenticator code or one of the account's recovery codes. Both are
   * accepted here because both are offered on the sign-in screen.
   */
  code: z
    .string()
    .trim()
    .regex(
      /^(?:\d{6}|[A-Za-z2-9]{5}-?[A-Za-z2-9]{5})$/,
      'Enter the 6-digit code from your authenticator, or a recovery code',
    ),
  trustDevice: z.boolean().default(false),
});

export const ForgotPasswordRequest = z.object({ email: Email });
export const ResetPasswordRequest = z.object({
  token: z.string().min(20),
  password: Password,
});
export const VerifyEmailRequest = z.object({ token: z.string().min(20) });

/**
 * Accepting a workspace invitation.
 *
 * A password is required only when the invited address has no account yet; an existing
 * user simply joins the new workspace.
 */
export const AcceptInvitationRequest = z.object({
  token: z.string().min(20),
  fullName: z.string().trim().min(2).max(120).optional(),
  password: Password.optional(),
});
export type AcceptInvitationRequest = z.infer<typeof AcceptInvitationRequest>;

export const InvitationPreview = z.object({
  email: Email,
  workspaceName: z.string(),
  role: Role,
  invitedByName: z.string(),
  /** True when the invited address already has an account and only needs to sign in. */
  hasAccount: z.boolean(),
  message: z.string().nullable(),
  expiresAt: Timestamp,
});
export type InvitationPreview = z.infer<typeof InvitationPreview>;
export const MagicLinkRequest = z.object({ email: Email });

export const SessionUser = z.object({
  id: Id,
  email: Email,
  fullName: z.string(),
  avatarUrl: z.string().nullable(),
  title: z.string().nullable(),
  locale: Locale,
  theme: ThemePreference,
  emailVerified: z.boolean(),
  mfaEnabled: z.boolean(),
  createdAt: Timestamp,
});
export type SessionUser = z.infer<typeof SessionUser>;

export const WorkspaceSummary = z.object({
  id: Id,
  organizationId: Id,
  name: z.string(),
  slug: Slug,
  role: Role,
  isDefault: z.boolean(),
});
export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>;

export const SessionResponse = z.object({
  user: SessionUser,
  workspace: WorkspaceSummary.nullable(),
  workspaces: z.array(WorkspaceSummary),
  permissions: z.array(z.string()),
  csrfToken: z.string(),
  expiresAt: Timestamp,
});
export type SessionResponse = z.infer<typeof SessionResponse>;

/** Sign-in either completes, or stops at an MFA challenge. Both are 200 responses. */
export const LoginResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('authenticated'), session: SessionResponse }),
  z.object({
    status: z.literal('mfa_required'),
    challengeId: Id,
    methods: z.array(z.enum(['totp', 'webauthn'])),
    /** Single-use; must be echoed back to /auth/mfa/verify. */
    challengeToken: z.string(),
  }),
  z.object({ status: z.literal('email_verification_required'), email: Email }),
]);
export type LoginResponse = z.infer<typeof LoginResponse>;

/**
 * Registration never mints a session.
 *
 * The response is byte-identical whether the address was free or already taken, so it
 * cannot be used to discover who has an account. `registered` means the account can sign
 * in now; `email_verification_required` means it must confirm the address first.
 */
export const RegisterResponse = z.object({
  status: z.enum(['registered', 'email_verification_required']),
  email: Email,
});
export type RegisterResponse = z.infer<typeof RegisterResponse>;

export const DeviceSession = z.object({
  id: Id,
  current: z.boolean(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: Timestamp,
  lastSeenAt: Timestamp,
  expiresAt: Timestamp,
});
export type DeviceSession = z.infer<typeof DeviceSession>;

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                  */
/* -------------------------------------------------------------------------- */

export const DashboardQuery = z.object({
  days: z.coerce.number().int().min(7).max(365).default(30),
});

export const KpiCard = z.object({
  key: z.enum(['consultations', 'documents_reviewed', 'compliance_rate', 'evidence_coverage']),
  value: z.number(),
  /** `percent` values are 0..100; `count` values are absolute. */
  unit: z.enum(['count', 'percent']),
  changePercent: z.number().nullable(),
  comparedToDays: z.number().int(),
  /** Deep-link target so every metric drills into the page that explains it. */
  href: z.string(),
});
export type KpiCard = z.infer<typeof KpiCard>;

export const DashboardResponse = z.object({
  greetingName: z.string(),
  kpis: z.array(KpiCard),
  activity: z.object({
    points: z.array(z.object({ date: z.string(), consultations: z.number().int() })),
    total: z.number().int(),
  }),
  complianceOutcomes: z.object({
    compliant: z.number().int(),
    needsEvidence: z.number().int(),
    nonCompliant: z.number().int(),
    notAssessed: z.number().int(),
    total: z.number().int(),
  }),
  recentConsultations: z.array(
    z.object({
      id: Id,
      title: z.string(),
      status: z.string(),
      complianceScore: z.number().nullable(),
      sourceCount: z.number().int(),
      updatedAt: Timestamp,
      ownerName: z.string(),
      ownerAvatarUrl: z.string().nullable(),
    }),
  ),
  needsAttention: z.array(
    z.object({
      id: Id,
      kind: z.enum([
        'failed_job',
        'critical_gap',
        'unresolved_evidence',
        'stale_knowledge',
        'pending_review',
      ]),
      title: z.string(),
      detail: z.string(),
      severity: z.enum(['critical', 'warning', 'info']),
      href: z.string(),
    }),
  ),
  knowledgeHealth: z.object({
    score: z.number().min(0).max(100),
    ready: z.number().int(),
    processing: z.number().int(),
    outdated: z.number().int(),
    failed: z.number().int(),
    missingMetadata: z.number().int(),
    unlinkedContent: z.number().int(),
    duplicates: z.number().int(),
    permissionIssues: z.number().int(),
    formula: z.string(),
  }),
});
export type DashboardResponse = z.infer<typeof DashboardResponse>;

/* -------------------------------------------------------------------------- */
/* Sources / knowledge base                                                   */
/* -------------------------------------------------------------------------- */

export const SourceAccessScope = z.enum(['workspace', 'group', 'users']);
export type SourceAccessScope = z.infer<typeof SourceAccessScope>;

export const SourceSummary = z.object({
  id: Id,
  title: z.string(),
  documentType: DocumentType,
  status: SourceStatus,
  pages: z.number().int().nullable(),
  currentVersion: z.string(),
  currentVersionId: Id.nullable(),
  accessScope: SourceAccessScope,
  accessLabel: z.string(),
  tags: z.array(z.string()),
  ownerName: z.string(),
  sizeBytes: z.number().int().nullable(),
  lastSyncedAt: Timestamp.nullable(),
  updatedAt: Timestamp,
  createdAt: Timestamp,
  connectorKind: z.string().nullable(),
  /** Present when status is `failed`; drives the inline Retry affordance. */
  failureReason: z.string().nullable(),
  processingPercent: z.number().min(0).max(100).nullable(),
  isPromotedUpload: z.boolean(),
  effectiveDate: Timestamp.nullable(),
  /** Optimistic-concurrency token; echo it back on PATCH. */
  version: z.number().int().min(0),
});
export type SourceSummary = z.infer<typeof SourceSummary>;

export const SourcesQuery = PageQuery.extend({
  q: z.string().trim().max(200).optional(),
  status: z.union([SourceStatus, z.literal('all')]).default('all'),
  documentType: z.union([DocumentType, z.literal('all')]).default('all'),
  tag: z.string().optional(),
  ownerId: Id.optional(),
  sort: z
    .enum(['updated_desc', 'updated_asc', 'title_asc', 'title_desc', 'status'])
    .default('updated_desc'),
});
export type SourcesQuery = z.infer<typeof SourcesQuery>;

export const SourcesResponse = paginated(SourceSummary).extend({
  counts: z.object({
    all: z.number().int(),
    ready: z.number().int(),
    processing: z.number().int(),
    needs_review: z.number().int(),
    failed: z.number().int(),
    archived: z.number().int(),
  }),
  pipeline: z.array(
    z.object({
      stage: z.enum([
        'malware_scan',
        'extraction',
        'structure_analysis',
        'chunking',
        'embeddings',
        'lexical_index',
        'citation_map',
        'validation',
      ]),
      completed: z.number().int(),
      total: z.number().int(),
      state: z.enum(['complete', 'running', 'blocked', 'idle']),
      /**
       * The documents behind the number, so a stage can be opened and read.
       *
       * A count alone says a stage is blocked without saying which document blocked it or
       * why, which is the one thing somebody looking at a stalled pipeline needs. Only the
       * documents that are still working or that stopped are listed; a stage that finished
       * cleanly has nothing to explain.
       */
      documents: z.array(
        z.object({
          sourceId: Id,
          title: z.string(),
          state: z.enum(['running', 'failed', 'pending']),
          /** What the stage recorded: a page count, an OCR confidence, or why it stopped. */
          detail: z.string().nullable(),
          startedAt: Timestamp.nullable(),
        }),
      ),
    }),
  ),
  knowledgeHealth: z.object({
    score: z.number().min(0).max(100),
    ready: z.number().int(),
    processing: z.number().int(),
    needsReview: z.number().int(),
    failed: z.number().int(),
    formula: z.string(),
  }),
});
export type SourcesResponse = z.infer<typeof SourcesResponse>;

export const SourceVersionSummary = z.object({
  id: Id,
  version: z.string(),
  sha256: Sha256,
  normalizedSha256: Sha256.nullable(),
  pages: z.number().int().nullable(),
  sizeBytes: z.number().int(),
  status: SourceStatus,
  isCurrent: z.boolean(),
  createdAt: Timestamp,
  promotedAt: Timestamp.nullable(),
  createdByName: z.string(),
  ocrApplied: z.boolean(),
  ocrConfidence: z.number().min(0).max(1).nullable(),
  extractionCoverage: z.number().min(0).max(1).nullable(),
  notes: z.string().nullable(),
});
export type SourceVersionSummary = z.infer<typeof SourceVersionSummary>;

export const SourceDetail = SourceSummary.extend({
  description: z.string().nullable(),
  versions: z.array(SourceVersionSummary),
  permissions: z.array(
    z.object({
      id: Id,
      scope: SourceAccessScope,
      subjectId: Id.nullable(),
      subjectLabel: z.string(),
      capability: z.enum(['read', 'manage']),
    }),
  ),
  syncHistory: z.array(
    z.object({
      id: Id,
      at: Timestamp,
      result: z.enum(['success', 'no_change', 'failed']),
      detail: z.string(),
    }),
  ),
  processingLog: z.array(
    z.object({
      id: Id,
      stage: z.string(),
      status: JobStatus,
      message: z.string(),
      at: Timestamp,
      attempt: z.number().int(),
    }),
  ),
  structure: z.object({
    headings: z.number().int(),
    clauses: z.number().int(),
    tables: z.number().int(),
    definitions: z.number().int(),
    chunks: z.number().int(),
  }),
  quarantine: z
    .object({ reason: z.string(), patterns: z.array(z.string()), excerpt: z.string() })
    .nullable(),
});
export type SourceDetail = z.infer<typeof SourceDetail>;

export const CreateUploadRequest = z.object({
  files: z
    .array(
      z.object({
        fileName: z.string().min(1).max(512),
        sizeBytes: z.number().int().min(1),
        contentType: z.string().min(1).max(255),
      }),
    )
    .min(1)
    .max(50),
  tags: z.array(z.string().trim().min(1).max(48)).max(20).default([]),
  accessScope: SourceAccessScope.default('workspace'),
  /** Consultation uploads are inputs, not knowledge, until explicitly promoted. */
  promoteToKnowledge: z.boolean().default(true),
});
export type CreateUploadRequest = z.infer<typeof CreateUploadRequest>;

export const UploadTicket = z.object({
  uploadId: Id,
  sourceId: Id,
  fileName: z.string(),
  /** Where the browser PUTs bytes. Same-origin in dev, a signed R2 URL in production. */
  uploadUrl: z.string(),
  method: z.enum(['PUT', 'POST']),
  headers: z.record(z.string(), z.string()),
  expiresAt: Timestamp,
  maxBytes: z.number().int(),
});
export type UploadTicket = z.infer<typeof UploadTicket>;

export const ConnectorKind = z.enum(['google_drive', 'onedrive', 'sharepoint', 'website', 'text']);
export type ConnectorKind = z.infer<typeof ConnectorKind>;

export const CreateConnectorRequest = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('website'),
    url: z.url(),
    maxDepth: z.number().int().min(0).max(5).default(1),
    maxPages: z.number().int().min(1).max(500).default(25),
    allowedDomains: z.array(z.string()).default([]),
    respectRobots: z.boolean().default(true),
    autoSync: z.boolean().default(false),
    syncCron: z.string().nullable().default(null),
  }),
  z.object({
    kind: z.literal('text'),
    title: z.string().trim().min(1).max(200),
    content: z.string().min(1).max(2_000_000),
    tags: z.array(z.string()).default([]),
  }),
  z.object({
    kind: z.enum(['google_drive', 'onedrive', 'sharepoint']),
    accountEmail: Email,
    rootPath: z.string().default('/'),
    includeGlobs: z.array(z.string()).default([]),
    excludeGlobs: z.array(z.string()).default([]),
    fileTypes: z.array(DocumentType).default([]),
    autoSync: z.boolean().default(true),
    syncCron: z.string().default('0 */6 * * *'),
  }),
]);
export type CreateConnectorRequest = z.infer<typeof CreateConnectorRequest>;

/* -------------------------------------------------------------------------- */
/* Connectors                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The three file stores a workspace can attach.
 *
 * A narrower set than `ConnectorKind`: a website or a pasted note is fetched once and has
 * no account behind it, while these three hold a standing OAuth grant over somebody's
 * files and need connecting, disconnecting and re-authorising.
 */
export const FileStoreKind = z.enum(['google_drive', 'onedrive', 'sharepoint']);
export type FileStoreKind = z.infer<typeof FileStoreKind>;

export const ConnectorStatus = z.enum(['connected', 'error', 'syncing', 'disconnected']);
export type ConnectorStatus = z.infer<typeof ConnectorStatus>;

/**
 * One provider as the settings screen sees it.
 *
 * `available` says whether this deployment has an OAuth application for the provider at
 * all. It is separate from `connection`, because "nobody has connected Drive yet" and
 * "this deployment cannot connect Drive" are different problems with different fixes, and
 * a single disabled button would tell an administrator neither.
 */
export const ConnectorProvider = z.object({
  kind: FileStoreKind,
  label: z.string(),
  description: z.string(),
  available: z.boolean(),
  /** Environment variables an operator must set when `available` is false. */
  requiredEnv: z.array(z.string()),
  /** Register this exactly with the provider, or the handshake is refused. */
  redirectUri: z.string(),
  /** What the workspace is asking the account holder to grant. */
  scopes: z.array(z.string()),
  connection: z
    .object({
      id: Id,
      status: ConnectorStatus,
      accountEmail: z.string().nullable(),
      displayName: z.string(),
      rootPath: z.string(),
      lastSyncedAt: Timestamp.nullable(),
      lastError: z.string().nullable(),
      createdAt: Timestamp,
      version: z.number().int().min(0),
    })
    .nullable(),
});
export type ConnectorProvider = z.infer<typeof ConnectorProvider>;

export const ConnectorsResponse = z.object({ providers: z.array(ConnectorProvider) });
export type ConnectorsResponse = z.infer<typeof ConnectorsResponse>;

export const ConnectorAuthorizeRequest = z.object({
  /** Where to send the browser once the provider has answered. */
  returnTo: z.string().max(200).default('/settings/connectors'),
});
export type ConnectorAuthorizeRequest = z.infer<typeof ConnectorAuthorizeRequest>;

export const ConnectorAuthorizeResponse = z.object({ authorizeUrl: z.url() });
export type ConnectorAuthorizeResponse = z.infer<typeof ConnectorAuthorizeResponse>;

export const ConnectorCallbackQuery = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1),
  error: z.string().optional(),
  error_description: z.string().optional(),
});
export type ConnectorCallbackQuery = z.infer<typeof ConnectorCallbackQuery>;

export const UpdateConnectorRequest = z.object({
  rootPath: z.string().trim().max(400).optional(),
  version: z.number().int().min(0),
});
export type UpdateConnectorRequest = z.infer<typeof UpdateConnectorRequest>;

export const UpdateSourceRequest = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(2000).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(48)).max(20).optional(),
  accessScope: SourceAccessScope.optional(),
  accessSubjectIds: z.array(Id).optional(),
  effectiveDate: Timestamp.nullable().optional(),
  status: z.enum(['ready', 'archived']).optional(),
  /** Optimistic concurrency: rejected with 409 when the row moved underneath you. */
  version: z.number().int().min(0),
});
export type UpdateSourceRequest = z.infer<typeof UpdateSourceRequest>;

export const BulkSourceActionRequest = z.object({
  sourceIds: z.array(Id).min(1).max(200),
  action: z.enum(['tag', 'set_access', 'reprocess', 'archive', 'restore', 'delete', 'export']),
  tags: z.array(z.string()).optional(),
  accessScope: SourceAccessScope.optional(),
  accessSubjectIds: z.array(Id).optional(),
  confirm: z.literal(true),
});
export type BulkSourceActionRequest = z.infer<typeof BulkSourceActionRequest>;

/* -------------------------------------------------------------------------- */
/* Consultations                                                              */
/* -------------------------------------------------------------------------- */

export const ConsultationStatus = z.enum([
  'draft',
  'active',
  'awaiting_input',
  'processing',
  'report_ready',
  'action_required',
  'archived',
]);
export type ConsultationStatus = z.infer<typeof ConsultationStatus>;

export const ConsultationSummary = z.object({
  id: Id,
  title: z.string(),
  status: ConsultationStatus,
  taskMode: TaskMode,
  documentCount: z.number().int(),
  sourceCount: z.number().int(),
  complianceScore: z.number().min(0).max(100).nullable(),
  pinned: z.boolean(),
  ownerId: Id,
  ownerName: z.string(),
  lastMessageAt: Timestamp.nullable(),
  updatedAt: Timestamp,
  createdAt: Timestamp,
});
export type ConsultationSummary = z.infer<typeof ConsultationSummary>;

export const ConsultationsQuery = PageQuery.extend({
  q: z.string().trim().max(200).optional(),
  status: z.union([ConsultationStatus, z.literal('all')]).default('all'),
  pinned: z.coerce.boolean().optional(),
});

export const CreateConsultationRequest = z.object({
  title: z.string().trim().min(1).max(200).default('New consultation'),
  taskMode: TaskMode.default('ask'),
  sourceIds: z.array(Id).max(200).default([]),
});
export type CreateConsultationRequest = z.infer<typeof CreateConsultationRequest>;

export const UpdateConsultationRequest = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  status: ConsultationStatus.optional(),
  taskMode: TaskMode.optional(),
  pinned: z.boolean().optional(),
  sourceIds: z.array(Id).max(200).optional(),
  answerStyle: AnswerStyle.optional(),
  evidenceDetail: z
    .object({
      documentAndPage: z.boolean(),
      clauseAndLocation: z.boolean(),
      supportingExcerpt: z.boolean(),
    })
    .optional(),
  responseControls: z
    .object({
      knowledgeOnly: z.boolean(),
      askWhenUncertain: z.boolean(),
      generalModelFallback: z.boolean(),
    })
    .optional(),
  outputFormat: z.enum(['match_source', 'pdf', 'docx', 'xlsx', 'pptx', 'markdown']).optional(),
  version: z.number().int().min(0),
});
export type UpdateConsultationRequest = z.infer<typeof UpdateConsultationRequest>;

export const MessageRole = z.enum(['user', 'assistant', 'system']);

export const MessageAttachment = z.object({
  id: Id,
  fileName: z.string(),
  documentType: DocumentType,
  sizeBytes: z.number().int(),
  sourceId: Id.nullable(),
  sourceVersionId: Id.nullable(),
  status: SourceStatus,
  pages: z.number().int().nullable(),
  promotedToKnowledge: z.boolean(),
});
export type MessageAttachment = z.infer<typeof MessageAttachment>;

export const ConsultationMessage = z.object({
  id: Id,
  consultationId: Id,
  role: MessageRole,
  authorName: z.string(),
  authorAvatarUrl: z.string().nullable(),
  text: z.string(),
  taskMode: TaskMode.nullable(),
  answer: StructuredAnswer.nullable(),
  attachments: z.array(MessageAttachment).default([]),
  jobId: Id.nullable(),
  jobStatus: JobStatus.nullable(),
  /** Set when a message is a branch point created from an earlier message. */
  parentMessageId: Id.nullable(),
  feedback: z.enum(['up', 'down']).nullable(),
  createdAt: Timestamp,
  error: z
    .object({ code: z.string(), message: z.string(), retryable: z.boolean(), traceId: z.string() })
    .nullable(),
});
export type ConsultationMessage = z.infer<typeof ConsultationMessage>;

export const ConsultationDetail = ConsultationSummary.extend({
  version: z.number().int(),
  answerStyle: AnswerStyle,
  evidenceDetail: z.object({
    documentAndPage: z.boolean(),
    clauseAndLocation: z.boolean(),
    supportingExcerpt: z.boolean(),
  }),
  responseControls: z.object({
    knowledgeOnly: z.boolean(),
    askWhenUncertain: z.boolean(),
    generalModelFallback: z.boolean(),
  }),
  outputFormat: z.enum(['match_source', 'pdf', 'docx', 'xlsx', 'pptx', 'markdown']),
  sources: z.array(
    z.object({
      sourceId: Id,
      sourceVersionId: Id,
      title: z.string(),
      documentType: DocumentType,
      version: z.string(),
      role: z.enum(['governing', 'project']),
      pages: z.number().int().nullable(),
      effectiveDate: Timestamp.nullable(),
      status: SourceStatus,
    }),
  ),
  messages: z.array(ConsultationMessage),
  participants: z.array(
    z.object({ userId: Id, name: z.string(), avatarUrl: z.string().nullable(), role: Role }),
  ),
});
export type ConsultationDetail = z.infer<typeof ConsultationDetail>;

export const PostMessageRequest = z.object({
  text: z.string().trim().min(1).max(20000),
  taskMode: TaskMode.default('ask'),
  answerStyle: AnswerStyle.default('optimal'),
  attachmentIds: z.array(Id).max(50).default([]),
  /** Creates a branch instead of appending to the tip. */
  parentMessageId: Id.nullable().default(null),
  idempotencyKey: z.string().min(8).max(128),
});
export type PostMessageRequest = z.infer<typeof PostMessageRequest>;

export const CreateReviewRequest = z.object({
  projectSourceIds: z.array(Id).min(1).max(50),
  governingSourceIds: z.array(Id).min(1).max(20),
  answerStyle: AnswerStyle.default('details'),
  scopeNote: z.string().max(2000).optional(),
  idempotencyKey: z.string().min(8).max(128),
});
export type CreateReviewRequest = z.infer<typeof CreateReviewRequest>;

export const CreateReportRequest = z.object({
  reviewId: Id.nullable().default(null),
  messageId: Id.nullable().default(null),
  format: z.enum(['pdf', 'docx', 'xlsx', 'csv', 'markdown']),
  kind: z.enum(['compliance_report', 'summary', 'evidence_matrix']),
  title: z.string().trim().min(1).max(200).optional(),
  idempotencyKey: z.string().min(8).max(128),
});
export type CreateReportRequest = z.infer<typeof CreateReportRequest>;

/* -------------------------------------------------------------------------- */
/* Corrections                                                                */
/* -------------------------------------------------------------------------- */

export const CorrectionChangeStatus = z.enum(['proposed', 'accepted', 'rejected', 'edited']);

export const CorrectionChange = z.object({
  id: Id,
  planId: Id,
  ordinal: z.number().int(),
  locatorLabel: z.string(),
  pageNumber: z.number().int().nullable(),
  paragraphIndex: z.number().int().nullable(),
  sheetName: z.string().nullable(),
  cellRange: z.string().nullable(),
  slideNumber: z.number().int().nullable(),
  currentContent: z.string(),
  proposedContent: z.string(),
  /** Set when a reviewer hand-edits the proposal; this is what gets written. */
  editedContent: z.string().nullable(),
  reason: z.string(),
  governingCitationId: Id.nullable(),
  governingCitation: Citation.nullable(),
  findingId: Id.nullable(),
  risk: RiskLevel,
  confidence: z.number().min(0).max(1),
  status: CorrectionChangeStatus,
});
export type CorrectionChange = z.infer<typeof CorrectionChange>;

export const CorrectionPlan = z.object({
  id: Id,
  consultationId: Id,
  sourceId: Id,
  sourceVersionId: Id,
  documentTitle: z.string(),
  documentType: DocumentType,
  status: z.enum(['draft', 'ready', 'generating', 'generated', 'failed']),
  /** Stated before generation when in-place correction would be unsafe. */
  limitations: z.array(z.string()).default([]),
  signatureNotice: z.string().nullable(),
  outputStrategy: z.enum([
    'in_place_text',
    'tracked_changes',
    'overlay',
    'ocr_rebuild',
    'revised_edition',
  ]),
  changes: z.array(CorrectionChange),
  createdAt: Timestamp,
  generatedArtifactId: Id.nullable(),
  /** Optimistic-concurrency token; echo it back when recording decisions. */
  version: z.number().int().min(0),
});
export type CorrectionPlan = z.infer<typeof CorrectionPlan>;

export const CreateCorrectionRequest = z.object({
  sourceId: Id,
  findingIds: z.array(Id).default([]),
  reviewId: Id.nullable().default(null),
  instructions: z.string().max(4000).optional(),
  idempotencyKey: z.string().min(8).max(128),
});
export type CreateCorrectionRequest = z.infer<typeof CreateCorrectionRequest>;

export const DecideCorrectionRequest = z.object({
  decisions: z
    .array(
      z.object({
        changeId: Id,
        status: CorrectionChangeStatus,
        editedContent: z.string().max(20000).nullable().default(null),
      }),
    )
    .min(1),
  version: z.number().int().min(0),
});
export type DecideCorrectionRequest = z.infer<typeof DecideCorrectionRequest>;

export const GenerateCorrectionRequest = z.object({
  outputFormat: z.enum(['match_source', 'pdf', 'docx', 'xlsx', 'pptx']).default('match_source'),
  includeRedline: z.boolean().default(true),
  idempotencyKey: z.string().min(8).max(128),
});
export type GenerateCorrectionRequest = z.infer<typeof GenerateCorrectionRequest>;

/* -------------------------------------------------------------------------- */
/* Jobs, artifacts, reports                                                   */
/* -------------------------------------------------------------------------- */

export const JobStage = z.object({
  key: z.string(),
  label: z.string(),
  state: z.enum(['pending', 'running', 'complete', 'failed', 'skipped']),
  detail: z.string().nullable(),
  percent: z.number().min(0).max(100).nullable(),
});

export const JobView = z.object({
  id: Id,
  kind: JobKind,
  status: JobStatus,
  percent: z.number().min(0).max(100),
  stages: z.array(JobStage),
  attempt: z.number().int(),
  maxAttempts: z.number().int(),
  error: z
    .object({ code: z.string(), message: z.string(), retryable: z.boolean(), traceId: z.string() })
    .nullable(),
  resultRef: z
    .object({ kind: z.enum(['message', 'artifact', 'source', 'review', 'plan']), id: Id })
    .nullable(),
  createdAt: Timestamp,
  startedAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
});
export type JobView = z.infer<typeof JobView>;

export const ArtifactKind = z.enum([
  'compliance_report',
  'summary',
  'evidence_matrix',
  'corrected_document',
  'redline',
  'export',
]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

export const ArtifactSummary = z.object({
  id: Id,
  title: z.string(),
  kind: ArtifactKind,
  documentType: DocumentType,
  sizeBytes: z.number().int(),
  sha256: Sha256,
  status: z.enum(['generating', 'ready', 'failed', 'archived']),
  consultationId: Id.nullable(),
  consultationTitle: z.string().nullable(),
  sourceId: Id.nullable(),
  sourceVersionId: Id.nullable(),
  sourceTitle: z.string().nullable(),
  /** Which model/config produced this artifact — recorded for audit. */
  generatorDescriptor: z.string(),
  ownerName: z.string(),
  createdAt: Timestamp,
  retainUntil: Timestamp.nullable(),
  /** e.g. "New unsigned derivative — the original signature is not carried over." */
  disclosures: z.array(z.string()).default([]),
});
export type ArtifactSummary = z.infer<typeof ArtifactSummary>;

export const ReportsQuery = PageQuery.extend({
  q: z.string().trim().max(200).optional(),
  kind: z.union([ArtifactKind, z.literal('all')]).default('all'),
  consultationId: Id.optional(),
  status: z.enum(['all', 'generating', 'ready', 'failed', 'archived']).default('all'),
});

/* -------------------------------------------------------------------------- */
/* Activity / audit                                                           */
/* -------------------------------------------------------------------------- */

export const AuditEvent = z.object({
  id: Id,
  at: Timestamp,
  actorId: Id.nullable(),
  actorName: z.string(),
  actorType: z.enum(['user', 'system', 'connector']),
  action: z.string(),
  category: z.enum([
    'auth',
    'permission',
    'source',
    'consultation',
    'review',
    'artifact',
    'configuration',
    'deletion',
    'export',
  ]),
  targetType: z.string().nullable(),
  targetId: Id.nullable(),
  targetLabel: z.string().nullable(),
  result: z.enum(['success', 'failure', 'denied']),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  traceId: z.string(),
  summary: z.string(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

export const AuditQuery = PageQuery.extend({
  q: z.string().trim().max(200).optional(),
  category: z.union([AuditEvent.shape.category, z.literal('all')]).default('all'),
  actorId: Id.optional(),
  result: z.enum(['all', 'success', 'failure', 'denied']).default('all'),
  from: Timestamp.optional(),
  to: Timestamp.optional(),
});

/* -------------------------------------------------------------------------- */
/* Users & settings                                                           */
/* -------------------------------------------------------------------------- */

export const WorkspaceUser = z.object({
  id: Id,
  email: Email,
  fullName: z.string(),
  avatarUrl: z.string().nullable(),
  role: Role,
  status: z.enum(['active', 'invited', 'suspended']),
  groups: z.array(z.object({ id: Id, name: z.string() })),
  mfaEnabled: z.boolean(),
  activeSessions: z.number().int(),
  lastActiveAt: Timestamp.nullable(),
  invitedAt: Timestamp.nullable(),
  joinedAt: Timestamp.nullable(),
  accessibleSourceCount: z.number().int(),
});
export type WorkspaceUser = z.infer<typeof WorkspaceUser>;

export const InviteUserRequest = z.object({
  email: Email,
  role: Role,
  groupIds: z.array(Id).default([]),
  message: z.string().max(1000).optional(),
});

export const UpdateUserRequest = z.object({
  role: Role.optional(),
  status: z.enum(['active', 'suspended']).optional(),
  groupIds: z.array(Id).optional(),
  revokeSessions: z.boolean().optional(),
});

export const ModelCapability = z.enum([
  'chat',
  'embedding',
  'ocr',
  'rerank',
  'document_generation',
]);

export const ModelConfiguration = z.object({
  id: Id,
  capability: ModelCapability,
  provider: z.enum(['deterministic', 'anthropic', 'openai']),
  model: z.string(),
  isPrimary: z.boolean(),
  isFallback: z.boolean(),
  enabled: z.boolean(),
  hasCredential: z.boolean(),
  health: z.enum(['healthy', 'degraded', 'unconfigured', 'circuit_open', 'unknown']),
  healthDetail: z.string().nullable(),
  lastCheckedAt: Timestamp.nullable(),
  tokensUsed30d: z.number().int(),
  requestsUsed30d: z.number().int(),
  quotaLimit: z.number().int().nullable(),
  updatedAt: Timestamp,
});
export type ModelConfiguration = z.infer<typeof ModelConfiguration>;

/**
 * Asking a provider what it will serve.
 *
 * The key may be one just typed into the form and not yet saved, which is why it can be
 * supplied here; it is used for the one request and never stored by this call.
 */
export const AvailableModelsRequest = z.object({
  provider: z.enum(['openai', 'anthropic']),
  capability: z.string().min(1).max(40),
  apiKey: z.string().max(400).optional(),
});
export type AvailableModelsRequest = z.infer<typeof AvailableModelsRequest>;

export const AvailableModelsResponse = z.object({
  provider: z.enum(['openai', 'anthropic']),
  models: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      createdAt: Timestamp.nullable(),
    }),
  ),
});
export type AvailableModelsResponse = z.infer<typeof AvailableModelsResponse>;

export const UpsertModelConfigRequest = z.object({
  capability: ModelCapability,
  provider: z.enum(['deterministic', 'anthropic', 'openai']),
  model: z.string().min(1).max(120),
  isPrimary: z.boolean().default(true),
  isFallback: z.boolean().default(false),
  enabled: z.boolean().default(true),
  /** Write-only. Encrypted with AES-256-GCM at rest and never returned by any read. */
  apiKey: z.string().min(8).max(512).nullable().default(null),
});

export const WorkspaceSettings = z.object({
  general: z.object({
    workspaceName: z.string(),
    slug: Slug,
    locale: Locale,
    timezone: z.string(),
    brandColor: z.string(),
    logoUrl: z.string().nullable(),
  }),
  consultant: z.object({
    name: z.string(),
    title: z.string(),
    avatarUrl: z.string(),
    greeting: z.string(),
    behaviorNotes: z.string(),
    defaultAnswerStyle: AnswerStyle,
    defaultTaskMode: TaskMode,
  }),
  answers: z.object({
    knowledgeOnly: z.boolean(),
    askWhenUncertain: z.boolean(),
    generalModelFallback: z.boolean(),
    requireCitations: z.boolean(),
    minimumEvidenceThreshold: z.number().min(0).max(1),
    minimumCitationsPerClaim: z.number().int().min(0).max(5),
  }),
  security: z.object({
    mfaPolicy: z.enum(['optional', 'required_admins', 'required_all']),
    sessionIdleMinutes: z.number().int().min(5).max(1440),
    sessionAbsoluteHours: z.number().int().min(1).max(720),
    allowedEmailDomains: z.array(z.string()),
    ssoEnforced: z.boolean(),
  }),
  retention: z.object({
    consultationDays: z.number().int().min(1).max(3650),
    artifactDays: z.number().int().min(1).max(3650),
    auditDays: z.number().int().min(30).max(3650),
    purgeGraceDays: z.number().int().min(0).max(365),
    legalHold: z.boolean(),
  }),
  notifications: z.object({
    jobCompletion: z.boolean(),
    weeklyDigest: z.boolean(),
    criticalFindings: z.boolean(),
  }),
});
export type WorkspaceSettings = z.infer<typeof WorkspaceSettings>;

export const UpdateSettingsRequest = z.object({
  general: WorkspaceSettings.shape.general.partial().optional(),
  consultant: WorkspaceSettings.shape.consultant.partial().optional(),
  answers: WorkspaceSettings.shape.answers.partial().optional(),
  security: WorkspaceSettings.shape.security.partial().optional(),
  retention: WorkspaceSettings.shape.retention.partial().optional(),
  notifications: WorkspaceSettings.shape.notifications.partial().optional(),
});

/* -------------------------------------------------------------------------- */
/* Citation resolution                                                        */
/* -------------------------------------------------------------------------- */

/** What the citation viewer needs to open a source at the right place and highlight it. */
export const CitationResolution = z.object({
  citation: Citation,
  documentTitle: z.string(),
  documentType: DocumentType,
  version: z.string(),
  totalPages: z.number().int().nullable(),
  /** Full text of the located page/section so the passage can be highlighted in context. */
  pageText: z.string(),
  /** Character offsets of the excerpt within `pageText`. */
  highlight: z.object({ start: z.number().int(), end: z.number().int() }).nullable(),
  /** Short-lived signed URL for the original bytes, when the caller may download. */
  downloadUrl: z.string().nullable(),
  previousCitationId: Id.nullable(),
  nextCitationId: Id.nullable(),
});
export type CitationResolution = z.infer<typeof CitationResolution>;

/* -------------------------------------------------------------------------- */
/* Streaming events (SSE)                                                     */
/* -------------------------------------------------------------------------- */

export const StreamEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('job'), job: JobView }),
  z.object({ type: z.literal('stage'), jobId: Id, stage: JobStage }),
  z.object({ type: z.literal('token'), messageId: Id, delta: z.string() }),
  z.object({ type: z.literal('message'), message: ConsultationMessage }),
  z.object({
    type: z.literal('error'),
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    traceId: z.string(),
  }),
  z.object({ type: z.literal('done'), messageId: Id.nullable() }),
  z.object({ type: z.literal('heartbeat'), at: Timestamp }),
]);
export type StreamEvent = z.infer<typeof StreamEvent>;

export const HealthResponse = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  version: z.string(),
  checks: z.array(
    z.object({
      name: z.string(),
      status: z.enum(['ok', 'degraded', 'down']),
      latencyMs: z.number().nullable(),
      detail: z.string().nullable(),
    }),
  ),
  at: Timestamp,
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export { ComplianceResult };
