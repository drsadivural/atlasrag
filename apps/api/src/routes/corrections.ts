import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  DecideCorrectionRequest,
  GenerateCorrectionRequest,
  formatLocator,
  type Citation,
  type CorrectionPlan,
} from '@uxe/contracts';
import type { AppBindings, AppDeps } from '../context.js';
import { ApiError } from '../errors.js';
import { body, requireId, validateJson } from '../middleware/validate.js';
import { clientIp, requirePermission, userAgent } from '../middleware/index.js';
import { toJobView } from './jobs.js';

export function correctionRoutes(deps: AppDeps) {
  const app = new Hono<AppBindings>();

  app.get('/:planId', requirePermission('correction:create'), async (c) => {
    const tenant = c.get('tenant');
    if (!tenant) throw ApiError.unauthenticated();
    return c.json(await buildPlanView(deps, c, requireId(c, 'planId')));
  });

  /**
   * Accept, reject or edit individual proposed changes.
   *
   * Nothing is written to a document here. This only records decisions, which is what
   * makes the workflow review-first: generation is a separate, explicit call that reads
   * only the accepted rows.
   */
  app.patch(
    '/:planId',
    requirePermission('correction:decide'),
    validateJson(DecideCorrectionRequest),
    async (c) => {
      const tenant = c.get('tenant');
      if (!tenant) throw ApiError.unauthenticated();
      const planId = requireId(c, 'planId');
      const input = body<typeof DecideCorrectionRequest._output>(c);

      for (const decision of input.decisions) {
        if (decision.status === 'edited' && !decision.editedContent?.trim()) {
          throw ApiError.badRequest('An edited change must include the replacement text.', {
            [`decisions.${decision.changeId}.editedContent`]: ['Enter the text to use.'],
          });
        }
      }

      await deps.repos.corrections.decide(tenant, planId, input.version, input.decisions);

      const accepted = input.decisions.filter(
        (d) => d.status === 'accepted' || d.status === 'edited',
      ).length;
      const rejected = input.decisions.filter((d) => d.status === 'rejected').length;

      await deps.repos.audit.record({
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
        actorUserId: tenant.userId,
        actorName: c.get('session')?.user.fullName ?? 'Unknown',
        action: 'correction.decided',
        category: 'review',
        targetType: 'correction_plan',
        targetId: planId,
        ipAddress: clientIp(c),
        userAgent: userAgent(c),
        traceId: tenant.traceId,
        summary: `Reviewed ${input.decisions.length} proposed change(s): ${accepted} accepted, ${rejected} rejected.`,
      });

      return c.json(await buildPlanView(deps, c, planId));
    },
  );

  app.post(
    '/:planId/generate',
    requirePermission('correction:generate'),
    validateJson(GenerateCorrectionRequest),
    async (c) => {
      const tenant = c.get('tenant');
      if (!tenant) throw ApiError.unauthenticated();
      const planId = requireId(c, 'planId');
      const input = body<typeof GenerateCorrectionRequest._output>(c);

      const plan = await deps.repos.corrections.getPlan(tenant, planId);
      const accepted = await deps.repos.corrections.acceptedChanges(tenant, planId);

      if (accepted.length === 0) {
        throw ApiError.badRequest(
          'Accept at least one proposed change before generating the corrected edition.',
        );
      }
      if (plan.status === 'generating') {
        throw ApiError.conflict('A corrected edition is already being generated for this plan.');
      }

      await deps.repos.corrections.setPlanStatus(planId, 'generating');

      const { job } = await deps.repos.jobs.enqueue(tenant, {
        kind: 'correction_generate',
        idempotencyKey: input.idempotencyKey,
        payload: {
          planId,
          outputFormat: input.outputFormat,
          includeRedline: input.includeRedline,
        },
        targetType: 'consultation',
        targetId: plan.consultationId,
        priority: 7,
      });

      await deps.repos.audit.record({
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
        actorUserId: tenant.userId,
        actorName: c.get('session')?.user.fullName ?? 'Unknown',
        action: 'correction.generate.requested',
        category: 'artifact',
        targetType: 'correction_plan',
        targetId: planId,
        traceId: tenant.traceId,
        summary: `Requested a corrected edition from ${accepted.length} accepted change(s). The original document is unchanged.`,
      });

      return c.json({ job: toJobView(job) }, 202);
    },
  );

  return app;
}

