import { newId, type TenantContext } from '@uxe/db';
import type { Citation, StructuredAnswer } from '@uxe/contracts';
import {
  ProviderError,
  answerQuestion,
  buildChangePlan,
  buildChangeLog,
  decideOutputStrategy,
  runComplianceReview,
  summarizeSources,
  validateDerivative,
  type SourceScope,
} from '@uxe/rag';
import { renderDetails } from '@uxe/rag';
import type { AppDeps } from '../context.js';
import { runConnectorSync } from './connector-sync.js';
import { runIngestion, base64ToBytes, bytesToBase64 } from './ingest.js';
import { DocumentWorkerError } from '../services/document-worker.js';
import { buildStorageKey } from '../services/storage.js';
import { workspaceSettingsFrom } from '../services/settings.js';
import { EmailTemplates } from '../services/email.js';

export interface RunResult {
  ok: boolean;
  resultRef: { kind: string; id: string } | null;
  metrics: Record<string, unknown>;
}

/**
 * Executes one claimed job.
 *
 * Errors are classified into retryable and terminal here rather than at the call site,
 * because only this layer knows whether a failure was a provider blip (retry with backoff)
 * or a document the libraries genuinely cannot open (do not retry; tell the user why).
 */
export async function runJob(deps: AppDeps, job: JobRecord): Promise<RunResult> {
  const tenant = await tenantForJob(deps, job);
  const logger = deps.logger.child({
    jobId: job.id,
    traceId: job.traceId,
    workspaceId: job.workspaceId,
    kind: job.kind,
  });

  await deps.repos.jobs.beginAttempt(job.id, job.attempt, job.workspaceId);
  const started = Date.now();

  try {
    const result = await dispatch(deps, tenant, job, logger);
    await deps.repos.jobs.succeed(job.id, result.resultRef, {
      ...result.metrics,
      durationMs: Date.now() - started,
    });
    deps.metrics.observe('uxe_job_duration_ms', Date.now() - started, {
      kind: job.kind,
      outcome: 'success',
    });
    logger.info('job.succeeded', { durationMs: Date.now() - started });
    await notifyCompletion(deps, tenant, job, true, null);
    return result;
  } catch (error) {
    const classified = classify(error, job.traceId);
    await deps.repos.jobs.fail(job.id, classified);
    deps.metrics.increment('uxe_job_failures_total', { kind: job.kind, code: classified.code });
    deps.metrics.observe('uxe_job_duration_ms', Date.now() - started, {
      kind: job.kind,
      outcome: 'error',
    });
    logger.error('job.failed', {
      code: classified.code,
      message: classified.message,
      retryable: classified.retryable,
    });

    // The user's input is never discarded: the assistant row keeps the error so the UI can
    // show a recoverable state with a Retry action instead of an empty bubble.
    const assistantMessageId = job.payload.assistantMessageId;
    if (typeof assistantMessageId === 'string') {
      await deps.repos.consultations.completeMessage(assistantMessageId, { error: classified });
    }

    // The same rule for documents. Without this the source sits at "Pending" for ever: no
    // reason, no Retry, and nothing to tell the user the file will never be indexed.
    const sourceId = job.payload.sourceId;
    const isFinalAttempt = !classified.retryable || job.attempt >= job.maxAttempts;
    if (
      typeof sourceId === 'string' &&
      isFinalAttempt &&
      ['source_ingest', 'source_reprocess', 'source_sync'].includes(job.kind)
    ) {
      await deps.repos.sources
        .setSourceStatus(sourceId, { status: 'failed', failureReason: classified.message })
        .catch((statusError: unknown) => {
          logger.error('job.source_status_update_failed', {
            message: statusError instanceof Error ? statusError.message : String(statusError),
          });
        });
    }

    if (!classified.retryable || job.attempt >= job.maxAttempts) {
      await notifyCompletion(deps, tenant, job, false, classified.message);
    }
    throw error;
  }
}

