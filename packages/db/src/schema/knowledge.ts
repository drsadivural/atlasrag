import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from 'drizzle-orm/pg-core';
import { createdAt, deletedAt, id, rowVersion, updatedAt } from './columns.js';
import { groups, users, workspaces } from './tenancy.js';

/** Embedding width. Changing this requires a migration that rebuilds the vector column. */
export const EMBEDDING_DIMENSIONS = 768;

export const sources = pgTable(
  'sources',
  {
    id: id(),
    /** Denormalised tenant key so every query can filter on it without a join. */
    organizationId: text('organization_id').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    documentType: text('document_type').notNull().default('unknown'),
    status: text('status').notNull().default('pending'),
    /** Points at the version that answers should currently cite. */
    currentVersionId: text('current_version_id'),
    connectorId: text('connector_id'),
    connectorKind: text('connector_kind'),
    externalId: text('external_id'),
    externalUrl: text('external_url'),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    accessScope: text('access_scope').notNull().default('workspace'),
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    /**
     * False while a file is only a consultation input. Retrieval for knowledge questions
     * ignores unpromoted uploads, which is what keeps rule 6 of the brief true.
     */
    promotedToKnowledge: boolean('promoted_to_knowledge').notNull().default(false),
    effectiveDate: timestamp('effective_date', { withTimezone: true, mode: 'date' }),
    supersededBySourceId: text('superseded_by_source_id'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true, mode: 'date' }),
    failureReason: text('failure_reason'),
    quarantine: jsonb('quarantine').$type<Record<string, unknown> | null>(),
    version: rowVersion(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('sources_tenant_idx').on(t.workspaceId, t.status, t.deletedAt),
    index('sources_org_idx').on(t.organizationId),
    index('sources_owner_idx').on(t.ownerUserId),
    index('sources_connector_idx').on(t.connectorId),
    index('sources_title_trgm_idx').using('gin', sql`to_tsvector('english', ${t.title})`),
  ],
);

