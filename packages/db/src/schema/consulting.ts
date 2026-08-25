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
import { sources, sourceVersions } from './knowledge.js';

export const consultations = pgTable(
  'consultations',
  {
    id: id(),
    organizationId: text('organization_id').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    status: text('status').notNull().default('draft'),
    taskMode: text('task_mode').notNull().default('ask'),
    answerStyle: text('answer_style').notNull().default('optimal'),
    outputFormat: text('output_format').notNull().default('match_source'),
    evidenceDetail: jsonb('evidence_detail')
      .$type<{ documentAndPage: boolean; clauseAndLocation: boolean; supportingExcerpt: boolean }>()
      .notNull()
      .default({ documentAndPage: true, clauseAndLocation: true, supportingExcerpt: true }),
    /**
     * `generalModelFallback` defaults to false: nothing outside the knowledge base is
     * asserted unless the workspace explicitly opts in, and then it is labelled.
     */
    responseControls: jsonb('response_controls')
      .$type<{ knowledgeOnly: boolean; askWhenUncertain: boolean; generalModelFallback: boolean }>()
      .notNull()
      .default({ knowledgeOnly: true, askWhenUncertain: true, generalModelFallback: false }),
    complianceScore: real('compliance_score'),
    pinned: boolean('pinned').notNull().default(false),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true, mode: 'date' }),
    version: rowVersion(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('consultations_tenant_idx').on(t.workspaceId, t.status, t.deletedAt),
    index('consultations_owner_idx').on(t.ownerUserId, t.updatedAt),
    index('consultations_pinned_idx').on(t.workspaceId, t.pinned),
  ],
);