async function buildPlanView(
  deps: AppDeps,
  c: Context<AppBindings>,
  planId: string,
): Promise<CorrectionPlan> {
  const tenant = c.get('tenant');
  if (!tenant) throw ApiError.unauthenticated();

  const plan = await deps.repos.corrections.getPlan(tenant, planId);
  const changes = await deps.repos.corrections.listChanges(tenant, planId);
  const source = await deps.repos.sources.getById(tenant, plan.sourceId);

  const citations = plan.reviewId
    ? await deps.repos.consultations.listCitationsForReview(tenant, plan.reviewId)
    : [];
  const citationById = new Map(citations.map((row) => [row.id, row]));

  return {
    id: plan.id,
    consultationId: plan.consultationId,
    sourceId: plan.sourceId,
    sourceVersionId: plan.sourceVersionId,
    documentTitle: source.title,
    documentType: source.documentType as CorrectionPlan['documentType'],
    status: plan.status as CorrectionPlan['status'],
    limitations: plan.limitations,
    signatureNotice: plan.signatureNotice,
    outputStrategy: plan.outputStrategy as CorrectionPlan['outputStrategy'],
    createdAt: plan.createdAt.toISOString(),
    generatedArtifactId: plan.generatedArtifactId,
    changes: changes.map((change) => {
      const row = change.governingCitationId
        ? citationById.get(change.governingCitationId)
        : undefined;
      const citation = row ? toCitationView(row, tenant.organizationId) : null;
      return {
        id: change.id,
        planId: change.planId,
        ordinal: change.ordinal,
        locatorLabel: change.locatorLabel,
        pageNumber: change.pageNumber,
        paragraphIndex: change.paragraphIndex,
        sheetName: change.sheetName,
        cellRange: change.cellRange,
        slideNumber: change.slideNumber,
        currentContent: change.currentContent,
        proposedContent: change.proposedContent,
        editedContent: change.editedContent,
        reason: change.reason,
        governingCitationId: change.governingCitationId,
        governingCitation: citation,
        findingId: change.findingId,
        risk: change.risk as CorrectionPlan['changes'][number]['risk'],
        confidence: change.confidence,
        status: change.status as CorrectionPlan['changes'][number]['status'],
      };
    }),
  };
}

function toCitationView(row: Record<string, unknown>, organizationId: string): Citation {
  return {
    citationId: String(row.id),
    tenantId: organizationId,
    sourceId: String(row.sourceId),
    sourceVersionId: String(row.sourceVersionId),
    sourceSha256: String(row.sourceSha256),
    documentTitle: String(row.documentTitle),
    documentType: String(row.documentType) as Citation['documentType'],
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
    boundingBoxes: (row.boundingBoxes as Citation['boundingBoxes'] | undefined) ?? [],
    supportingExcerpt: String(row.supportingExcerpt),
    retrievalScore: Number(row.retrievalScore ?? 0),
    rerankScore: Number(row.rerankScore ?? 0),
    entailment: String(row.entailment) as Citation['entailment'],
    verified: Boolean(row.verified),
    verificationMethod: String(row.verificationMethod) as Citation['verificationMethod'],
    effectiveDate: row.effectiveDate ? new Date(String(row.effectiveDate)).toISOString() : null,
    supersededBy: null,
    createdAt: new Date(String(row.createdAt ?? new Date())).toISOString(),
  };
}

export { formatLocator };
