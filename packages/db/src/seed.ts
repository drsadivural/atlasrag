/**
 * Development seed.
 *
 * Creates a workspace that exercises every state the UI has to render: sources that are
 * ready, processing, needing review and failed; a completed compliance review with a mix
 * of outcomes; generated artifacts; and an audit trail. It uses the real ingestion path
 * where the document worker is reachable, so what appears on screen is genuinely indexed
 * data rather than fixtures pasted into tables.
 */
import { loadRepositoryEnv } from './load-env.js';

loadRepositoryEnv();
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from './client.js';
import { newId } from './ids.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const OWNER_EMAIL = process.env.SEED_EMAIL ?? 'dr.sadi@uxe.example.com';
const OWNER_PASSWORD = process.env.SEED_PASSWORD ?? 'Tr0ubad0ur-Nimbus-42';
const WORKER_URL = process.env.DOCUMENT_WORKER_URL ?? 'http://127.0.0.1:8099';
const WORKER_TOKEN = process.env.DOCUMENT_WORKER_TOKEN ?? '';

const { db, sql, close } = createDb({ url: DATABASE_URL });

/**
 * postgres-js cannot infer a parameter type for a Date in a nullable position, so every
 * timestamp is bound as an ISO string and cast explicitly in SQL.
 */
function ts(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

async function main() {
  console.log('Seeding development data…');

  const existing = await sql<
    { id: string }[]
  >`SELECT id FROM users WHERE lower(email) = lower(${OWNER_EMAIL})`;
  if (existing.length > 0) {
    console.log(`  ${OWNER_EMAIL} already exists. Run "pnpm db:reset" first to reseed.`);
    return;
  }

  // --- Identity -----------------------------------------------------------
  const { hashPassword } = await import('@uxe/auth');
  const orgId = newId();
  const workspaceId = newId();
  const ownerId = newId();
  const reviewerId = newId();
  const readOnlyId = newId();

  await sql`INSERT INTO organizations (id, name, slug) VALUES (${orgId}, 'UXE Consulting', 'uxe-consulting')`;
  await sql`
    INSERT INTO workspaces (id, organization_id, name, slug, is_default, settings)
    VALUES (${workspaceId}, ${orgId}, 'UAE Workspace', 'uae', true, ${JSON.stringify(defaultSettings())}::jsonb)
  `;

  const passwordHash = await hashPassword(OWNER_PASSWORD);
  const people: Array<[string, string, string, string]> = [
    [ownerId, OWNER_EMAIL, 'Dr Sadi Vural', 'owner'],
    [reviewerId, 'amina.reviewer@uxe.example.com', 'Amina Haddad', 'reviewer'],
    [readOnlyId, 'guest.auditor@uxe.example.com', 'Guest Auditor', 'read_only'],
  ];

  for (const [id, email, fullName, role] of people) {
    await sql`
      INSERT INTO users (id, email, full_name, password_hash, email_verified_at, title, last_active_at)
      VALUES (${id}, ${email}, ${fullName}, ${passwordHash}, now(), ${roleTitle(role)}, now())
    `;
    await sql`
      INSERT INTO memberships (id, organization_id, workspace_id, user_id, role, status, joined_at)
      VALUES (${newId()}, ${orgId}, ${workspaceId}, ${id}, ${role}, 'active', now())
    `;
  }
  console.log(`  users: ${people.length}`);

  // --- Sources ------------------------------------------------------------
  const ctx = {
    organizationId: orgId,
    workspaceId,
    userId: ownerId,
    role: 'owner' as const,
    groupIds: [] as string[],
    traceId: 'seed',
  };

  const workerReachable = await pingWorker();
  if (!workerReachable) {
    console.warn('  document worker unreachable — sources will be seeded without extracted text.');
  }

  const documents: Array<{
    file: string;
    title: string;
    type: string;
    tags: string[];
    status: string;
    role: 'governing' | 'project';
    failureReason?: string;
  }> = [
    {
      file: 'tests/fixtures/documents/regulation-native.pdf',
      title: 'UAE Fire and Life Safety Code of Practice 2018',
      type: 'pdf',
      tags: ['regulation', 'code', 'fire-safety'],
      status: 'ready',
      role: 'governing',
    },
    {
      file: 'tests/fixtures/documents/policy.docx',
      title: 'Employment Policy 2026',
      type: 'docx',
      tags: ['policy', 'hr'],
      status: 'ready',
      role: 'governing',
    },
    {
      file: 'tests/fixtures/documents/playbook.pptx',
      title: 'Supplier Agreement Playbook',
      type: 'pptx',
      tags: ['playbook', 'legal'],
      status: 'ready',
      role: 'governing',
    },
    {
      file: 'tests/fixtures/documents/vendors.xlsx',
      title: 'Approved Vendor List Q2 2026',
      type: 'xlsx',
      tags: ['procurement'],
      status: 'ready',
      role: 'governing',
    },
    {
      file: 'tests/fixtures/documents/scanned.pdf',
      title: 'Fire Drill Procedure – HQ',
      type: 'pdf',
      tags: ['procedure'],
      status: 'needs_review',
      role: 'governing',
    },
    {
      file: 'tests/fixtures/documents/project-plan.pdf',
      title: 'Evacuation Plan – Tower A',
      type: 'pdf',
      tags: ['project', 'evacuation'],
      status: 'ready',
      role: 'project',
    },
  ];

  const sourceIds: Record<string, string> = {};

  for (const doc of documents) {
    const sourceId = newId();
    sourceIds[doc.title] = sourceId;

    await sql`
      INSERT INTO sources (id, organization_id, workspace_id, title, document_type, status, tags, access_scope,
                           owner_user_id, promoted_to_knowledge, effective_date, last_synced_at)
      VALUES (${sourceId}, ${orgId}, ${workspaceId}, ${doc.title}, ${doc.type}, ${doc.status},
              ${JSON.stringify(doc.tags)}::jsonb, 'workspace', ${ownerId}, true,
              ${ts(doc.role === 'governing' ? new Date('2018-01-01') : null)}::timestamptz, now())
    `;
    await sql`
      INSERT INTO source_permissions (id, source_id, workspace_id, scope, capability)
      VALUES (${newId()}, ${sourceId}, ${workspaceId}, 'workspace', 'read')
    `;

    if (workerReachable) {
      await ingest(ctx, sourceId, doc.file, doc.type, doc.status === 'ready');
    }

    // Record the job that did the work, so the indexing-pipeline panel shows the real
    // stage-by-stage state rather than an empty 0/0 for every stage.
    await recordIngestJob(ctx, sourceId, doc.status);
  }

  // A deliberately failed source, so the failure and retry affordances are visible.
  const failedId = newId();
  await sql`
    INSERT INTO sources (id, organization_id, workspace_id, title, document_type, status, tags, access_scope,
                         owner_user_id, promoted_to_knowledge, failure_reason, last_synced_at)
    VALUES (${failedId}, ${orgId}, ${workspaceId}, 'Exit Signage Specifications', 'docx', 'failed',
            '["specification"]'::jsonb, 'workspace', ${ownerId}, true,
            'Upload failed: the file ended before the declared length was received. Re-upload to retry.', now())
  `;
  await sql`INSERT INTO source_permissions (id, source_id, workspace_id, scope, capability) VALUES (${newId()}, ${failedId}, ${workspaceId}, 'workspace', 'read')`;

  // A source still indexing, so the progress states are visible.
  const processingId = newId();
  await sql`
    INSERT INTO sources (id, organization_id, workspace_id, title, document_type, status, tags, access_scope,
                         owner_user_id, promoted_to_knowledge, last_synced_at)
    VALUES (${processingId}, ${orgId}, ${workspaceId}, 'ISO 9001:2015 Quality Management', 'pdf', 'indexing',
            '["standard","iso"]'::jsonb, 'workspace', ${ownerId}, true, now())
  `;
  await sql`INSERT INTO source_permissions (id, source_id, workspace_id, scope, capability) VALUES (${newId()}, ${processingId}, ${workspaceId}, 'workspace', 'read')`;

  await recordIngestJob(ctx, failedId, 'failed');
  await recordIngestJob(ctx, processingId, 'indexing');

  console.log(`  sources: ${documents.length + 2}`);

  // --- Consultations ------------------------------------------------------
  const consultations = [
    { title: 'UAE Fire Code Review', status: 'action_required', score: 68, pinned: true, days: 0 },
    { title: 'Employment Policy Audit', status: 'report_ready', score: 94, pinned: false, days: 1 },
    {
      title: 'Supplier Contract Summary',
      status: 'report_ready',
      score: 96,
      pinned: false,
      days: 2,
    },
    { title: 'Health & Safety Compliance', status: 'active', score: null, pinned: false, days: 9 },
    { title: 'ISO 9001 Gap Analysis', status: 'draft', score: null, pinned: false, days: 21 },
  ];

  const consultationIds: string[] = [];
  for (const [index, entry] of consultations.entries()) {
    const id = newId();
    consultationIds.push(id);
    const createdAt = new Date(Date.now() - entry.days * 86_400_000);
    await sql`
      INSERT INTO consultations (id, organization_id, workspace_id, title, status, task_mode, answer_style,
                                 compliance_score, pinned, owner_user_id, last_message_at, created_at, updated_at)
      VALUES (${id}, ${orgId}, ${workspaceId}, ${entry.title}, ${entry.status},
              ${index === 0 ? 'check_compliance' : 'ask'}, 'optimal', ${entry.score}, ${entry.pinned},
              ${ownerId}, ${ts(createdAt)}::timestamptz, ${ts(createdAt)}::timestamptz, ${ts(createdAt)}::timestamptz)
    `;
    await sql`
      INSERT INTO consultation_participants (id, consultation_id, user_id, workspace_id, role)
      VALUES (${newId()}, ${id}, ${ownerId}, ${workspaceId}, 'owner')
    `;
  }
  console.log(`  consultations: ${consultations.length}`);

  // --- A real compliance review on the flagship consultation ---------------
  // Runs the actual pipeline rather than inserting canned findings, so the seeded
  // workspace shows genuine verified citations that open at their real page.
  const flagshipId = consultationIds[0];
  const regulationId = sourceIds['UAE Fire and Life Safety Code of Practice 2018'];
  const projectId = sourceIds['Evacuation Plan – Tower A'];

  if (workerReachable && flagshipId && regulationId && projectId) {
    await runSeedReview(ctx, flagshipId, regulationId, projectId, ownerId);
  }

  // Spread activity across the last 30 days so the dashboard chart has a shape.
  for (let day = 29; day >= 0; day -= 1) {
    const count = Math.max(0, Math.round(2 + Math.sin(day / 4) * 2 + (29 - day) / 12));
    for (let i = 0; i < count; i += 1) {
      const at = new Date(Date.now() - day * 86_400_000 - i * 3_600_000);
      await sql`
        INSERT INTO consultations (id, organization_id, workspace_id, title, status, task_mode, answer_style,
                                   owner_user_id, created_at, updated_at, deleted_at)
        VALUES (${newId()}, ${orgId}, ${workspaceId}, ${'Archived consultation ' + day + '-' + i}, 'archived',
                'ask', 'optimal', ${ownerId}, ${ts(at)}::timestamptz, ${ts(at)}::timestamptz, ${ts(at)}::timestamptz)
      `;
    }
  }

  // --- Audit --------------------------------------------------------------
  const auditEntries: Array<[string, string, string, string]> = [
    ['auth.login', 'auth', 'success', 'Dr Sadi Vural signed in.'],
    ['source.upload.requested', 'source', 'success', 'Requested upload tickets for 5 file(s).'],
    [
      'source.updated',
      'source',
      'success',
      'Updated source "UAE Fire and Life Safety Code of Practice 2018".',
    ],
    [
      'consultation.created',
      'consultation',
      'success',
      'Started consultation "UAE Fire Code Review".',
    ],
    [
      'review.completed',
      'review',
      'success',
      'Compliance review finished with 1 non-compliant requirement.',
    ],
    [
      'artifact.downloaded',
      'artifact',
      'success',
      'Downloaded "UAE Fire Code Review - compliance report".',
    ],
    [
      'member.invited',
      'permission',
      'success',
      'Invited amina.reviewer@uxe.example.com as reviewer.',
    ],
    ['auth.login.failed', 'auth', 'failure', 'Failed sign-in attempt (1 consecutive).'],
  ];

  for (const [index, [action, category, result, summary]] of auditEntries.entries()) {
    await sql`
      INSERT INTO audit_events (id, organization_id, workspace_id, actor_user_id, actor_name, action, category,
                                result, trace_id, summary, ip_address, created_at)
      VALUES (${newId()}, ${orgId}, ${workspaceId}, ${ownerId}, 'Dr Sadi Vural', ${action}, ${category},
              ${result}, ${newId().toLowerCase()}, ${summary}, '203.0.113.42',
              ${ts(new Date(Date.now() - index * 3_600_000))}::timestamptz)
    `;
  }
  console.log(`  audit events: ${auditEntries.length}`);

  await sql`
    INSERT INTO model_configurations (id, organization_id, workspace_id, capability, provider, model,
                                      is_primary, enabled, health, health_detail, last_checked_at)
    VALUES (${newId()}, ${orgId}, ${workspaceId}, 'chat', 'deterministic', 'uxe-extractive-v1', true, true,
            'healthy', 'Local extractive engine; no credential required.', now()),
           (${newId()}, ${orgId}, ${workspaceId}, 'embedding', 'deterministic', 'uxe-hashed-ngram-v1', true, true,
            'healthy', 'Local embedding; no credential required.', now())
  `;

  console.log('');
  console.log('Seed complete.');
  console.log(`  Sign in as: ${OWNER_EMAIL}`);
  console.log(`  Password:   ${OWNER_PASSWORD}`);
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Executes a real compliance review against the seeded documents.
 *
 * Everything the UI then displays — findings, citations, coverage, confidence — is the
 * genuine output of the retrieval and verification pipeline, so the seeded workspace is a
 * working demonstration rather than a set of hard-coded strings.
 */
async function runSeedReview(
  ctx: {
    organizationId: string;
    workspaceId: string;
    userId: string;
    role: 'owner';
    groupIds: string[];
    traceId: string;
  },
  consultationId: string,
  regulationSourceId: string,
  projectSourceId: string,
  ownerId: string,
): Promise<void> {
  const { runComplianceReview } = await import('@uxe/rag');
  const { DeterministicChatProvider, DeterministicEmbeddingProvider } = await import('@uxe/rag');
  const { RetrievalRepository } = await import('./repositories/retrieval.js');
  const { ConsultationRepository } = await import('./repositories/consultations.js');

  const versions = await sql<
    { id: string; source_id: string; pages: number | null; version: string }[]
  >`
    SELECT id, source_id, pages, version FROM source_versions
    WHERE source_id IN (${regulationSourceId}, ${projectSourceId}) AND is_current = true
  `;

  const scope = versions.map((v) => ({
    sourceId: v.source_id,
    sourceVersionId: v.id,
    role: (v.source_id === regulationSourceId ? 'governing' : 'project') as 'governing' | 'project',
    title:
      v.source_id === regulationSourceId
        ? 'UAE Fire and Life Safety Code of Practice 2018'
        : 'Evacuation Plan – Tower A',
    version: v.version,
    pages: v.pages,
    effectiveDate: v.source_id === regulationSourceId ? new Date('2018-01-01') : null,
    tags: v.source_id === regulationSourceId ? ['regulation', 'code'] : ['project'],
    promoted: true,
    superseded: false,
  }));

  if (scope.length < 2) return;

  for (const entry of scope) {
    await sql`
      INSERT INTO consultation_sources (id, consultation_id, source_id, source_version_id, workspace_id, role)
      VALUES (${newId()}, ${consultationId}, ${entry.sourceId}, ${entry.sourceVersionId}, ${ctx.workspaceId}, ${entry.role})
      ON CONFLICT DO NOTHING
    `;
  }

  const question =
    'Does the uploaded evacuation plan comply with the UAE Fire and Life Safety Code? Give me the key gaps.';
  const userMessageId = newId();
  const assistantMessageId = newId();
  const reviewId = newId();

  await sql`
    INSERT INTO messages (id, consultation_id, organization_id, workspace_id, role, author_user_id, text, task_mode, answer_style)
    VALUES (${userMessageId}, ${consultationId}, ${ctx.organizationId}, ${ctx.workspaceId}, 'user', ${ownerId},
            ${question}, 'check_compliance', 'optimal')
  `;
  await sql`
    INSERT INTO compliance_reviews (id, consultation_id, organization_id, workspace_id, status, project_source_ids,
                                    governing_source_ids, created_by_user_id)
    VALUES (${reviewId}, ${consultationId}, ${ctx.organizationId}, ${ctx.workspaceId}, 'running',
            ${JSON.stringify([projectSourceId])}::jsonb, ${JSON.stringify([regulationSourceId])}::jsonb, ${ownerId})
  `;

  const review = await runComplianceReview(
    ctx as never,
    {
      repo: new RetrievalRepository(db),
      embedder: new DeterministicEmbeddingProvider(),
      chat: new DeterministicChatProvider(),
    },
    scope,
    {
      task: 'check_compliance',
      answerStyle: 'optimal',
      knowledgeOnly: true,
      askWhenUncertain: true,
      generalModelFallback: false,
      minimumEvidenceThreshold: 0.3,
      consultantName: 'Ayumi',
      locale: 'en',
      idFactory: newId,
      nonce: newId(),
      scopeNote: 'Fire and life safety review of the Tower A evacuation plan.',
    },
  );

  const consultations = new ConsultationRepository(db);
  await consultations.saveCitations(
    ctx as never,
    review.citations.map((c) => ({
      id: c.citationId,
      reviewId,
      messageId: assistantMessageId,
      sourceId: c.sourceId,
      sourceVersionId: c.sourceVersionId,
      sourceSha256: c.sourceSha256,
      documentTitle: c.documentTitle,
      documentType: c.documentType,
      pageNumber: c.pageNumber,
      sheetName: c.sheetName,
      cellRange: c.cellRange,
      slideNumber: c.slideNumber,
      shapeName: c.shapeName,
      chapter: c.chapter,
      section: c.section,
      clause: c.clause,
      headingPath: c.headingPath,
      paragraphIndex: c.paragraphIndex,
      charStart: c.charStart,
      charEnd: c.charEnd,
      urlFragment: c.urlFragment,
      boundingBoxes: c.boundingBoxes,
      supportingExcerpt: c.supportingExcerpt,
      retrievalScore: c.retrievalScore,
      rerankScore: c.rerankScore,
      entailment: c.entailment,
      verified: c.verified,
      verificationMethod: c.verificationMethod,
      effectiveDate: c.effectiveDate ? new Date(c.effectiveDate) : null,
    })),
  );

  await consultations.saveRequirements(
    ctx as never,
    reviewId,
    review.requirements.map((r, index) => ({
      id: r.requirementId,
      sourceId: r.sourceId,
      sourceVersionId: r.sourceVersionId,
      sectionId: null,
      reference: r.reference,
      title: r.title,
      obligationText: r.obligationText,
      modality: r.modality,
      citationId: r.citationId,
      exceptions: r.exceptions,
      crossReferences: r.crossReferences,
      ordinal: index,
    })),
  );

  await consultations.saveFindings(
    ctx as never,
    reviewId,
    review.findings.map((f) => ({
      id: f.findingId,
      requirementId: f.requirementId,
      result: f.result,
      risk: f.risk,
      finding: f.finding,
      projectEvidenceCitationIds: f.projectEvidenceCitationIds,
      governingCitationIds: f.governingCitationIds,
      missingEvidence: f.missingEvidence,
      conflicts: f.conflicts,
      recommendedAction: f.recommendedAction,
      confidence: f.confidence,
    })),
  );

  await sql`
    INSERT INTO messages (id, consultation_id, organization_id, workspace_id, role, text, task_mode, answer_style, answer)
    VALUES (${assistantMessageId}, ${consultationId}, ${ctx.organizationId}, ${ctx.workspaceId}, 'assistant',
            ${review.answer.headline}, 'check_compliance', 'optimal', ${JSON.stringify(review.answer)}::jsonb)
  `;

  const total = review.requirements.length || 1;
  await sql`
    UPDATE compliance_reviews SET status = 'complete', message_id = ${assistantMessageId},
      requirements_total = ${review.requirements.length}, compliant_count = ${review.counts.compliant},
      non_compliant_count = ${review.counts.nonCompliant}, needs_evidence_count = ${review.counts.needsEvidence},
      not_assessed_count = ${review.counts.notAssessed}, evidence_coverage = ${review.answer.coverage.score},
      confidence = ${review.answer.confidence.overall}, risk_level = ${review.answer.riskLevel}
    WHERE id = ${reviewId}
  `;
  await sql`
    UPDATE consultations SET compliance_score = ${(review.counts.compliant / total) * 100},
      last_message_at = now(), task_mode = 'check_compliance' WHERE id = ${consultationId}
  `;

  console.log(
    `  review: ${review.requirements.length} requirement(s) — ${review.counts.compliant} met, ` +
      `${review.counts.nonCompliant} not met, ${review.counts.needsEvidence} awaiting evidence`,
  );
}

const INGEST_STAGES = [
  ['malware_scan', 'Malware scan'],
  ['extraction', 'Extraction / OCR'],
  ['structure_analysis', 'Structure analysis'],
  ['chunking', 'Chunking'],
  ['embeddings', 'Embeddings'],
  ['lexical_index', 'Lexical index'],
  ['citation_map', 'Citation map'],
  ['validation', 'Validation'],
] as const;

/**
 * Writes the processing job that corresponds to a seeded source.
 *
 * The seed indexes documents directly for speed, so without this the pipeline panel would
 * truthfully report that no jobs had ever run — which is accurate but useless as a
 * development fixture. The recorded stages mirror what the real pipeline would have done
 * for that source's final status.
 */
async function recordIngestJob(
  ctx: { organizationId: string; workspaceId: string; userId: string },
  sourceId: string,
  status: string,
): Promise<void> {
  const failedAt =
    status === 'failed' ? 'malware_scan' : status === 'needs_review' ? 'validation' : null;
  const runningAt = status === 'indexing' ? 'embeddings' : null;

  let reached = true;
  const stages = INGEST_STAGES.map(([key, label]) => {
    if (!reached) return { key, label, state: 'pending', detail: null, percent: null };
    if (key === failedAt) {
      reached = false;
      return { key, label, state: 'failed', detail: 'Blocked at this stage.', percent: null };
    }
    if (key === runningAt) {
      reached = false;
      return { key, label, state: 'running', detail: 'In progress', percent: 45 };
    }
    return { key, label, state: 'complete', detail: null, percent: null };
  });

  const done = stages.filter((s) => s.state === 'complete').length;
  const jobStatus =
    status === 'failed' ? 'failed' : status === 'indexing' ? 'running' : 'succeeded';

  await sql`
    INSERT INTO processing_jobs (id, organization_id, workspace_id, kind, status, idempotency_key, trace_id,
                                 payload, stages, percent, attempt, max_attempts, target_type, target_id,
                                 created_by_user_id, started_at, finished_at, error)
    VALUES (${newId()}, ${ctx.organizationId}, ${ctx.workspaceId}, 'source_ingest', ${jobStatus},
            ${'seed:' + sourceId}, ${newId().toLowerCase()}, ${JSON.stringify({ sourceId })}::jsonb,
            ${JSON.stringify(stages)}::jsonb, ${Math.round((done / stages.length) * 100)}, 1, 3,
            'source', ${sourceId}, ${ctx.userId}, now(),
            ${jobStatus === 'running' ? null : 'now()'}::timestamptz,
            ${
              status === 'failed'
                ? JSON.stringify({
                    code: 'worker_rejected',
                    message:
                      'Upload failed: the file ended before the declared length was received.',
                    retryable: true,
                    traceId: 'seed',
                  })
                : null
            }::jsonb)
  `;
}

async function pingWorker(): Promise<boolean> {
  try {
    const response = await fetch(`${WORKER_URL}/health`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Runs the real extraction/indexing path so seeded sources are genuinely searchable. */
async function ingest(
  ctx: {
    organizationId: string;
    workspaceId: string;
    userId: string;
    role: 'owner';
    groupIds: string[];
    traceId: string;
  },
  sourceId: string,
  file: string,
  contentType: string,
  promote: boolean,
): Promise<void> {
  const {
    detectStructure,
    chunkSections,
    chunkSpreadsheet,
    chunkSlides,
    embeddingInput,
    DeterministicEmbeddingProvider,
  } = await import('@uxe/rag');
  const { RetrievalRepository } = await import('./repositories/retrieval.js');

  const bytes = readFileSync(repositoryPath(file));
  const response = await fetch(`${WORKER_URL}/extract`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-worker-token': WORKER_TOKEN },
    body: JSON.stringify({
      fileName: file.split('/').pop(),
      contentType: mimeFor(contentType),
      bytesBase64: bytes.toString('base64'),
      maxPages: 500,
    }),
  });

  if (!response.ok) {
    console.warn(`    extraction failed for ${file}: ${response.status}`);
    return;
  }

  const extraction = (await response.json()) as {
    documentType: string;
    pages: Array<Record<string, unknown>>;
    pageCount: number;
  };

  const versionId = newId();
  const sha = await sha256(bytes);

  // The original bytes are stored under the same key the API would use. Without this the
  // demonstration workspace looks complete but every operation that needs the original —
  // download, reprocess, generating a corrected edition — fails on a missing file.
  const storageKey = `${ctx.organizationId}/${ctx.workspaceId}/source/${sourceId}/${
    file.split('/').pop() ?? 'document'
  }`;
  storeOriginal(storageKey, bytes);

  await sql`
    INSERT INTO source_versions (id, source_id, organization_id, workspace_id, version, version_number, sha256,
                                 storage_key, content_type, size_bytes, pages, status, is_current, promoted_at,
                                 created_by_user_id)
    VALUES (${versionId}, ${sourceId}, ${ctx.organizationId}, ${ctx.workspaceId}, 'v1.0', 1, ${sha},
            ${storageKey}, ${mimeFor(contentType)}, ${bytes.length}, ${extraction.pageCount},
            ${promote ? 'ready' : 'needs_review'}, ${promote}, ${ts(promote ? new Date() : null)}::timestamptz, ${ctx.userId})
  `;
  if (promote) {
    await sql`UPDATE sources SET current_version_id = ${versionId} WHERE id = ${sourceId}`;
  }

  const retrieval = new RetrievalRepository(db);
  const pages = extraction.pages as never[];
  await retrieval.replacePages(ctx as never, versionId, pages);

  const isSpreadsheet = extraction.documentType === 'xlsx' || extraction.documentType === 'csv';
  const isSlides = extraction.documentType === 'pptx';
  const sections = isSpreadsheet || isSlides ? [] : detectStructure(pages);

  if (sections.length > 0) {
    await retrieval.replaceSections(
      ctx as never,
      versionId,
      sections.map((s) => ({
        parentId: null,
        ordinal: s.ordinal,
        level: s.level,
        kind: s.kind,
        chapter: s.chapter,
        section: s.section,
        clause: s.clause,
        title: s.title,
        body: s.body.slice(0, 20000),
        headingPath: s.headingPath,
        pageNumber: s.pageNumber,
        charStart: s.charStart,
        charEnd: s.charEnd,
        modality: s.modality,
        isRequirement: s.isRequirement,
        effectiveDate: s.effectiveDate,
        supersededNote: s.supersededNote,
        crossReferences: s.crossReferences,
        exceptions: s.exceptions,
      })),
    );
  }

  const chunks = isSpreadsheet
    ? chunkSpreadsheet(pages)
    : isSlides
      ? chunkSlides(pages)
      : chunkSections(sections);
  if (chunks.length === 0) return;

  const chunkIds = await retrieval.replaceChunks(
    ctx as never,
    sourceId,
    versionId,
    chunks.map((c) => ({ ...c, sectionId: null })),
  );

  const embedder = new DeterministicEmbeddingProvider();
  const vectors = await embedder.embed(chunks.map((c) => embeddingInput(c)));
  await retrieval.replaceEmbeddings(
    ctx as never,
    versionId,
    embedder.model,
    chunkIds.map((id, index) => ({ chunkId: id, vector: vectors[index] ?? [] })),
  );

  console.log(
    `    indexed ${file.split('/').pop()}: ${extraction.pageCount} page(s), ${chunks.length} chunk(s)`,
  );
}

/**
 * Resolves a repository-relative path.
 *
 * pnpm runs this script with the working directory set to `packages/db`, so a bare
 * `tests/fixtures/...` would not exist. The path is anchored to this file instead.
 */
function repositoryPath(relative: string): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', relative);
}

/** Writes an original into the filesystem bucket the local API reads from. */
function storeOriginal(storageKey: string, bytes: Buffer): void {
  const configured = process.env.STORAGE_LOCAL_PATH ?? './.data/storage';
  const root = configured.startsWith('/') ? configured : repositoryPath(configured);
  const target = join(root, 'originals', storageKey);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}

function mimeFor(type: string): string {
  return (
    {
      pdf: 'application/pdf',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    }[type] ?? 'application/octet-stream'
  );
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function roleTitle(role: string): string {
  return (
    { owner: 'Compliance Lead', reviewer: 'Senior Reviewer', read_only: 'External Auditor' }[
      role
    ] ?? ''
  );
}

function defaultSettings(): Record<string, unknown> {
  return {
    consultant: {
      name: 'Ayumi',
      title: 'Compliance Consultant',
      avatarUrl: '/consultantgirl.png',
      greeting: 'Ask Ayumi anything grounded in your approved sources.',
      behaviorNotes:
        'Answer only from approved sources. State uncertainty plainly. Always cite exact clause and page.',
      defaultAnswerStyle: 'optimal',
      defaultTaskMode: 'ask',
    },
    answers: {
      knowledgeOnly: true,
      askWhenUncertain: true,
      generalModelFallback: false,
      requireCitations: true,
      minimumEvidenceThreshold: 0.3,
      minimumCitationsPerClaim: 1,
    },
    security: {
      mfaPolicy: 'optional',
      sessionIdleMinutes: 480,
      sessionAbsoluteHours: 720,
      allowedEmailDomains: [],
      ssoEnforced: false,
    },
    retention: {
      consultationDays: 365,
      artifactDays: 365,
      auditDays: 730,
      purgeGraceDays: 30,
      legalHold: false,
    },
    notifications: { jobCompletion: true, weeklyDigest: false, criticalFindings: true },
  };
}

main()
  .then(() => close())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error(error);
    await close();
    process.exit(1);
  });