export const consultationParticipants = pgTable(
  'consultation_participants',
  {
    id: id(),
    consultationId: text('consultation_id')
      .notNull()
      .references(() => consultations.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').notNull(),
    role: text('role').notNull().default('member'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('consultation_participants_key').on(t.consultationId, t.userId),
    index('consultation_participants_user_idx').on(t.userId),
  ],
);

export const consultationSources = pgTable(
  'consultation_sources',
  {
    id: id(),
    consultationId: text('consultation_id')
      .notNull()
      .references(() => consultations.id, { onDelete: 'cascade' }),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    /**
     * Pinned at selection time. This is what makes rule 10 of the acceptance list work:
     * a later source update does not retroactively change an existing consultation.
     */
    sourceVersionId: text('source_version_id')
      .notNull()
      .references(() => sourceVersions.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').notNull(),
    /** `governing` = the regulation/standard; `project` = the customer's own document. */
    role: text('role').notNull().default('governing'),
    pinned: boolean('pinned').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('consultation_sources_key').on(t.consultationId, t.sourceId),
    index('consultation_sources_source_idx').on(t.sourceId),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: id(),
    consultationId: text('consultation_id')
      .notNull()
      .references(() => consultations.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    role: text('role').notNull(),
    authorUserId: text('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    text: text('text').notNull().default(''),
    taskMode: text('task_mode'),
    answerStyle: text('answer_style'),
    /** The full StructuredAnswer. All three answer styles render from this one object. */
    answer: jsonb('answer').$type<Record<string, unknown> | null>(),
    parentMessageId: text('parent_message_id'),
    jobId: text('job_id'),
    feedback: text('feedback'),
    error: jsonb('error').$type<Record<string, unknown> | null>(),
    createdAt: createdAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('messages_consultation_idx').on(t.consultationId, t.createdAt),
    index('messages_tenant_idx').on(t.workspaceId),
    index('messages_job_idx').on(t.jobId),
  ],
);

export const messageAttachments = pgTable(
  'message_attachments',
  {
    id: id(),
    messageId: text('message_id').references(() => messages.id, { onDelete: 'cascade' }),
    consultationId: text('consultation_id')
      .notNull()
      .references(() => consultations.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').notNull(),
    sourceId: text('source_id').references(() => sources.id, { onDelete: 'set null' }),
    sourceVersionId: text('source_version_id').references(() => sourceVersions.id, {
      onDelete: 'set null',
    }),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    documentType: text('document_type').notNull().default('unknown'),
    sizeBytes: integer('size_bytes').notNull(),
    storageKey: text('storage_key').notNull(),
    sha256: text('sha256'),
    status: text('status').notNull().default('pending'),
    createdAt: createdAt(),
  },
  (t) => [
    index('message_attachments_message_idx').on(t.messageId),
    index('message_attachments_consultation_idx').on(t.consultationId),
  ],
);

export const complianceReviews = pgTable(
  'compliance_reviews',
  {
    id: id(),
    consultationId: text('consultation_id')
      .notNull()
      .references(() => consultations.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    messageId: text('message_id').references(() => messages.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('running'),
    scopeNote: text('scope_note'),
    projectSourceIds: jsonb('project_source_ids').$type<string[]>().notNull().default([]),
    governingSourceIds: jsonb('governing_source_ids').$type<string[]>().notNull().default([]),
    requirementsTotal: integer('requirements_total').notNull().default(0),
    compliantCount: integer('compliant_count').notNull().default(0),
    nonCompliantCount: integer('non_compliant_count').notNull().default(0),
    needsEvidenceCount: integer('needs_evidence_count').notNull().default(0),
    notAssessedCount: integer('not_assessed_count').notNull().default(0),
    evidenceCoverage: real('evidence_coverage'),
    confidence: real('confidence'),
    riskLevel: text('risk_level').notNull().default('none'),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    version: rowVersion(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('compliance_reviews_consultation_idx').on(t.consultationId),
    index('compliance_reviews_tenant_idx').on(t.workspaceId, t.status),
  ],
);

export const requirements = pgTable(
  'requirements',
  {
    id: id(),
    reviewId: text('review_id')
      .notNull()
      .references(() => complianceReviews.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').notNull(),
    sourceId: text('source_id').notNull(),
    sourceVersionId: text('source_version_id').notNull(),
    sectionId: text('section_id'),
    reference: text('reference').notNull(),
    title: text('title').notNull(),
    obligationText: text('obligation_text').notNull(),
    modality: text('modality').notNull().default('mandatory'),
    citationId: text('citation_id'),
    exceptions: jsonb('exceptions').$type<string[]>().notNull().default([]),
    crossReferences: jsonb('cross_references').$type<string[]>().notNull().default([]),
    ordinal: integer('ordinal').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index('requirements_review_idx').on(t.reviewId, t.ordinal),
    uniqueIndex('requirements_review_ref_key').on(t.reviewId, t.reference),
  ],
);

export const findings = pgTable(
  'findings',
  {
    id: id(),
    reviewId: text('review_id')
      .notNull()
      .references(() => complianceReviews.id, { onDelete: 'cascade' }),
    requirementId: text('requirement_id')
      .notNull()
      .references(() => requirements.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').notNull(),
    result: text('result').notNull().default('not_assessed'),
    risk: text('risk').notNull().default('none'),
    finding: text('finding').notNull(),
    projectEvidenceCitationIds: jsonb('project_evidence_citation_ids')
      .$type<string[]>()
      .notNull()
      .default([]),
    governingCitationIds: jsonb('governing_citation_ids').$type<string[]>().notNull().default([]),
    missingEvidence: jsonb('missing_evidence').$type<string[]>().notNull().default([]),
    conflicts: jsonb('conflicts')
      .$type<Array<{ description: string; citationIds: string[] }>>()
      .notNull()
      .default([]),
    recommendedAction: text('recommended_action'),
    confidence: real('confidence').notNull().default(0),
    reviewedByUserId: text('reviewed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('findings_review_idx').on(t.reviewId, t.result),
    uniqueIndex('findings_requirement_key').on(t.requirementId),
  ],
);

export const correctionPlans = pgTable(
  'correction_plans',
  {
    id: id(),
    consultationId: text('consultation_id')
      .notNull()
      .references(() => consultations.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    reviewId: text('review_id').references(() => complianceReviews.id, { onDelete: 'set null' }),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    sourceVersionId: text('source_version_id')
      .notNull()
      .references(() => sourceVersions.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('draft'),
    /** Chosen from the document's real capabilities; drives what the worker is asked to do. */
    outputStrategy: text('output_strategy').notNull().default('revised_edition'),
    /** Stated to the user BEFORE generation when faithful in-place editing is unsafe. */
    limitations: jsonb('limitations').$type<string[]>().notNull().default([]),
    signatureNotice: text('signature_notice'),
    instructions: text('instructions'),
    generatedArtifactId: text('generated_artifact_id'),
    redlineArtifactId: text('redline_artifact_id'),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    version: rowVersion(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('correction_plans_consultation_idx').on(t.consultationId),
    index('correction_plans_source_idx').on(t.sourceId),
  ],
);

export const correctionChanges = pgTable(
  'correction_changes',
  {
    id: id(),
    planId: text('plan_id')
      .notNull()
      .references(() => correctionPlans.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').notNull(),
    findingId: text('finding_id').references(() => findings.id, { onDelete: 'set null' }),
    ordinal: integer('ordinal').notNull(),
    locatorLabel: text('locator_label').notNull(),
    pageNumber: integer('page_number'),
    paragraphIndex: integer('paragraph_index'),
    sheetName: text('sheet_name'),
    cellRange: text('cell_range'),
    slideNumber: integer('slide_number'),
    charStart: integer('char_start'),
    charEnd: integer('char_end'),
    currentContent: text('current_content').notNull(),
    proposedContent: text('proposed_content').notNull(),
    /** A reviewer's hand-edit wins over the proposal when generating. */
    editedContent: text('edited_content'),
    reason: text('reason').notNull(),
    governingCitationId: text('governing_citation_id'),
    risk: text('risk').notNull().default('medium'),
    confidence: real('confidence').notNull().default(0),
    /** Only `accepted` and `edited` rows are written into the derivative document. */
    status: text('status').notNull().default('proposed'),
    decidedByUserId: text('decided_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('correction_changes_plan_idx').on(t.planId, t.ordinal),
    index('correction_changes_status_idx').on(t.planId, t.status),
  ],
);

export const generatedArtifacts = pgTable(
  'generated_artifacts',
  {
    id: id(),
    organizationId: text('organization_id').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    consultationId: text('consultation_id').references(() => consultations.id, {
      onDelete: 'set null',
    }),
    reviewId: text('review_id').references(() => complianceReviews.id, { onDelete: 'set null' }),
    planId: text('plan_id').references(() => correctionPlans.id, { onDelete: 'set null' }),
    /** Lineage back to the exact original bytes this artifact derives from. */
    sourceId: text('source_id').references(() => sources.id, { onDelete: 'set null' }),
    sourceVersionId: text('source_version_id').references(() => sourceVersions.id, {
      onDelete: 'set null',
    }),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    documentType: text('document_type').notNull(),
    contentType: text('content_type').notNull(),
    storageKey: text('storage_key').notNull(),
    sizeBytes: integer('size_bytes').notNull().default(0),
    sha256: text('sha256').notNull(),
    status: text('status').notNull().default('generating'),
    /** Exact model/config that produced this artifact — required for audit. */
    generatorDescriptor: text('generator_descriptor').notNull().default(''),
    changeLog: jsonb('change_log').$type<Array<Record<string, unknown>>>().notNull().default([]),
    /** e.g. signature invalidation notices, OCR confidence caveats. */
    disclosures: jsonb('disclosures').$type<string[]>().notNull().default([]),
    validation: jsonb('validation').$type<Record<string, unknown>>().notNull().default({}),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    retainUntil: timestamp('retain_until', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('generated_artifacts_tenant_idx').on(t.workspaceId, t.kind, t.deletedAt),
    index('generated_artifacts_consultation_idx').on(t.consultationId),
    index('generated_artifacts_lineage_idx').on(t.sourceVersionId),
  ],
);

/** Report rows are the user-facing library entries around an artifact. */
export const reports = pgTable(
  'reports',
  {
    id: id(),
    organizationId: text('organization_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    artifactId: text('artifact_id')
      .notNull()
      .references(() => generatedArtifacts.id, { onDelete: 'cascade' }),
    consultationId: text('consultation_id').references(() => consultations.id, {
      onDelete: 'set null',
    }),
    reviewId: text('review_id').references(() => complianceReviews.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    summary: text('summary'),
    sharedWith: jsonb('shared_with').$type<string[]>().notNull().default([]),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    deletedAt: deletedAt(),
  },
  (t) => [index('reports_tenant_idx').on(t.workspaceId, t.kind, t.deletedAt)],
);