export const sourceConnectors = pgTable(
  'source_connectors',
  {
    id: id(),
    organizationId: text('organization_id').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    displayName: text('display_name').notNull(),
    accountEmail: text('account_email'),
    /** OAuth refresh token / API credential, AES-256-GCM encrypted. Never returned by an API. */
    credentialEncrypted: text('credential_encrypted'),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').notNull().default('active'),
    lastError: text('last_error'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true, mode: 'date' }),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    version: rowVersion(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [index('source_connectors_workspace_idx').on(t.workspaceId, t.kind)],
);

export const sourceSyncRules = pgTable(
  'source_sync_rules',
  {
    id: id(),
    connectorId: text('connector_id')
      .notNull()
      .references(() => sourceConnectors.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').notNull(),
    includeGlobs: jsonb('include_globs').$type<string[]>().notNull().default([]),
    excludeGlobs: jsonb('exclude_globs').$type<string[]>().notNull().default([]),
    fileTypes: jsonb('file_types').$type<string[]>().notNull().default([]),
    maxDepth: integer('max_depth').notNull().default(1),
    maxPages: integer('max_pages').notNull().default(25),
    allowedDomains: jsonb('allowed_domains').$type<string[]>().notNull().default([]),
    respectRobots: boolean('respect_robots').notNull().default(true),
    autoSync: boolean('auto_sync').notNull().default(false),
    syncCron: text('sync_cron'),
    nextRunAt: timestamp('next_run_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('source_sync_rules_connector_idx').on(t.connectorId)],
);

export const sourceVersions = pgTable(
  'source_versions',
  {
    id: id(),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    version: text('version').notNull(),
    versionNumber: integer('version_number').notNull(),
    /** Checksum of the immutable original bytes. Identical bytes never create a new version. */
    sha256: text('sha256').notNull(),
    /** Checksum of normalised extracted text; catches re-encoded but identical documents. */
    normalizedSha256: text('normalized_sha256'),
    storageKey: text('storage_key').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    pages: integer('pages'),
    status: text('status').notNull().default('pending'),
    /** A version is only cited once it has been promoted after validation. */
    promotedAt: timestamp('promoted_at', { withTimezone: true, mode: 'date' }),
    isCurrent: boolean('is_current').notNull().default(false),
    ocrApplied: boolean('ocr_applied').notNull().default(false),
    ocrConfidence: real('ocr_confidence'),
    extractionCoverage: real('extraction_coverage'),
    structure: jsonb('structure').$type<Record<string, number>>().notNull().default({}),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    notes: text('notes'),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    uniqueIndex('source_versions_sha_key').on(t.sourceId, t.sha256),
    uniqueIndex('source_versions_number_key').on(t.sourceId, t.versionNumber),
    index('source_versions_source_idx').on(t.sourceId, t.isCurrent),
    index('source_versions_workspace_idx').on(t.workspaceId),
  ],
);

export const sourcePermissions = pgTable(
  'source_permissions',
  {
    id: id(),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').notNull(),
    scope: text('scope').notNull(), // workspace | group | users
    groupId: text('group_id').references(() => groups.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    capability: text('capability').notNull().default('read'),
    createdAt: createdAt(),
  },
  (t) => [
    index('source_permissions_source_idx').on(t.sourceId),
    index('source_permissions_user_idx').on(t.userId),
    index('source_permissions_group_idx').on(t.groupId),
  ],
);

export const sourcePages = pgTable(
  'source_pages',
  {
    id: id(),
    sourceVersionId: text('source_version_id')
      .notNull()
      .references(() => sourceVersions.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').notNull(),
    pageNumber: integer('page_number').notNull(),
    /** Verbatim extracted text. Citation verification re-checks excerpts against this. */
    text: text('text').notNull(),
    width: real('width'),
    height: real('height'),
    sheetName: text('sheet_name'),
    slideNumber: integer('slide_number'),
    ocrApplied: boolean('ocr_applied').notNull().default(false),
    ocrConfidence: real('ocr_confidence'),
    /** Per-word boxes in normalised page coordinates, used to highlight an exact passage. */
    wordBoxes: jsonb('word_boxes')
      .$type<Array<{ t: string; x: number; y: number; w: number; h: number }>>()
      .notNull()
      .default([]),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('source_pages_key').on(t.sourceVersionId, t.pageNumber),
    index('source_pages_workspace_idx').on(t.workspaceId),
  ],
);

export const sourceSections = pgTable(
  'source_sections',
  {
    id: id(),
    sourceVersionId: text('source_version_id')
      .notNull()
      .references(() => sourceVersions.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').notNull(),
    parentId: text('parent_id'),
    ordinal: integer('ordinal').notNull(),
    level: integer('level').notNull().default(1),
    kind: text('kind').notNull().default('heading'), // heading | clause | table | definition | list
    chapter: text('chapter'),
    section: text('section'),
    clause: text('clause'),
    title: text('title').notNull(),
    /**
     * The section's own text, stored so requirement extraction reads the real obligation
     * wording rather than trying to reassemble it from derived chunks.
     */
    body: text('body').notNull().default(''),
    headingPath: jsonb('heading_path').$type<string[]>().notNull().default([]),
    pageNumber: integer('page_number'),
    charStart: integer('char_start').notNull().default(0),
    charEnd: integer('char_end').notNull().default(0),
    /** "shall"/"must" vs "should" vs "may" — drives requirement extraction. */
    modality: text('modality'),
    isRequirement: boolean('is_requirement').notNull().default(false),
    effectiveDate: timestamp('effective_date', { withTimezone: true, mode: 'date' }),
    supersededNote: text('superseded_note'),
    crossReferences: jsonb('cross_references').$type<string[]>().notNull().default([]),
    exceptions: jsonb('exceptions').$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [
    index('source_sections_version_idx').on(t.sourceVersionId, t.ordinal),
    index('source_sections_clause_idx').on(t.sourceVersionId, t.clause),
    index('source_sections_requirement_idx').on(t.sourceVersionId, t.isRequirement),
    index('source_sections_workspace_idx').on(t.workspaceId),
  ],
);

export const sourceChunks = pgTable(
  'source_chunks',
  {
    id: id(),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    sourceVersionId: text('source_version_id')
      .notNull()
      .references(() => sourceVersions.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    sectionId: text('section_id').references(() => sourceSections.id, { onDelete: 'set null' }),
    ordinal: integer('ordinal').notNull(),
    /**
     * Chunk body, VERBATIM from the extracted page text.
     *
     * Nothing synthetic is ever concatenated here, because citation verification re-checks
     * excerpts taken from this column against the stored page text. Heading context lives
     * in `headingText` and is folded into the search index and the embedding input instead.
     */
    content: text('content').notNull(),
    /** Parent heading path, indexed for search but never quoted as source text. */
    headingText: text('heading_text').notNull().default(''),
    tokenCount: integer('token_count').notNull().default(0),
    pageNumber: integer('page_number'),
    pageEnd: integer('page_end'),
    sheetName: text('sheet_name'),
    cellRange: text('cell_range'),
    slideNumber: integer('slide_number'),
    chapter: text('chapter'),
    section: text('section'),
    clause: text('clause'),
    headingPath: jsonb('heading_path').$type<string[]>().notNull().default([]),
    paragraphIndex: integer('paragraph_index'),
    charStart: integer('char_start').notNull().default(0),
    charEnd: integer('char_end').notNull().default(0),
    kind: text('kind').notNull().default('prose'), // prose | table | list | definition
    createdAt: createdAt(),
  },
  (t) => [
    index('source_chunks_version_idx').on(t.sourceVersionId, t.ordinal),
    index('source_chunks_tenant_idx').on(t.workspaceId, t.sourceId),
    index('source_chunks_page_idx').on(t.sourceVersionId, t.pageNumber),
    /**
     * GIN index over exactly the expression the lexical query uses, so the BM25-equivalent
     * half of hybrid retrieval never falls back to a sequential scan on a large corpus.
     */
    index('source_chunks_fts_idx').using(
      'gin',
      sql`to_tsvector('english', coalesce(${t.headingText}, '') || ' ' || ${t.content})`,
    ),
  ],
);

export const embeddings = pgTable(
  'embeddings',
  {
    id: id(),
    chunkId: text('chunk_id')
      .notNull()
      .references(() => sourceChunks.id, { onDelete: 'cascade' }),
    sourceVersionId: text('source_version_id')
      .notNull()
      .references(() => sourceVersions.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').notNull(),
    organizationId: text('organization_id').notNull(),
    model: text('model').notNull(),
    dimensions: integer('dimensions').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('embeddings_chunk_key').on(t.chunkId, t.model),
    index('embeddings_tenant_idx').on(t.workspaceId),
    index('embeddings_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

export const citations = pgTable(
  'citations',
  {
    id: id(),
    organizationId: text('organization_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    messageId: text('message_id'),
    reviewId: text('review_id'),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    sourceVersionId: text('source_version_id')
      .notNull()
      .references(() => sourceVersions.id, { onDelete: 'cascade' }),
    chunkId: text('chunk_id').references(() => sourceChunks.id, { onDelete: 'set null' }),
    sourceSha256: text('source_sha256').notNull(),
    documentTitle: text('document_title').notNull(),
    documentType: text('document_type').notNull(),
    pageNumber: integer('page_number'),
    sheetName: text('sheet_name'),
    cellRange: text('cell_range'),
    slideNumber: integer('slide_number'),
    shapeName: text('shape_name'),
    chapter: text('chapter'),
    section: text('section'),
    clause: text('clause'),
    headingPath: jsonb('heading_path').$type<string[]>().notNull().default([]),
    paragraphIndex: integer('paragraph_index'),
    charStart: integer('char_start'),
    charEnd: integer('char_end'),
    urlFragment: text('url_fragment'),
    boundingBoxes: jsonb('bounding_boxes')
      .$type<Array<{ page: number; x: number; y: number; width: number; height: number }>>()
      .notNull()
      .default([]),
    /** Verbatim excerpt. Re-checked against source_pages before the answer is persisted. */
    supportingExcerpt: text('supporting_excerpt').notNull(),
    retrievalScore: doublePrecision('retrieval_score').notNull().default(0),
    rerankScore: doublePrecision('rerank_score').notNull().default(0),
    entailment: text('entailment').notNull().default('context'),
    verified: boolean('verified').notNull().default(false),
    verificationMethod: text('verification_method').notNull().default('failed'),
    effectiveDate: timestamp('effective_date', { withTimezone: true, mode: 'date' }),
    supersededBy: text('superseded_by'),
    createdAt: createdAt(),
  },
  (t) => [
    index('citations_message_idx').on(t.messageId),
    index('citations_review_idx').on(t.reviewId),
    index('citations_tenant_idx').on(t.workspaceId),
    index('citations_source_version_idx').on(t.sourceVersionId),
  ],
);