async function dispatch(
  deps: AppDeps,
  tenant: TenantContext,
  job: JobRecord,
  logger: ReturnType<AppDeps['logger']['child']>,
): Promise<RunResult> {
  switch (job.kind) {
    case 'source_ingest':
    case 'source_reprocess':
    case 'source_sync':
      return runIngestJob(deps, tenant, job);
    case 'consultation_answer':
      return runAnswerJob(deps, tenant, job);
    case 'compliance_review':
      return runReviewJob(deps, tenant, job);
    case 'report_generate':
      return runReportJob(deps, tenant, job);
    case 'correction_plan':
      return runCorrectionPlanJob(deps, tenant, job);
    case 'correction_generate':
      return runCorrectionGenerateJob(deps, tenant, job);
    case 'connector_sync':
      return runConnectorSyncJob(deps, tenant, job);
    case 'retention_purge':
      return runRetentionPurgeJob(deps, tenant);
    default:
      logger.warn('job.unknown_kind');
      throw new Error(`Unknown job kind: ${job.kind}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Connector sync                                                             */
/* -------------------------------------------------------------------------- */

async function runConnectorSyncJob(
  deps: AppDeps,
  tenant: TenantContext,
  job: JobRecord,
): Promise<RunResult> {
  const payload = job.payload as { connectorId: string };
  const outcome = await runConnectorSync(deps, tenant, { connectorId: payload.connectorId });

  return {
    ok: true,
    resultRef: { kind: 'connector', id: payload.connectorId },
    metrics: { ...outcome },
  };
}

/* -------------------------------------------------------------------------- */
/* Ingestion                                                                  */
/* -------------------------------------------------------------------------- */

async function runIngestJob(
  deps: AppDeps,
  tenant: TenantContext,
  job: JobRecord,
): Promise<RunResult> {
  const payload = job.payload as {
    sourceId: string;
    sourceVersionId: string;
    storageKey: string;
    fileName: string;
    contentType: string;
  };

  const outcome = await runIngestion(deps, tenant, { ...payload, jobId: job.id });

  return {
    ok: true,
    resultRef: { kind: 'source', id: payload.sourceId },
    metrics: {
      pages: outcome.pages,
      chunks: outcome.chunks,
      requirements: outcome.requirements,
      extractionCoverage: outcome.extractionCoverage,
      status: outcome.status,
      warnings: outcome.warnings.length,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Answering                                                                  */
/* -------------------------------------------------------------------------- */

async function runAnswerJob(
  deps: AppDeps,
  tenant: TenantContext,
  job: JobRecord,
): Promise<RunResult> {
  const payload = job.payload as {
    consultationId: string;
    assistantMessageId: string;
    question: string;
    taskMode: 'ask' | 'summarize' | 'check_compliance' | 'correct_document';
    answerStyle: 'yes_no' | 'optimal' | 'details';
  };

  await deps.repos.jobs.updateStage(job.id, 'permissions', 'running');
  const consultation = await deps.repos.consultations.getById(tenant, payload.consultationId);
  const scope = await buildScope(deps, tenant, payload.consultationId);
  await deps.repos.jobs.updateStage(
    job.id,
    'permissions',
    'complete',
    `${scope.length} permitted source version(s)`,
  );

  const settings = await settingsFor(deps, tenant);

  await deps.repos.jobs.updateStage(job.id, 'retrieval', 'running');

  const options = {
    task: payload.taskMode,
    answerStyle: payload.answerStyle,
    knowledgeOnly: consultation.responseControls.knowledgeOnly,
    askWhenUncertain: consultation.responseControls.askWhenUncertain,
    generalModelFallback: consultation.responseControls.generalModelFallback,
    minimumEvidenceThreshold: settings.answers.minimumEvidenceThreshold,
    consultantName: settings.consultant.name,
    locale: settings.general.locale,
    idFactory: newId,
    nonce: newId(),
  };

  const result =
    payload.taskMode === 'summarize'
      ? await summarizeSources(
          tenant,
          {
            repo: deps.repos.retrieval,
            embedder: deps.services.embeddings,
            chat: deps.services.chat,
          },
          scope,
          { ...options, format: 'executive' },
        )
      : await answerQuestion(
          tenant,
          {
            repo: deps.repos.retrieval,
            embedder: deps.services.embeddings,
            chat: deps.services.chat,
          },
          payload.question,
          scope,
          options,
        );

  await deps.repos.jobs.updateStage(
    job.id,
    'retrieval',
    'complete',
    `${result.telemetry.finalCandidates} passage(s) from ${result.telemetry.lexicalCandidates} lexical + ${result.telemetry.vectorCandidates} vector candidates`,
  );
  await deps.repos.jobs.updateStage(job.id, 'rerank', 'complete');
  await deps.repos.jobs.updateStage(job.id, 'analysis', 'complete');
  await deps.repos.jobs.updateStage(
    job.id,
    'verification',
    result.telemetry.unverifiedCitations > 0 ? 'complete' : 'complete',
    `${result.telemetry.verifiedCitations} verified, ${result.telemetry.unverifiedCitations} unverified`,
  );

  await persistAnswer(deps, tenant, payload.assistantMessageId, null, result.answer);
  await deps.repos.jobs.updateStage(job.id, 'assembly', 'complete');

  await deps.repos.consultations.update(tenant, payload.consultationId, consultation.version, {
    status: 'active',
  });

  deps.metrics.observe('uxe_evidence_coverage', result.answer.coverage.score, {
    task: payload.taskMode,
  });
  deps.metrics.observe(
    'uxe_citation_verification_rate',
    result.answer.citations.length === 0
      ? 1
      : result.telemetry.verifiedCitations / result.answer.citations.length,
    { task: payload.taskMode },
  );

  return {
    ok: true,
    resultRef: { kind: 'message', id: payload.assistantMessageId },
    metrics: {
      ...result.telemetry,
      coverage: result.answer.coverage.score,
      confidence: result.answer.confidence.overall,
      decision: result.answer.decision,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Compliance review                                                          */
/* -------------------------------------------------------------------------- */

async function runReviewJob(
  deps: AppDeps,
  tenant: TenantContext,
  job: JobRecord,
): Promise<RunResult> {
  const payload = job.payload as {
    consultationId: string;
    reviewId: string;
    assistantMessageId: string;
    answerStyle: 'yes_no' | 'optimal' | 'details';
    scopeNote: string | null;
  };

  await deps.repos.jobs.updateStage(job.id, 'permissions', 'running');
  const consultation = await deps.repos.consultations.getById(tenant, payload.consultationId);
  const scope = await buildScope(deps, tenant, payload.consultationId);
  await deps.repos.jobs.updateStage(job.id, 'permissions', 'complete');

  const settings = await settingsFor(deps, tenant);

  await deps.repos.jobs.updateStage(job.id, 'requirements', 'running');

  const review = await runComplianceReview(
    tenant,
    { repo: deps.repos.retrieval, embedder: deps.services.embeddings, chat: deps.services.chat },
    scope,
    {
      task: 'check_compliance',
      answerStyle: payload.answerStyle,
      knowledgeOnly: consultation.responseControls.knowledgeOnly,
      askWhenUncertain: consultation.responseControls.askWhenUncertain,
      generalModelFallback: consultation.responseControls.generalModelFallback,
      minimumEvidenceThreshold: settings.answers.minimumEvidenceThreshold,
      consultantName: settings.consultant.name,
      locale: settings.general.locale,
      idFactory: newId,
      nonce: newId(),
      scopeNote: payload.scopeNote,
      onProgress: async (done, total) => {
        await deps.repos.jobs.updateStage(
          job.id,
          'evidence',
          'running',
          `${done} / ${total} requirements tested`,
          Math.round((done / Math.max(1, total)) * 100),
        );
      },
    },
  );

  await deps.repos.jobs.updateStage(
    job.id,
    'requirements',
    'complete',
    `${review.requirements.length} requirement(s)`,
  );
  await deps.repos.jobs.updateStage(job.id, 'evidence', 'complete');
  await deps.repos.jobs.updateStage(job.id, 'conflicts', 'complete');

  // Citations are persisted first so findings can reference them by id.
  await deps.repos.consultations.saveCitations(
    tenant,
    review.citations.map((citation) => ({
      id: citation.citationId,
      reviewId: payload.reviewId,
      messageId: payload.assistantMessageId,
      sourceId: citation.sourceId,
      sourceVersionId: citation.sourceVersionId,
      sourceSha256: citation.sourceSha256,
      documentTitle: citation.documentTitle,
      documentType: citation.documentType,
      pageNumber: citation.pageNumber,
      sheetName: citation.sheetName,
      cellRange: citation.cellRange,
      slideNumber: citation.slideNumber,
      shapeName: citation.shapeName,
      chapter: citation.chapter,
      section: citation.section,
      clause: citation.clause,
      headingPath: citation.headingPath,
      paragraphIndex: citation.paragraphIndex,
      charStart: citation.charStart,
      charEnd: citation.charEnd,
      urlFragment: citation.urlFragment,
      boundingBoxes: citation.boundingBoxes,
      supportingExcerpt: citation.supportingExcerpt,
      retrievalScore: citation.retrievalScore,
      rerankScore: citation.rerankScore,
      entailment: citation.entailment,
      verified: citation.verified,
      verificationMethod: citation.verificationMethod,
      effectiveDate: citation.effectiveDate ? new Date(citation.effectiveDate) : null,
    })),
  );
  await deps.repos.jobs.updateStage(
    job.id,
    'verification',
    'complete',
    `${review.citations.filter((c) => c.verified).length} of ${review.citations.length} citations verified`,
  );

  await deps.repos.consultations.saveRequirements(
    tenant,
    payload.reviewId,
    review.requirements.map((requirement, index) => ({
      id: requirement.requirementId,
      sourceId: requirement.sourceId,
      sourceVersionId: requirement.sourceVersionId,
      sectionId: null,
      reference: requirement.reference,
      title: requirement.title,
      obligationText: requirement.obligationText,
      modality: requirement.modality,
      citationId: requirement.citationId,
      exceptions: requirement.exceptions,
      crossReferences: requirement.crossReferences,
      ordinal: index,
    })),
  );

  await deps.repos.consultations.saveFindings(
    tenant,
    payload.reviewId,
    review.findings.map((finding) => ({
      id: finding.findingId,
      requirementId: finding.requirementId,
      result: finding.result,
      risk: finding.risk,
      finding: finding.finding,
      projectEvidenceCitationIds: finding.projectEvidenceCitationIds,
      governingCitationIds: finding.governingCitationIds,
      missingEvidence: finding.missingEvidence,
      conflicts: finding.conflicts,
      recommendedAction: finding.recommendedAction,
      confidence: finding.confidence,
    })),
  );

  const total = review.requirements.length || 1;
  const complianceScore = (review.counts.compliant / total) * 100;

  await deps.repos.consultations.finalizeReview(payload.reviewId, {
    status: 'complete',
    messageId: payload.assistantMessageId,
    requirementsTotal: review.requirements.length,
    compliantCount: review.counts.compliant,
    nonCompliantCount: review.counts.nonCompliant,
    needsEvidenceCount: review.counts.needsEvidence,
    notAssessedCount: review.counts.notAssessed,
    evidenceCoverage: review.answer.coverage.score,
    confidence: review.answer.confidence.overall,
    riskLevel: review.answer.riskLevel,
  });

  await persistAnswer(deps, tenant, payload.assistantMessageId, payload.reviewId, review.answer);
  await deps.repos.jobs.updateStage(job.id, 'scoring', 'complete');

  await deps.repos.consultations.update(tenant, payload.consultationId, consultation.version, {
    status: review.counts.nonCompliant > 0 ? 'action_required' : 'report_ready',
    complianceScore,
  });

  deps.metrics.observe('uxe_evidence_coverage', review.answer.coverage.score, {
    task: 'check_compliance',
  });

  return {
    ok: true,
    resultRef: { kind: 'message', id: payload.assistantMessageId },
    metrics: {
      requirements: review.requirements.length,
      ...review.counts,
      coverage: review.answer.coverage.score,
      confidence: review.answer.confidence.overall,
      riskLevel: review.answer.riskLevel,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Reports                                                                    */
/* -------------------------------------------------------------------------- */

async function runReportJob(
  deps: AppDeps,
  tenant: TenantContext,
  job: JobRecord,
): Promise<RunResult> {
  const payload = job.payload as {
    consultationId: string;
    reviewId: string | null;
    messageId: string | null;
    format: 'pdf' | 'docx' | 'xlsx' | 'csv' | 'markdown';
    kind: 'compliance_report' | 'summary' | 'evidence_matrix';
    title: string | null;
  };

  await deps.repos.jobs.updateStage(job.id, 'collect', 'running');
  const consultation = await deps.repos.consultations.getById(tenant, payload.consultationId);

  const messageId = payload.messageId ?? (await messageForReview(deps, tenant, payload.reviewId));
  if (!messageId) throw new Error('There is no completed answer to build this report from.');

  const message = await deps.repos.consultations.getMessage(tenant, messageId);
  const answer = message.answer as unknown as StructuredAnswer | null;
  if (!answer) throw new Error('That answer has not finished generating yet.');

  const details = renderDetails(answer);
  await deps.repos.jobs.updateStage(
    job.id,
    'collect',
    'complete',
    `${details.evidenceRows.length} row(s)`,
  );

  await deps.repos.jobs.updateStage(job.id, 'render', 'running');
  const generated = await deps.services.documentWorker.report({
    format: payload.format,
    title: payload.title ?? consultation.title,
    subtitle: details.documentsReviewed.map((d) => d.title).join(', '),
    generatedAt: new Date().toISOString(),
    summary: answer.summary,
    decision: answer.decision,
    decisionQualifier: answer.decisionQualifier,
    confidence: answer.confidence.overall,
    coverage: answer.coverage.score,
    documentsReviewed: details.documentsReviewed.map((d) => ({
      title: d.title,
      version: d.version,
      role: d.role,
      pages: d.pages,
    })),
    assumptions: details.assumptions,
    rows: details.evidenceRows.map((row) => ({
      requirement: row.requirement,
      result: row.result,
      finding: row.finding,
      source: row.source,
      version: row.version,
      location: row.location,
      page: row.page,
      excerpt: row.excerpt,
      confidence: row.confidence,
      verified: row.verified,
    })),
    recommendations: details.remediation.map((r) => ({ action: r.action, priority: r.priority })),
    disclosures: [
      `Generated by ${answer.modelDescriptor}.`,
      'Every row is traceable to the source version pinned to this consultation.',
      ...(details.evidenceRows.some((r) => !r.verified)
        ? [
            'Rows marked UNVERIFIED could not be re-located in the stored source text and must be checked manually.',
          ]
        : []),
    ],
  });
  await deps.repos.jobs.updateStage(job.id, 'render', 'complete');

  await deps.repos.jobs.updateStage(job.id, 'validate', 'running');
  const bytes = base64ToBytes(generated.documentBase64);
  if (bytes.byteLength === 0) throw new Error('The generated report was empty.');
  await deps.repos.jobs.updateStage(job.id, 'validate', 'complete', `${bytes.byteLength} bytes`);

  await deps.repos.jobs.updateStage(job.id, 'store', 'running');
  const title = payload.title ?? `${consultation.title} - ${payload.kind.replace(/_/g, ' ')}`;
  const artifactId = newId();
  const storageKey = buildStorageKey({
    organizationId: tenant.organizationId,
    workspaceId: tenant.workspaceId,
    kind: 'artifact',
    id: artifactId,
    fileName: `${title}.${generated.extension}`,
  });
  const stored = await deps.services.storage.put(
    'artifacts',
    storageKey,
    bytes,
    generated.contentType,
  );

  const artifact = await deps.repos.artifacts.create(tenant, {
    kind: payload.kind,
    title,
    documentType: payload.format === 'markdown' ? 'text' : payload.format,
    contentType: generated.contentType,
    storageKey: stored.key,
    sizeBytes: stored.sizeBytes,
    sha256: stored.sha256,
    consultationId: payload.consultationId,
    reviewId: payload.reviewId,
    generatorDescriptor: answer.modelDescriptor,
    disclosures: [],
    validation: {
      rows: details.evidenceRows.length,
      verifiedRows: details.evidenceRows.filter((r) => r.verified).length,
    },
    status: 'ready',
  });

  await deps.repos.artifacts.createReport(tenant, {
    artifactId: artifact.id,
    kind: payload.kind,
    title,
    summary: answer.headline,
    consultationId: payload.consultationId,
    reviewId: payload.reviewId,
  });
  await deps.repos.jobs.updateStage(job.id, 'store', 'complete');

  return {
    ok: true,
    resultRef: { kind: 'artifact', id: artifact.id },
    metrics: { format: payload.format, bytes: stored.sizeBytes, rows: details.evidenceRows.length },
  };
}

/* -------------------------------------------------------------------------- */
/* Corrections                                                                */
/* -------------------------------------------------------------------------- */

async function runCorrectionPlanJob(
  deps: AppDeps,
  tenant: TenantContext,
  job: JobRecord,
): Promise<RunResult> {
  const payload = job.payload as {
    consultationId: string;
    sourceId: string;
    reviewId: string | null;
    findingIds: string[];
    instructions: string | null;
  };

  await deps.repos.jobs.updateStage(job.id, 'plan', 'running');

  // "Correct this document" means "against what we just found". When the caller names no
  // review, the consultation's most recent completed one is used; with none at all there is
  // nothing to correct against, and saying so beats producing an empty plan that looks like
  // success.
  const reviewId =
    payload.reviewId ??
    (await deps.repos.consultations.latestCompletedReview(tenant, payload.consultationId))?.id ??
    null;

  if (!reviewId) {
    throw new Error(
      'Run a compliance review first: a corrected edition is built from the findings it produces.',
    );
  }

  const source = await deps.repos.sources.getById(tenant, payload.sourceId);
  const version = await deps.repos.sources.getCurrentVersion(tenant, payload.sourceId);
  if (!version) throw new Error('That document has no indexed version to correct.');

  const metadata = version.metadata as Record<string, unknown>;
  const decision = decideOutputStrategy({
    documentType: source.documentType as never,
    hasExtractableText: metadata.hasExtractableText !== false,
    isScanned: metadata.isScanned === true,
    isSigned: metadata.isSigned === true,
    isEncrypted: metadata.isEncrypted === true,
    hasMacros: metadata.hasMacros === true,
    pageCount: version.pages,
  });

  const plan = await deps.repos.corrections.createPlan(tenant, {
    consultationId: payload.consultationId,
    sourceId: payload.sourceId,
    sourceVersionId: version.id,
    reviewId,
    outputStrategy: decision.strategy,
    limitations: decision.limitations,
    signatureNotice: decision.signatureNotice,
    instructions: payload.instructions,
  });

  // Only findings the caller selected are actionable, and only those from a review they
  // are permitted to read.
  const findings = (await deps.repos.consultations.listFindings(tenant, reviewId))
    .filter((row) => payload.findingIds.length === 0 || payload.findingIds.includes(row.finding.id))
    .map(({ finding, requirement }) => ({
      findingId: finding.id,
      requirementId: finding.requirementId,
      requirementReference: requirement.reference,
      requirementTitle: requirement.title,
      result: finding.result as never,
      risk: finding.risk as never,
      finding: finding.finding,
      projectEvidenceCitationIds: finding.projectEvidenceCitationIds,
      governingCitationIds: finding.governingCitationIds,
      missingEvidence: finding.missingEvidence,
      conflicts: finding.conflicts,
      recommendedAction: finding.recommendedAction,
      confidence: finding.confidence,
    }));

  const citations = (await deps.repos.consultations.listCitationsForReview(tenant, reviewId)).map(
    toCitation,
  );

  const changes = buildChangePlan({
    findings,
    citations,
    projectCandidates: [],
    instructions: payload.instructions ?? undefined,
  });

  await deps.repos.corrections.addChanges(tenant, plan.id, changes);
  await deps.repos.jobs.updateStage(
    job.id,
    'plan',
    'complete',
    `${changes.length} proposed change(s), strategy ${decision.strategy}`,
  );
  // Generation is a separate, explicitly-authorised step: nothing is written until a
  // reviewer has accepted individual changes.
  await deps.repos.jobs.updateStage(
    job.id,
    'generate',
    'skipped',
    'Awaiting review of proposed changes',
  );
  await deps.repos.jobs.updateStage(job.id, 'validate', 'skipped');
  await deps.repos.jobs.updateStage(job.id, 'store', 'skipped');

  return {
    ok: true,
    resultRef: { kind: 'plan', id: plan.id },
    metrics: {
      changes: changes.length,
      strategy: decision.strategy,
      limitations: decision.limitations.length,
    },
  };
}

async function runCorrectionGenerateJob(
  deps: AppDeps,
  tenant: TenantContext,
  job: JobRecord,
): Promise<RunResult> {
  const payload = job.payload as {
    planId: string;
    outputFormat: string;
    includeRedline: boolean;
  };

  await deps.repos.jobs.updateStage(job.id, 'plan', 'running');
  const plan = await deps.repos.corrections.getPlan(tenant, payload.planId);
  const accepted = await deps.repos.corrections.acceptedChanges(tenant, payload.planId);

  if (accepted.length === 0) {
    throw new Error('No changes have been accepted, so there is nothing to generate.');
  }

  const source = await deps.repos.sources.getById(tenant, plan.sourceId);
  const versions = await deps.repos.sources.listVersions(tenant, plan.sourceId);
  const version = versions.find((v) => v.id === plan.sourceVersionId);
  if (!version) throw new Error('The version this plan was built against is no longer available.');

  const original = await deps.services.storage.get('originals', version.storageKey);
  if (!original) throw new Error('The original file could not be read from storage.');
  await deps.repos.jobs.updateStage(
    job.id,
    'plan',
    'complete',
    `${accepted.length} accepted change(s)`,
  );

  await deps.repos.jobs.updateStage(job.id, 'generate', 'running');
  const citations = plan.reviewId
    ? (await deps.repos.consultations.listCitationsForReview(tenant, plan.reviewId)).map(toCitation)
    : [];
  const citationById = new Map(citations.map((c) => [c.citationId, c]));

  const generated = await deps.services.documentWorker.correct({
    strategy: plan.outputStrategy as never,
    documentType: source.documentType,
    bytesBase64: bytesToBase64(original),
    fileName: `${source.title}`,
    title: `${source.title} - corrected edition`,
    includeRedline: payload.includeRedline,
    disclosures: [...plan.limitations, ...(plan.signatureNotice ? [plan.signatureNotice] : [])],
    changes: accepted.map((change) => {
      const citation = change.governingCitationId
        ? citationById.get(change.governingCitationId)
        : undefined;
      return {
        ordinal: change.ordinal,
        pageNumber: change.pageNumber,
        paragraphIndex: change.paragraphIndex,
        sheetName: change.sheetName,
        cellRange: change.cellRange,
        slideNumber: change.slideNumber,
        // A reviewer's hand-edit is what actually gets written.
        currentContent: change.currentContent,
        proposedContent: change.editedContent ?? change.proposedContent,
        reason: change.reason,
        citation: citation
          ? `${citation.documentTitle} - ${citation.clause ?? citation.section ?? ''}`
          : null,
      };
    }),
  });
  await deps.repos.jobs.updateStage(job.id, 'generate', 'complete');

  // --- Validation: the derivative must open and must not have lost content ---
  await deps.repos.jobs.updateStage(job.id, 'validate', 'running');
  const metadata = version.metadata as Record<string, unknown>;
  const validation = validateDerivative({
    original: {
      pages: version.pages,
      textLength:
        Number(metadata.textLength ?? 0) || (await originalTextLength(deps, tenant, version.id)),
      mediaCount: Number(metadata.mediaCount ?? 0),
      pageSizes: (metadata.pageSizes as Array<{ w: number; h: number }> | undefined) ?? [],
    },
    generated: {
      opened: generated.validation.opened,
      pages: generated.validation.pages,
      textLength: generated.validation.textLength,
      mediaCount: generated.validation.mediaCount,
      pageSizes: generated.validation.pageSizes,
    },
    acceptedChangeCount: accepted.length,
    allowedExtraPages: generated.validation.addendumPages ?? 0,
  });

  if (!validation.ok) {
    const failed = validation.checks.filter((check) => !check.passed);
    await deps.repos.jobs.updateStage(
      job.id,
      'validate',
      'failed',
      failed[0]?.detail ?? 'Validation failed',
    );
    await deps.repos.corrections.setPlanStatus(payload.planId, 'failed');
    // Release is blocked rather than shipping a quietly broken document.
    throw new Error(
      `The corrected edition failed validation and was not released: ${failed.map((f) => f.detail).join(' ')}`,
    );
  }
  await deps.repos.jobs.updateStage(
    job.id,
    'validate',
    'complete',
    validation.checks.map((check) => check.name).join(', '),
  );

  // --- Store -------------------------------------------------------------
  await deps.repos.jobs.updateStage(job.id, 'store', 'running');
  const artifactId = newId();
  const fileName = `${source.title} - corrected.${generated.extension}`;
  const storageKey = buildStorageKey({
    organizationId: tenant.organizationId,
    workspaceId: tenant.workspaceId,
    kind: 'artifact',
    id: artifactId,
    fileName,
  });
  const stored = await deps.services.storage.put(
    'artifacts',
    storageKey,
    base64ToBytes(generated.documentBase64),
    generated.contentType,
  );

  const changeLog = buildChangeLog(
    accepted.map((change) => ({
      ordinal: change.ordinal,
      locatorLabel: change.locatorLabel,
      currentContent: change.currentContent,
      proposedContent: change.proposedContent,
      editedContent: change.editedContent,
      reason: change.reason,
      governingCitationId: change.governingCitationId,
      decidedAt: change.decidedAt,
    })),
    citations,
    null,
  );

  const disclosures = [
    ...plan.limitations,
    ...(plan.signatureNotice ? [plan.signatureNotice] : []),
    ...generated.warnings,
    ...(generated.validation.unmatchedChanges.length > 0
      ? [
          `Changes ${generated.validation.unmatchedChanges.join(', ')} could not be located in the document and were NOT applied.`,
        ]
      : []),
  ];

  const artifact = await deps.repos.artifacts.create(tenant, {
    kind: 'corrected_document',
    title: `${source.title} - corrected edition`,
    documentType: generated.extension === 'md' ? 'text' : generated.extension,
    contentType: generated.contentType,
    storageKey: stored.key,
    sizeBytes: stored.sizeBytes,
    sha256: stored.sha256,
    consultationId: plan.consultationId,
    reviewId: plan.reviewId,
    planId: plan.id,
    sourceId: plan.sourceId,
    sourceVersionId: plan.sourceVersionId,
    generatorDescriptor: `${deps.services.chat.id}:${deps.services.chat.model} + document-worker`,
    changeLog: changeLog as unknown as Array<Record<string, unknown>>,
    disclosures,
    validation: { checks: validation.checks, applied: generated.validation.appliedChanges },
    status: 'ready',
  });

  let redlineId: string | null = null;
  if (generated.redlineBase64) {
    const redlineArtifactId = newId();
    const redlineKey = buildStorageKey({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      kind: 'artifact',
      id: redlineArtifactId,
      fileName: `${source.title} - change report.${generated.extension}`,
    });
    const redlineStored = await deps.services.storage.put(
      'artifacts',
      redlineKey,
      base64ToBytes(generated.redlineBase64),
      generated.contentType,
    );
    const redline = await deps.repos.artifacts.create(tenant, {
      kind: 'redline',
      title: `${source.title} - change report`,
      documentType: generated.extension === 'md' ? 'text' : generated.extension,
      contentType: generated.contentType,
      storageKey: redlineStored.key,
      sizeBytes: redlineStored.sizeBytes,
      sha256: redlineStored.sha256,
      consultationId: plan.consultationId,
      planId: plan.id,
      sourceId: plan.sourceId,
      sourceVersionId: plan.sourceVersionId,
      generatorDescriptor: 'document-worker',
      changeLog: changeLog as unknown as Array<Record<string, unknown>>,
      status: 'ready',
    });
    redlineId = redline.id;
  }

  await deps.repos.corrections.setPlanStatus(payload.planId, 'generated', {
    generatedArtifactId: artifact.id,
    redlineArtifactId: redlineId,
  });
  await deps.repos.jobs.updateStage(job.id, 'store', 'complete');

  return {
    ok: true,
    resultRef: { kind: 'artifact', id: artifact.id },
    metrics: {
      applied: generated.validation.appliedChanges,
      unmatched: generated.validation.unmatchedChanges.length,
      strategy: plan.outputStrategy,
      bytes: stored.sizeBytes,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Retention                                                                  */
/* -------------------------------------------------------------------------- */

async function runRetentionPurgeJob(deps: AppDeps, tenant: TenantContext): Promise<RunResult> {
  const policy = await deps.repos.settings.getRetentionPolicy(tenant);
  if (policy?.legalHold) {
    return { ok: true, resultRef: null, metrics: { skipped: 'legal_hold' } };
  }

  const due = await deps.repos.settings.dueDeletions(50);
  let purged = 0;
  const objects: string[] = [];

  for (const request of due) {
    if (request.workspaceId !== tenant.workspaceId) continue;
    if (request.targetType === 'source') {
      const versions = await deps.repos.sources
        .listVersions(tenant, request.targetId)
        .catch(() => []);
      for (const version of versions) {
        if (await deps.services.storage.delete('originals', version.storageKey)) {
          objects.push(version.storageKey);
        }
      }
    }
    await deps.repos.settings.completeDeletion(request.id, {
      purgedAt: new Date().toISOString(),
      storageObjectsRemoved: objects.length,
      targetType: request.targetType,
      targetId: request.targetId,
    });
    purged += 1;
  }

  return { ok: true, resultRef: null, metrics: { purged, storageObjectsRemoved: objects.length } };
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

export interface JobRecord {
  id: string;
  organizationId: string;
  workspaceId: string;
  kind: string;
  traceId: string;
  payload: Record<string, unknown>;
  attempt: number;
  maxAttempts: number;
  createdByUserId: string | null;
}

/**
 * Rebuilds the TenantContext a job must run under.
 *
 * The context comes from the stored job row (which was written from an authenticated
 * session), never from the payload, so a job cannot widen its own access. The creator's
 * CURRENT role is re-read, so a job queued before a demotion runs at the reduced level.
 */
async function tenantForJob(deps: AppDeps, job: JobRecord): Promise<TenantContext> {
  const userId = job.createdByUserId;
  if (!userId) {
    return {
      organizationId: job.organizationId,
      workspaceId: job.workspaceId,
      userId: 'system',
      role: 'admin',
      groupIds: [],
      traceId: job.traceId,
    };
  }

  const membership = await deps.repos.identity.getMembership(userId, job.workspaceId);
  if (!membership) {
    throw new Error('The user who queued this job no longer has access to the workspace.');
  }
  const groupIds = await deps.repos.identity.groupIdsForUser(userId, job.workspaceId);

  return {
    organizationId: membership.organizationId,
    workspaceId: membership.workspaceId,
    userId,
    role: membership.role as TenantContext['role'],
    groupIds,
    traceId: job.traceId,
  };
}

async function buildScope(
  deps: AppDeps,
  tenant: TenantContext,
  consultationId: string,
): Promise<SourceScope[]> {
  const rows = await deps.repos.consultations.listSources(tenant, consultationId);
  const scope: SourceScope[] = [];

  for (const row of rows) {
    const source = await deps.repos.sources.getById(tenant, row.sourceId).catch(() => null);
    // A source the caller can no longer see silently drops out of scope rather than
    // leaking through a consultation they still own.
    if (!source) continue;
    scope.push({
      sourceId: row.sourceId,
      sourceVersionId: row.sourceVersionId,
      role: row.role as 'governing' | 'project',
      title: row.title,
      version: row.version,
      pages: row.pages,
      effectiveDate: row.effectiveDate,
      tags: source.tags,
      promoted: source.promotedToKnowledge,
      superseded: source.supersededBySourceId !== null,
    });
  }

  return scope;
}

async function settingsFor(deps: AppDeps, tenant: TenantContext) {
  const workspace = await deps.repos.identity.getWorkspace(tenant.workspaceId);
  return workspaceSettingsFrom(workspace?.settings ?? {}, workspace?.name ?? 'Workspace', {
    slug: workspace?.slug,
    locale: workspace?.locale,
    timezone: workspace?.timezone,
    brandColor: workspace?.brandColor,
    logoUrl: workspace?.logoUrl ?? null,
  });
}

async function persistAnswer(
  deps: AppDeps,
  tenant: TenantContext,
  messageId: string,
  reviewId: string | null,
  answer: StructuredAnswer,
): Promise<void> {
  if (!reviewId) {
    await deps.repos.consultations.saveCitations(
      tenant,
      answer.citations.map((citation) => ({
        id: citation.citationId,
        messageId,
        sourceId: citation.sourceId,
        sourceVersionId: citation.sourceVersionId,
        sourceSha256: citation.sourceSha256,
        documentTitle: citation.documentTitle,
        documentType: citation.documentType,
        pageNumber: citation.pageNumber,
        sheetName: citation.sheetName,
        cellRange: citation.cellRange,
        slideNumber: citation.slideNumber,
        shapeName: citation.shapeName,
        chapter: citation.chapter,
        section: citation.section,
        clause: citation.clause,
        headingPath: citation.headingPath,
        paragraphIndex: citation.paragraphIndex,
        charStart: citation.charStart,
        charEnd: citation.charEnd,
        urlFragment: citation.urlFragment,
        boundingBoxes: citation.boundingBoxes,
        supportingExcerpt: citation.supportingExcerpt,
        retrievalScore: citation.retrievalScore,
        rerankScore: citation.rerankScore,
        entailment: citation.entailment,
        verified: citation.verified,
        verificationMethod: citation.verificationMethod,
        effectiveDate: citation.effectiveDate ? new Date(citation.effectiveDate) : null,
      })),
    );
  }

  await deps.repos.consultations.completeMessage(messageId, {
    text: answer.headline,
    answer: answer as unknown as Record<string, unknown>,
    error: null,
  });
}

async function messageForReview(
  deps: AppDeps,
  tenant: TenantContext,
  reviewId: string | null,
): Promise<string | null> {
  if (!reviewId) return null;
  const review = await deps.repos.consultations.getReview(tenant, reviewId);
  return review.messageId;
}

async function originalTextLength(
  deps: AppDeps,
  tenant: TenantContext,
  versionId: string,
): Promise<number> {
  const pages = await deps.repos.retrieval.getPages(tenant, versionId);
  return pages.reduce((sum, page) => sum + page.text.length, 0);
}

function toCitation(row: Record<string, unknown>): Citation {
  return {
    citationId: String(row.id),
    tenantId: String(row.organizationId ?? ''),
    sourceId: String(row.sourceId),
    sourceVersionId: String(row.sourceVersionId),
    sourceSha256: String(row.sourceSha256),
    documentTitle: String(row.documentTitle),
    documentType: String(row.documentType) as never,
    pageNumber: (row.pageNumber as number | null) ?? null,
    sheetName: (row.sheetName as string | null) ?? null,
    cellRange: (row.cellRange as string | null) ?? null,
    slideNumber: (row.slideNumber as number | null) ?? null,
    shapeName: (row.shapeName as string | null) ?? null,
    chapter: (row.chapter as string | null) ?? null,
    section: (row.section as string | null) ?? null,
    clause: (row.clause as string | null) ?? null,
    headingPath: (row.headingPath as string[] | undefined) ?? [],
    paragraphIndex: (row.paragraphIndex as number | null) ?? null,
    charStart: (row.charStart as number | null) ?? null,
    charEnd: (row.charEnd as number | null) ?? null,
    urlFragment: (row.urlFragment as string | null) ?? null,
    boundingBoxes: (row.boundingBoxes as never[] | undefined) ?? [],
    supportingExcerpt: String(row.supportingExcerpt),
    retrievalScore: Number(row.retrievalScore ?? 0),
    rerankScore: Number(row.rerankScore ?? 0),
    entailment: String(row.entailment) as never,
    verified: Boolean(row.verified),
    verificationMethod: String(row.verificationMethod) as never,
    effectiveDate: row.effectiveDate ? new Date(String(row.effectiveDate)).toISOString() : null,
    supersededBy: null,
    createdAt: row.createdAt
      ? new Date(String(row.createdAt)).toISOString()
      : new Date().toISOString(),
  };
}

/**
 * Classifies a failure into the error envelope the UI renders.
 *
 * `retryable` is the important field: it decides whether the job is rescheduled with
 * backoff and whether the user is offered a Retry button. Getting this wrong either hides
 * a recoverable outage behind a dead end, or retries a corrupt file forever.
 */
function classify(
  error: unknown,
  traceId: string,
): { code: string; message: string; retryable: boolean; traceId: string } {
  if (error instanceof ProviderError) {
    return {
      code: `provider_${error.code}`,
      message: error.message,
      retryable: error.retryable,
      traceId,
    };
  }
  if (error instanceof DocumentWorkerError) {
    return {
      code: `worker_${error.code}`,
      message: error.message,
      retryable: error.retryable,
      traceId,
    };
  }
  if (error instanceof Error) {
    // A message written for the user (thrown deliberately above) is passed through; an
    // unexpected internal error is not, because it may contain implementation detail.
    const isUserFacing = /[.!?]$/.test(error.message) && error.message.length < 400;
    return {
      code: 'job_failed',
      message: isUserFacing
        ? error.message
        : 'This job could not be completed. Your input was preserved and you can retry it.',
      retryable: !isUserFacing,
      traceId,
    };
  }
  return {
    code: 'internal_error',
    message: 'This job could not be completed. Your input was preserved and you can retry it.',
    retryable: true,
    traceId,
  };
}

async function notifyCompletion(
  deps: AppDeps,
  tenant: TenantContext,
  job: JobRecord,
  success: boolean,
  reason: string | null,
): Promise<void> {
  if (!job.createdByUserId) return;

  const settings = await settingsFor(deps, tenant);
  if (!settings.notifications.jobCompletion) return;
  // Only long-running, user-visible work is worth an email.
  if (
    !['compliance_review', 'report_generate', 'correction_generate', 'source_ingest'].includes(
      job.kind,
    )
  ) {
    return;
  }

  const user = await deps.repos.identity.findUserById(job.createdByUserId);
  if (!user) return;

  const label = job.kind.replace(/_/g, ' ');
  const url = `${deps.env.PUBLIC_APP_URL}/consult/${String(job.payload.consultationId ?? '')}`;

  try {
    await deps.services.email.send({
      to: user.email,
      ...(success
        ? EmailTemplates.jobComplete({ title: label, detail: `Your ${label} finished.`, url })
        : EmailTemplates.jobFailed({
            title: label,
            reason: reason ?? 'The job could not be completed.',
            traceId: job.traceId,
            url,
          })),
    });
  } catch (error) {
    // A notification failure must never fail the job that succeeded.
    deps.logger.warn('job.notification_failed', {
      jobId: job.id,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }
}
