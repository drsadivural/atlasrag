import { Hono } from 'hono';
import {
  AuditQuery,
  AvailableModelsRequest,
  DashboardQuery,
  InviteUserRequest,
  ResolveAttentionRequest,
  ReportsQuery,
  UpdateSettingsRequest,
  UpdateUserRequest,
  UpsertModelConfigRequest,
  formatLocator,
  type ArtifactSummary,
  type AttentionResponse,
  type AuditEvent,
  type Citation,
  type CitationResolution,
  type DashboardResponse,
  type HealthResponse,
  type ModelConfiguration,
  permissionsForRole,
  type Permission,
  type Role,
  type WorkspaceUser,
} from '@uxe/contracts';
import { findExcerpt } from '@uxe/rag';
import { decryptSecret, encryptSecret, randomToken, sha256Hex } from '@uxe/auth';
import type { TenantContext } from '@uxe/db';
import type { AppBindings, AppDeps } from '../context.js';
import { ApiError } from '../errors.js';
import { body, query, requireId, validateJson, validateQuery } from '../middleware/validate.js';
import { clientIp, requirePermission, userAgent } from '../middleware/index.js';
import { mergeSettings, workspaceSettingsFrom } from '../services/settings.js';
import { EmailTemplates } from '../services/email.js';
import { probeProvider } from '../services/providers.js';
import {
  forCapability,
  listAvailableModels,
  ModelCatalogueError,
} from '../services/model-catalogue.js';

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                  */
/* -------------------------------------------------------------------------- */

/** Most items the bell will show at once. See `GET /attention`. */
const ATTENTION_LIMIT = 50;

export function dashboardRoutes(deps: AppDeps) {
  const app = new Hono<AppBindings>();

  app.get('/', requirePermission('workspace:read'), validateQuery(DashboardQuery), async (c) => {
    const tenant = c.get('tenant');
    const session = c.get('session');
    if (!tenant || !session) throw ApiError.unauthenticated();
    const { days } = query<typeof DashboardQuery._output>(c);

    const now = new Date();
    const since = new Date(now.getTime() - days * 86_400_000);
    const priorSince = new Date(since.getTime() - days * 86_400_000);

    const [current, prior, readySourceCount, recent] = await Promise.all([
      deps.repos.metrics.summary(tenant, since, now),
      deps.repos.metrics.summary(tenant, priorSince, since),
      deps.repos.sources.readyCount(tenant),
      deps.repos.consultations.list(tenant, { page: 1, pageSize: 5, status: 'all' }),
    ]);

    const activity = await deps.repos.metrics.activitySeries(tenant, since, now);
    const outcomes = await deps.repos.metrics.complianceOutcomes(tenant, since, now);

    const owners = new Map<string, { name: string; avatarUrl: string | null }>();
    for (const item of recent.items) {
      if (owners.has(item.ownerUserId)) continue;
      const user = await deps.repos.identity.findUserById(item.ownerUserId);
      owners.set(item.ownerUserId, {
        name: user?.fullName ?? 'Unknown',
        avatarUrl: user?.avatarUrl ?? null,
      });
    }

    const change = (a: number, b: number): number | null => {
      if (b === 0) return a === 0 ? 0 : null;
      return Math.round(((a - b) / b) * 1000) / 10;
    };

    const response: DashboardResponse = {
      greetingName: greetingNameFor(session.user.fullName),
      kpis: [
        {
          key: 'consultations',
          value: current.consultations,
          unit: 'count',
          changePercent: change(current.consultations, prior.consultations),
          comparedToDays: days,
          href: '/consult',
        },
        {
          key: 'documents_reviewed',
          value: current.documentsReviewed,
          unit: 'count',
          changePercent: change(current.documentsReviewed, prior.documentsReviewed),
          comparedToDays: days,
          href: '/knowledge',
        },
        {
          key: 'compliance_rate',
          value: Math.round(current.complianceRate * 100),
          unit: 'percent',
          changePercent: change(current.complianceRate, prior.complianceRate),
          comparedToDays: days,
          href: '/reports?kind=compliance_report',
        },
        {
          key: 'evidence_coverage',
          value: Math.round(current.evidenceCoverage * 100),
          unit: 'percent',
          changePercent: change(current.evidenceCoverage, prior.evidenceCoverage),
          comparedToDays: days,
          href: '/reports',
        },
      ],
      activity: { points: activity, total: activity.reduce((sum, p) => sum + p.consultations, 0) },
      complianceOutcomes: outcomes,
      recentConsultations: recent.items.map((item) => ({
        id: item.id,
        title: item.title,
        status: item.status,
        complianceScore: item.complianceScore,
        sourceCount: item.sourceCount,
        updatedAt: item.updatedAt.toISOString(),
        ownerName: owners.get(item.ownerUserId)?.name ?? 'Unknown',
        ownerAvatarUrl: owners.get(item.ownerUserId)?.avatarUrl ?? null,
      })),
      readySourceCount,
    };

    return c.json(response);
  });

  /**
   * Everything currently needing attention.
   *
   * Its own endpoint because the bell is on every screen and the dashboard payload is not
   * free — KPIs, two time series and the five most recent consultations, to render a
   * number. This is the list itself, so the badge and the page it opens are reading the
   * same thing and cannot disagree.
   *
   * Bounded at fifty, and says when it hit the bound. A count that silently stops at its
   * cap is worse than no count: it reads as "fifty problems" to a workspace that has two
   * hundred.
   */
  app.get('/attention', requirePermission('workspace:read'), async (c) => {
    const tenant = c.get('tenant');
    if (!tenant) throw ApiError.unauthenticated();

    const [failedJobs, attention] = await Promise.all([
      deps.repos.jobs.listFailed(tenant, ATTENTION_LIMIT),
      deps.repos.metrics.attentionItems(tenant, ATTENTION_LIMIT),
    ]);

    const items = [
      ...failedJobs.map((job) => ({
        id: job.id,
        kind: 'failed_job' as const,
        title: `${job.kind.replace(/_/g, ' ')} failed`,
        detail: String(job.error?.message ?? 'The job could not be completed.'),
        severity: 'critical' as const,
        href: `/activity?job=${job.id}`,
      })),
      ...attention,
    ];

    const response: AttentionResponse = {
      items: items.slice(0, ATTENTION_LIMIT),
      total: items.length,
      truncated: items.length > ATTENTION_LIMIT,
    };
    return c.json(response);
  });

  /**
   * Doing something about an item the dashboard raised.
   *
   * Three of the five have a fix this can carry out; two do not, and the difference is
   * kept honest in the response. A failed job is retried, a stale source re-indexed, a
   * finished report marked as read — those are `fixed`, and the item goes because the
   * condition behind it is gone. A non-compliant finding is a statement about a real
   * building, and nothing pressed here makes it untrue: that is `acknowledged`, the
   * finding stays in its review with its evidence, and only the reminder stops.
   */
  app.post(
    '/attention/:id/resolve',
    requirePermission('workspace:read'),
    validateJson(ResolveAttentionRequest),
    async (c) => {
      const tenant = c.get('tenant');
      const session = c.get('session');
      if (!tenant || !session) throw ApiError.unauthenticated();
      const itemId = requireId(c, 'id');
      const input = body<typeof ResolveAttentionRequest._output>(c);

      let outcome: 'fixed' | 'acknowledged' = 'acknowledged';
      let detail = 'Marked as handled. It will not be raised here again.';

      if (input.kind === 'failed_job') {
        requirePermissionOrThrow(tenant, 'source:reprocess');
        await deps.repos.jobs.retry(tenant, itemId);
        outcome = 'fixed';
        detail = 'The job is queued again. It leaves this list once it finishes.';
      } else if (input.kind === 'stale_knowledge') {
        requirePermissionOrThrow(tenant, 'source:reprocess');
        const source = await deps.repos.sources.getById(tenant, itemId);
        const versions = await deps.repos.sources.listVersions(tenant, itemId);
        const version = versions.find((v) => v.id === source.currentVersionId) ?? versions[0];
        if (!version) throw ApiError.badRequest('This source has no stored version to re-index.');
        await deps.repos.jobs.enqueue(tenant, {
          kind: 'source_reprocess',
          // A fresh key per attempt: this is an explicit request to run it again.
          idempotencyKey: `attention-reindex:${source.id}:${Date.now()}`,
          payload: {
            sourceId: source.id,
            sourceVersionId: version.id,
            storageKey: version.storageKey,
            fileName: source.title,
            contentType: version.contentType,
          },
          targetType: 'source',
          targetId: source.id,
        });
        outcome = 'fixed';
        detail = 'Re-indexing has started. The document leaves this list when it completes.';
      } else if (input.kind === 'pending_review') {
        const consultation = await deps.repos.consultations.getById(tenant, itemId);
        await deps.repos.consultations.update(tenant, itemId, consultation.version, {
          status: 'active',
        });
        outcome = 'fixed';
        detail = 'Marked as read.';
      } else {
        // critical_gap and unresolved_evidence: acknowledged, never silently "fixed".
        await deps.repos.metrics.dismissAttentionItem(tenant, {
          kind: input.kind,
          itemId,
          note: input.note ?? null,
        });
      }

      await deps.repos.audit.record({
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
        actorUserId: tenant.userId,
        actorName: session.user.fullName,
        action: outcome === 'fixed' ? 'attention.fixed' : 'attention.acknowledged',
        category: 'consultation',
        targetType: 'attention_item',
        targetId: itemId,
        targetLabel: input.kind,
        ipAddress: clientIp(c),
        userAgent: userAgent(c),
        traceId: tenant.traceId,
        summary:
          outcome === 'fixed'
            ? `Acted on a ${input.kind.replace(/_/g, ' ')} raised on the dashboard.`
            : `Acknowledged a ${input.kind.replace(/_/g, ' ')}${input.note ? `: ${input.note}` : ''}.`,
      });

      return c.json({ outcome, detail });
    },
  );

  return app;
}

/**
 * Refuses when the caller's role lacks the permission a particular fix needs.
 *
 * The route itself only requires `workspace:read`, because looking at the dashboard is not
 * the same as being allowed to re-index a document. Each branch that actually changes
 * something checks for itself.
 */
function requirePermissionOrThrow(tenant: { role: string }, permission: Permission): void {
  if (!permissionsForRole(tenant.role as Role).includes(permission)) {
    throw ApiError.forbidden('Your role cannot do that.');
  }
}

/**
 * The name to greet someone by.
 *
 * Takes the given name, and keeps an honorific attached to it when one is present, so
 * "Dr Sadi Vural" is greeted as "Dr Sadi" rather than as "Vural" — which is how the person
 * is actually addressed.
 */
function greetingNameFor(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fullName;

  const honorifics = new Set([
    'dr',
    'dr.',
    'prof',
    'prof.',
    'mr',
    'mr.',
    'mrs',
    'mrs.',
    'ms',
    'ms.',
    'mx',
    'mx.',
    'sir',
    'eng',
    'eng.',
  ]);
  const first = parts[0] as string;

  if (honorifics.has(first.toLowerCase()) && parts.length > 1) {
    return `${first} ${parts[1]}`;
  }
  return first;
}

/* -------------------------------------------------------------------------- */
/* Citations                                                                  */
/* -------------------------------------------------------------------------- */

export function citationRoutes(deps: AppDeps) {
  const app = new Hono<AppBindings>();

  /**
   * Resolves a citation for the evidence viewer.
   *
   * The page text is returned along with the character offsets of the excerpt inside it,
   * so the viewer can highlight the exact passage and move keyboard focus to it. Offsets
   * are recomputed here rather than trusted from the stored record, so a highlight can
   * never point somewhere the text is not.
   */
  app.get('/:id', requirePermission('source:read'), async (c) => {
    const tenant = c.get('tenant');
    if (!tenant) throw ApiError.unauthenticated();
    const id = requireId(c, 'id');

    const { citation, source, version } = await deps.repos.consultations.getCitation(tenant, id);

    let pageText = '';
    if (citation.pageNumber !== null) {
      const page = await deps.repos.retrieval.getPage(
        tenant,
        citation.sourceVersionId,
        citation.pageNumber,
      );
      pageText = page?.text ?? '';
    }

    const span = pageText ? findExcerpt(pageText, citation.supportingExcerpt) : null;

    const neighbours = citation.messageId
      ? await deps.repos.consultations.listCitationsForMessage(tenant, citation.messageId)
      : citation.reviewId
        ? await deps.repos.consultations.listCitationsForReview(tenant, citation.reviewId)
        : [];
    const index = neighbours.findIndex((n) => n.id === id);

    const download = await deps.services.storage.signedDownloadUrl(
      'originals',
      version.storageKey,
      `${source.title}`,
      deps.env.SIGNED_URL_TTL_SECONDS,
    );

    const resolution: CitationResolution = {
      citation: toCitationContract(citation, tenant.organizationId),
      documentTitle: source.title,
      documentType: source.documentType as Citation['documentType'],
      version: version.version,
      totalPages: version.pages,
      pageText,
      highlight: span ? { start: span.start, end: span.end } : null,
      downloadUrl: download.url,
      previousCitationId: index > 0 ? (neighbours[index - 1]?.id ?? null) : null,
      nextCitationId:
        index >= 0 && index < neighbours.length - 1 ? (neighbours[index + 1]?.id ?? null) : null,
    };

    return c.json(resolution);
  });

  return app;
}

function toCitationContract(row: Record<string, unknown>, organizationId: string): Citation {
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

/* -------------------------------------------------------------------------- */
/* Artifacts                                                                  */
/* -------------------------------------------------------------------------- */

export function artifactRoutes(deps: AppDeps) {
  const app = new Hono<AppBindings>();

  app.get('/', requirePermission('artifact:read'), validateQuery(ReportsQuery), async (c) => {
    const tenant = c.get('tenant');
    if (!tenant) throw ApiError.unauthenticated();
    const params = query<typeof ReportsQuery._output>(c);
    const { items, total } = await deps.repos.artifacts.list(tenant, params);

    const owners = new Map<string, string>();
    for (const { artifact } of items) {
      if (!artifact.createdByUserId || owners.has(artifact.createdByUserId)) continue;
      const user = await deps.repos.identity.findUserById(artifact.createdByUserId);
      owners.set(artifact.createdByUserId, user?.fullName ?? 'Unknown');
    }

    const summaries: ArtifactSummary[] = items.map(
      ({ artifact, consultationTitle, sourceTitle }) => ({
        id: artifact.id,
        title: artifact.title,
        kind: artifact.kind as ArtifactSummary['kind'],
        documentType: artifact.documentType as ArtifactSummary['documentType'],
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256,
        status: artifact.status as ArtifactSummary['status'],
        consultationId: artifact.consultationId,
        consultationTitle: consultationTitle ?? null,
        sourceId: artifact.sourceId,
        sourceVersionId: artifact.sourceVersionId,
        sourceTitle: sourceTitle ?? null,
        generatorDescriptor: artifact.generatorDescriptor,
        ownerName: artifact.createdByUserId
          ? (owners.get(artifact.createdByUserId) ?? 'Unknown')
          : 'System',
        createdAt: artifact.createdAt.toISOString(),
        retainUntil: artifact.retainUntil?.toISOString() ?? null,
        disclosures: artifact.disclosures,
      }),
    );

    return c.json({
      items: summaries,
      total,
      page: params.page,
      pageSize: params.pageSize,
      totalPages: Math.ceil(total / params.pageSize),
    });
  });

  app.get('/:id', requirePermission('artifact:read'), async (c) => {
    const tenant = c.get('tenant');
    if (!tenant) throw ApiError.unauthenticated();
    const artifact = await deps.repos.artifacts.getById(tenant, requireId(c, 'id'));
    return c.json({
      id: artifact.id,
      title: artifact.title,
      kind: artifact.kind,
      documentType: artifact.documentType,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
      status: artifact.status,
      generatorDescriptor: artifact.generatorDescriptor,
      changeLog: artifact.changeLog,
      disclosures: artifact.disclosures,
      validation: artifact.validation,
      createdAt: artifact.createdAt.toISOString(),
    });
  });

  /**
   * Issues a short-lived signed download URL.
   *
   * The permission check happens here, not at the storage layer, and the URL expires in
   * minutes — so a link pasted into a chat becomes useless quickly rather than being a
   * permanent bypass of the ACL.
   */
  app.get('/:id/download', requirePermission('artifact:download'), async (c) => {
    const tenant = c.get('tenant');
    if (!tenant) throw ApiError.unauthenticated();
    const artifact = await deps.repos.artifacts.getById(tenant, requireId(c, 'id'));

    if (artifact.status !== 'ready') {
      throw ApiError.conflict('That artifact is not ready to download yet.');
    }

    const extension = artifact.documentType === 'text' ? 'md' : artifact.documentType;
    const fileName = `${artifact.title.replace(/[^\w\s.-]/g, '')}.${extension}`;
    const signed = await deps.services.storage.signedDownloadUrl(
      'artifacts',
      artifact.storageKey,
      fileName,
      deps.env.SIGNED_URL_TTL_SECONDS,
    );

    await deps.repos.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: tenant.userId,
      actorName: c.get('session')?.user.fullName ?? 'Unknown',
      action: 'artifact.downloaded',
      category: 'artifact',
      targetType: 'artifact',
      targetId: artifact.id,
      targetLabel: artifact.title,
      ipAddress: clientIp(c),
      userAgent: userAgent(c),
      traceId: tenant.traceId,
      summary: `Downloaded "${artifact.title}".`,
    });

    return c.json({ url: signed.url, expiresAt: signed.expiresAt.toISOString(), fileName });
  });

  app.delete('/:id', requirePermission('artifact:delete'), async (c) => {
    const tenant = c.get('tenant');
    if (!tenant) throw ApiError.unauthenticated();
    const id = requireId(c, 'id');
    const artifact = await deps.repos.artifacts.getById(tenant, id);
    await deps.repos.artifacts.softDelete(tenant, id);

    await deps.repos.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: tenant.userId,
      actorName: c.get('session')?.user.fullName ?? 'Unknown',
      action: 'artifact.deleted',
      category: 'deletion',
      targetType: 'artifact',
      targetId: id,
      targetLabel: artifact.title,
      traceId: tenant.traceId,
      summary: `Archived artifact "${artifact.title}".`,
    });

    return c.json({ ok: true as const });
  });

  return app;
}

/* -------------------------------------------------------------------------- */
/* Audit                                                                      */
/* -------------------------------------------------------------------------- */

export function auditRoutes(deps: AppDeps) {
  const app = new Hono<AppBindings>();

  app.get('/', requirePermission('audit:read'), validateQuery(AuditQuery), async (c) => {
    const tenant = c.get('tenant');
    if (!tenant) throw ApiError.unauthenticated();
    const params = query<typeof AuditQuery._output>(c);

    const { items, total } = await deps.repos.audit.list(tenant, {
      ...params,
      from: params.from ? new Date(params.from) : undefined,
      to: params.to ? new Date(params.to) : undefined,
    });

    const events: AuditEvent[] = items.map((row) => ({
      id: row.id,
      at: row.createdAt.toISOString(),
      actorId: row.actorUserId,
      actorName: row.actorName,
      actorType: row.actorType as AuditEvent['actorType'],
      action: row.action,
      category: row.category as AuditEvent['category'],
      targetType: row.targetType,
      targetId: row.targetId,
      targetLabel: row.targetLabel,
      result: row.result as AuditEvent['result'],
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      traceId: row.traceId,
      summary: row.summary,
      before: row.before,
      after: row.after,
    }));

    return c.json({
      items: events,
      total,
      page: params.page,
      pageSize: params.pageSize,
      totalPages: Math.ceil(total / params.pageSize),
    });
  });

  app.get('/export', requirePermission('audit:export'), validateQuery(AuditQuery), async (c) => {
    const tenant = c.get('tenant');
    if (!tenant) throw ApiError.unauthenticated();
    const params = query<typeof AuditQuery._output>(c);

    const { items } = await deps.repos.audit.list(tenant, {
      ...params,
      page: 1,
      pageSize: 5000,
      from: params.from ? new Date(params.from) : undefined,
      to: params.to ? new Date(params.to) : undefined,
    });

    const header = [
      'at',
      'actor',
      'action',
      'category',
      'target',
      'result',
      'ip',
      'traceId',
      'summary',
    ];
    const csv = [
      header.join(','),
      ...items.map((row) =>
        [
          row.createdAt.toISOString(),
          row.actorName,
          row.action,
          row.category,
          row.targetLabel ?? '',
          row.result,
          row.ipAddress ?? '',
          row.traceId,
          row.summary,
        ]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(','),
      ),
    ].join('\n');

    await deps.repos.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: tenant.userId,
      actorName: c.get('session')?.user.fullName ?? 'Unknown',
      action: 'audit.exported',
      category: 'export',
      traceId: tenant.traceId,
      summary: `Exported ${items.length} audit event(s).`,
    });

    c.header('content-type', 'text/csv; charset=utf-8');
    c.header('content-disposition', 'attachment; filename="audit-events.csv"');
    // UTF-8 BOM, so Excel opens the export in the right encoding.
    return c.body(`\uFEFF${csv}`);
  });

  return app;
}

/* -------------------------------------------------------------------------- */
/* Users                                                                      */
/* -------------------------------------------------------------------------- */

export function userRoutes(deps: AppDeps) {
  const app = new Hono<AppBindings>();

  app.get('/', requirePermission('member:read'), async (c) => {
    const tenant = c.get('tenant');
    if (!tenant) throw ApiError.unauthenticated();
    const members = await deps.repos.identity.listMembers(tenant);

    const users: WorkspaceUser[] = await Promise.all(
      members.map(async ({ membership, user, groups, mfaEnabled, activeSessions }) => ({
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        avatarUrl: user.avatarUrl,
        role: membership.role as Role,
        status: membership.status as WorkspaceUser['status'],
        groups,
        mfaEnabled,
        activeSessions,
        lastActiveAt: user.lastActiveAt?.toISOString() ?? null,
        invitedAt: membership.invitedAt?.toISOString() ?? null,
        joinedAt: membership.joinedAt?.toISOString() ?? null,
        accessibleSourceCount: await deps.repos.metrics.accessibleSourceCount(tenant, user.id),
      })),
    );

    return c.json(users);
  });

  app.post(
    '/invite',
    requirePermission('member:invite'),
    validateJson(InviteUserRequest),
    async (c) => {
      const tenant = c.get('tenant');
      const session = c.get('session');
      if (!tenant || !session) throw ApiError.unauthenticated();
      const input = body<typeof InviteUserRequest._output>(c);

      const workspace = await deps.repos.identity.getWorkspace(tenant.workspaceId);
      const settings = workspaceSettingsFrom(
        workspace?.settings ?? {},
        workspace?.name ?? 'Workspace',
      );
      const domains = settings.security.allowedEmailDomains;
      if (domains.length > 0) {
        const domain = input.email.split('@')[1]?.toLowerCase() ?? '';
        if (!domains.map((d) => d.toLowerCase()).includes(domain)) {
          throw ApiError.badRequest(`This workspace only admits ${domains.join(', ')} addresses.`, {
            email: [`Domain "${domain}" is not on the allowlist.`],
          });
        }
      }

      const token = randomToken(32);
      const invitation = await deps.repos.identity.createInvitation(tenant, {
        email: input.email,
        role: input.role,
        tokenHash: await sha256Hex(token),
        groupIds: input.groupIds,
        message: input.message ?? null,
        ttlHours: 168,
      });

      let user = await deps.repos.identity.findUserByEmail(input.email);
      if (!user) {
        user = await deps.repos.identity.createUser({
          email: input.email,
          passwordHash: null,
          fullName: input.email.split('@')[0] ?? input.email,
        });
      }
      await deps.repos.identity.addMembership({
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
        userId: user.id,
        role: input.role,
        status: 'invited',
      });

      const acceptUrl = `${deps.env.PUBLIC_APP_URL}/accept-invite?token=${encodeURIComponent(token)}`;

      /*
       * Whether the message actually went anywhere.
       *
       * The membership is created either way — that part cannot fail for want of a mail
       * server — but saying "invitation sent" when the console driver wrote it to a log is
       * how somebody waits a week for an email that never existed. A deployment with no
       * transport gets the link back instead, which is a working invitation today rather
       * than an apology.
       */
      const driver = deps.services.email.id;
      let delivery: {
        status: 'sent' | 'not_configured' | 'failed';
        detail: string | null;
        acceptUrl: string | null;
      };

      if (driver === 'console') {
        delivery = {
          status: 'not_configured',
          detail:
            'This deployment has no mail transport, so no email was sent. Send the invitation link yourself.',
          acceptUrl,
        };
      } else {
        try {
          await deps.services.email.send({
            to: input.email,
            ...EmailTemplates.invitation({
              inviterName: session.user.fullName,
              workspaceName: workspace?.name ?? 'the workspace',
              role: input.role.replace(/_/g, ' '),
              url: acceptUrl,
              message: input.message ?? null,
            }),
          });
          delivery = { status: 'sent', detail: null, acceptUrl: null };
        } catch (error) {
          // The invitation stands; only the message failed, and the link still works.
          deps.logger.warn('invite.email_failed', {
            driver,
            reason: error instanceof Error ? error.message : 'unknown',
          });
          delivery = {
            status: 'failed',
            detail:
              error instanceof Error
                ? `The mail server refused the message: ${error.message}`
                : 'The mail server refused the message.',
            acceptUrl,
          };
        }
      }

      await deps.repos.audit.record({
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
        actorUserId: tenant.userId,
        actorName: session.user.fullName,
        action: 'member.invited',
        category: 'permission',
        targetType: 'user',
        targetId: user.id,
        targetLabel: input.email,
        ipAddress: clientIp(c),
        userAgent: userAgent(c),
        traceId: tenant.traceId,
        summary: `Invited ${input.email} as ${input.role.replace(/_/g, ' ')}.`,
      });

      return c.json(
        {
          user: {
            id: user.id,
            email: user.email,
            fullName: user.fullName,
            avatarUrl: null,
            role: input.role,
            status: 'invited' as const,
            groups: [],
            mfaEnabled: false,
            activeSessions: 0,
            lastActiveAt: null,
            invitedAt: invitation.createdAt.toISOString(),
            joinedAt: null,
            accessibleSourceCount: 0,
          },
          delivery: { ...delivery, driver },
        },
        201,
      );
    },
  );

  app.delete('/:id', requirePermission('member:remove'), async (c) => {
    const tenant = c.get('tenant');
    const session = c.get('session');
    if (!tenant || !session) throw ApiError.unauthenticated();
    const targetId = requireId(c, 'id');

    const before = await deps.repos.identity.getMembershipAnyStatus(targetId, tenant.workspaceId);
    if (!before) throw ApiError.notFound('Member');
    const user = await deps.repos.identity.findUserById(targetId);

    const { revokedSessions } = await deps.repos.identity.removeMembership(tenant, targetId);

    await deps.repos.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: tenant.userId,
      actorName: session.user.fullName,
      action: 'member.removed',
      category: 'permission',
      targetType: 'user',
      targetId,
      targetLabel: user?.email ?? targetId,
      ipAddress: clientIp(c),
      userAgent: userAgent(c),
      traceId: tenant.traceId,
      summary: `Removed ${user?.fullName ?? targetId} from the workspace${
        revokedSessions > 0 ? `; revoked ${revokedSessions} session(s)` : ''
      }.`,
      before: { role: before.role, status: before.status },
      after: { status: 'removed', deletedAt: new Date().toISOString() },
    });

    return c.body(null, 204);
  });

  app.patch(
    '/:id',
    requirePermission('member:update'),
    validateJson(UpdateUserRequest),
    async (c) => {
      const tenant = c.get('tenant');
      const session = c.get('session');
      if (!tenant || !session) throw ApiError.unauthenticated();
      const targetId = requireId(c, 'id');
      const input = body<typeof UpdateUserRequest._output>(c);

      const before = await deps.repos.identity.getMembershipAnyStatus(targetId, tenant.workspaceId);
      if (!before) throw ApiError.notFound('Member');

      const patch: { role?: Role; status?: 'active' | 'suspended' } = {};
      if (input.role) patch.role = input.role;
      if (input.status) patch.status = input.status;
      const after = await deps.repos.identity.updateMembership(tenant, targetId, patch);

      if (input.groupIds) {
        await deps.repos.identity.setUserGroups(tenant, targetId, input.groupIds);
      }

      let revoked = 0;
      if (
        input.revokeSessions ||
        input.status === 'suspended' ||
        (input.role && input.role !== before.role)
      ) {
        // A privilege change must not leave a live session running at the old level.
        revoked = await deps.repos.identity.revokeAllSessionsForUser(targetId);
      }

      const user = await deps.repos.identity.findUserById(targetId);

      await deps.repos.audit.record({
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
        actorUserId: tenant.userId,
        actorName: session.user.fullName,
        action: 'member.updated',
        category: 'permission',
        targetType: 'user',
        targetId,
        targetLabel: user?.email ?? targetId,
        ipAddress: clientIp(c),
        userAgent: userAgent(c),
        traceId: tenant.traceId,
        summary: `Updated ${user?.fullName ?? targetId}${revoked > 0 ? `; revoked ${revoked} session(s)` : ''}.`,
        before: { role: before.role, status: before.status },
        after: { role: after.role, status: after.status },
      });

      return c.json({
        id: targetId,
        email: user?.email ?? '',
        fullName: user?.fullName ?? '',
        avatarUrl: user?.avatarUrl ?? null,
        role: after.role as Role,
        status: after.status as WorkspaceUser['status'],
        groups: [],
        mfaEnabled: false,
        activeSessions: 0,
        lastActiveAt: user?.lastActiveAt?.toISOString() ?? null,
        invitedAt: after.invitedAt?.toISOString() ?? null,
        joinedAt: after.joinedAt?.toISOString() ?? null,
        accessibleSourceCount: 0,
      });
    },
  );

  return app;
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

export function settingsRoutes(deps: AppDeps) {
  const app = new Hono<AppBindings>();

  app.get('/', requirePermission('settings:read'), async (c) => {
    const tenant = c.get('tenant');
    if (!tenant) throw ApiError.unauthenticated();

    const workspace = await deps.repos.identity.getWorkspace(tenant.workspaceId);
    if (!workspace) throw ApiError.notFound('Workspace');

    const settings = workspaceSettingsFrom(workspace.settings, workspace.name, {
      slug: workspace.slug,
      locale: workspace.locale,
      timezone: workspace.timezone,
      brandColor: workspace.brandColor,
      logoUrl: workspace.logoUrl,
    });

    const configs = await deps.repos.settings.listModelConfigurations(tenant);
    const models: ModelConfiguration[] = configs.map(toModelConfiguration);

    return c.json({ settings, models });
  });

  app.patch(
    '/',
    requirePermission('settings:update'),
    validateJson(UpdateSettingsRequest),
    async (c) => {
      const tenant = c.get('tenant');
      if (!tenant) throw ApiError.unauthenticated();
      const input = body<typeof UpdateSettingsRequest._output>(c);

      const workspace = await deps.repos.identity.getWorkspace(tenant.workspaceId);
      if (!workspace) throw ApiError.notFound('Workspace');

      if (input.security && !['owner', 'admin'].includes(tenant.role)) {
        throw ApiError.forbidden('Only an Owner or Admin can change security settings.');
      }
      if (input.retention && !['owner', 'admin'].includes(tenant.role)) {
        throw ApiError.forbidden('Only an Owner or Admin can change retention settings.');
      }

      const { general, ...rest } = input;
      const merged = mergeSettings(workspace.settings, rest as Record<string, unknown>);

      const columnPatch: Record<string, unknown> = { settings: merged };
      if (general?.workspaceName) columnPatch.name = general.workspaceName;
      if (general?.locale) columnPatch.locale = general.locale;
      if (general?.timezone) columnPatch.timezone = general.timezone;
      if (general?.brandColor) columnPatch.brandColor = general.brandColor;
      if (general?.logoUrl !== undefined) columnPatch.logoUrl = general.logoUrl;

      const updated = await deps.repos.identity.updateWorkspace(tenant, columnPatch);

      if (input.retention) {
        await deps.repos.settings.updateRetentionPolicy(tenant, {
          consultationDays: input.retention.consultationDays,
          artifactDays: input.retention.artifactDays,
          auditDays: input.retention.auditDays,
          purgeGraceDays: input.retention.purgeGraceDays,
          legalHold: input.retention.legalHold,
        });
      }

      await deps.repos.audit.record({
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
        actorUserId: tenant.userId,
        actorName: c.get('session')?.user.fullName ?? 'Unknown',
        action: 'settings.updated',
        category: 'configuration',
        targetType: 'workspace',
        targetId: tenant.workspaceId,
        targetLabel: updated.name,
        ipAddress: clientIp(c),
        userAgent: userAgent(c),
        traceId: tenant.traceId,
        summary: `Updated ${Object.keys(input).join(', ')} settings.`,
        before: workspace.settings,
        after: merged,
      });

      return c.json(
        workspaceSettingsFrom(updated.settings, updated.name, {
          slug: updated.slug,
          locale: updated.locale,
          timezone: updated.timezone,
          brandColor: updated.brandColor,
          logoUrl: updated.logoUrl,
        }),
      );
    },
  );

  app.post(
    '/models',
    requirePermission('settings:models'),
    validateJson(UpsertModelConfigRequest),
    async (c) => {
      const tenant = c.get('tenant');
      if (!tenant) throw ApiError.unauthenticated();
      const input = body<typeof UpsertModelConfigRequest._output>(c);

      /*
       * A key already saved for this provider carries over to another of its models.
       *
       * Configurations are keyed by model, so choosing a different one from the list makes
       * a new row — and asking somebody to paste the same account key again because they
       * moved from one of the provider's models to another is a way of getting a working
       * setup replaced by a broken one. The credential belongs to the account, not to the
       * model name.
       */
      let inherited: string | null = null;
      let inheritedLast4: string | null = null;
      if (input.provider !== 'deterministic' && !input.apiKey) {
        const existing = await deps.repos.settings.listModelConfigurations(tenant);
        const forProvider = existing.filter(
          (row) => row.provider === input.provider && row.credentialEncrypted,
        );
        // This row's own key first: a workspace holding two keys for one provider must not
        // have one of them quietly replaced by the other on an unrelated edit.
        const donor =
          forProvider.find(
            (row) => row.capability === input.capability && row.model === input.model,
          ) ?? forProvider[0];
        inherited = donor?.credentialEncrypted ?? null;
        inheritedLast4 = donor?.credentialLast4 ?? null;
        if (!inherited) {
          throw ApiError.badRequest(
            `${input.provider} needs an API key before it can be enabled.`,
            {
              apiKey: ['Provide an API key for this provider.'],
            },
          );
        }
      }

      const config = await deps.repos.settings.upsertModelConfiguration(tenant, {
        capability: input.capability,
        provider: input.provider,
        model: input.model,
        // Only OpenAI takes one. Storing it against another provider would put a setting
        // in the database that nothing reads and the form would show back as if it applied.
        reasoningEffort: input.provider === 'openai' ? input.reasoningEffort : null,
        isPrimary: input.isPrimary,
        isFallback: input.isFallback,
        enabled: input.enabled,
        // Encrypted before it touches the database; there is no read path back out.
        credentialEncrypted: input.apiKey
          ? await encryptSecret(input.apiKey, deps.env.ENCRYPTION_KEY)
          : inherited,
        credentialLast4: input.apiKey ? input.apiKey.slice(-4) : inheritedLast4,
      });

      await deps.repos.audit.record({
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
        actorUserId: tenant.userId,
        actorName: c.get('session')?.user.fullName ?? 'Unknown',
        action: 'settings.model.configured',
        category: 'configuration',
        targetType: 'model_configuration',
        targetId: config.id,
        targetLabel: `${input.provider}:${input.model}`,
        traceId: tenant.traceId,
        // The key itself is never recorded, only the fact that one was supplied.
        summary: `Configured ${input.provider} ${input.model} for ${input.capability}${input.apiKey ? ' with a new credential' : ''}.`,
      });

      return c.json(toModelConfiguration(config));
    },
  );

  /**
   * The models a provider will serve for this workspace's key.
   *
   * The key may be one just typed into the form and not yet saved, so it is accepted in
   * the body; otherwise the workspace's stored credential is used, and failing that the
   * deployment's own. Nothing is ever echoed back — the response is a list of identifiers.
   */
  app.post(
    '/models/available',
    requirePermission('settings:models'),
    validateJson(AvailableModelsRequest),
    async (c) => {
      const tenant = c.get('tenant');
      if (!tenant) throw ApiError.unauthenticated();
      const input = body<typeof AvailableModelsRequest._output>(c);

      const apiKey = input.apiKey || (await resolveProviderKey(deps, tenant, input.provider));
      if (!apiKey) {
        throw new ApiError(
          400,
          'provider_unconfigured',
          `No API key is stored for ${input.provider}. Enter one above, or set ${input.provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'} for this deployment.`,
          { details: { provider: input.provider } },
        );
      }

      try {
        const models = await listAvailableModels(input.provider, apiKey);
        return c.json({
          provider: input.provider,
          models: forCapability(models, input.capability),
        });
      } catch (error) {
        if (error instanceof ModelCatalogueError) {
          // A rejected key is the caller's to fix; anything else is the provider's, and is
          // reported as a dependency rather than as a bad request.
          throw error.status === 401 || error.status === 403
            ? new ApiError(400, 'provider_unconfigured', error.message)
            : new ApiError(502, 'dependency_unavailable', error.message, {
                retryable: error.retryable,
              });
        }
        throw error;
      }
    },
  );

  app.post('/models/:id/test', requirePermission('settings:models'), async (c) => {
    const tenant = c.get('tenant');
    if (!tenant) throw ApiError.unauthenticated();
    const config = await deps.repos.settings.getModelConfiguration(tenant, requireId(c, 'id'));

    const health = await probeProvider(deps, config);
    await deps.repos.settings.setModelHealth(config.id, health.status, health.detail, {
      resetFailures: health.status === 'healthy',
      // A failing provider is circuit-broken for five minutes so every request does not
      // pay its timeout.
      ...(health.status === 'degraded' ? { openCircuitMs: 5 * 60_000 } : {}),
    });

    const refreshed = await deps.repos.settings.getModelConfiguration(tenant, config.id);
    return c.json(toModelConfiguration(refreshed));
  });

  app.delete('/models/:id', requirePermission('settings:models'), async (c) => {
    const tenant = c.get('tenant');
    if (!tenant) throw ApiError.unauthenticated();
    const id = requireId(c, 'id');
    const config = await deps.repos.settings.getModelConfiguration(tenant, id);

    await deps.repos.settings.deleteModelConfiguration(tenant, id);

    // Removing a provider changes what answers are produced with, so it belongs in the
    // trail beside the changes that added it. The key itself never appears here.
    await deps.repos.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: tenant.userId,
      actorName: c.get('session')?.user.fullName ?? 'Unknown',
      action: 'settings.model_removed',
      category: 'settings',
      targetType: 'model_configuration',
      targetId: id,
      targetLabel: `${config.provider} ${config.model}`,
      ipAddress: clientIp(c),
      userAgent: userAgent(c),
      traceId: tenant.traceId,
      summary: `Removed the ${config.capability} provider ${config.provider} ${config.model}.`,
    });

    return c.body(null, 204);
  });

  return app;
}

function toModelConfiguration(row: {
  id: string;
  capability: string;
  provider: string;
  model: string;
  reasoningEffort: string | null;
  isPrimary: boolean;
  isFallback: boolean;
  enabled: boolean;
  credentialEncrypted: string | null;
  credentialLast4: string | null;
  health: string;
  healthDetail: string | null;
  lastCheckedAt: Date | null;
  tokensUsed30d: number;
  requestsUsed30d: number;
  quotaLimit: number | null;
  updatedAt: Date;
}): ModelConfiguration {
  return {
    id: row.id,
    capability: row.capability as ModelConfiguration['capability'],
    provider: row.provider as ModelConfiguration['provider'],
    model: row.model,
    reasoningEffort: row.reasoningEffort as ModelConfiguration['reasoningEffort'],
    isPrimary: row.isPrimary,
    isFallback: row.isFallback,
    enabled: row.enabled,
    // Whether a credential exists, and the four characters that let its owner recognise
    // which one. Never any part that could be used.
    hasCredential: row.credentialEncrypted !== null,
    credentialLast4: row.credentialLast4,
    health: row.health as ModelConfiguration['health'],
    healthDetail: row.healthDetail,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    tokensUsed30d: row.tokensUsed30d,
    requestsUsed30d: row.requestsUsed30d,
    quotaLimit: row.quotaLimit,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* System                                                                     */
/* -------------------------------------------------------------------------- */

export function systemRoutes(deps: AppDeps) {
  const app = new Hono<AppBindings>();

  app.get('/health', (c) =>
    c.json({
      status: 'ok' as const,
      version: '1.0.0',
      checks: [],
      at: new Date().toISOString(),
    } satisfies HealthResponse),
  );

  /**
   * Readiness verifies every dependency the app cannot serve without.
   *
   * Details are limited to a name, a status and a latency: enough for an operator to see
   * which dependency is unhealthy, without exposing connection strings or credentials to
   * an unauthenticated probe.
   */
  app.get('/ready', async (c) => {
    const checks: HealthResponse['checks'] = [];

    const dbStarted = Date.now();
    let dbOk = true;
    try {
      await deps.repos.metrics.ping();
    } catch {
      dbOk = false;
    }
    checks.push({
      name: 'database',
      status: dbOk ? 'ok' : 'down',
      latencyMs: Date.now() - dbStarted,
      detail: dbOk ? null : 'Could not reach PostgreSQL.',
    });

    const worker = await deps.services.documentWorker.health();
    checks.push({
      name: 'document-worker',
      status: worker.ok ? 'ok' : 'degraded',
      latencyMs: worker.latencyMs,
      detail: worker.ok ? null : 'Extraction, OCR and correction are unavailable.',
    });

    const storage = await deps.services.storage.health();
    checks.push({
      name: 'storage',
      status: storage.ok ? 'ok' : 'down',
      latencyMs: null,
      detail: storage.ok ? null : 'Object storage is unreachable.',
    });

    const status = checks.some((check) => check.status === 'down')
      ? ('down' as const)
      : checks.some((check) => check.status === 'degraded')
        ? ('degraded' as const)
        : ('ok' as const);

    return c.json(
      { status, version: '1.0.0', checks, at: new Date().toISOString() } satisfies HealthResponse,
      status === 'down' ? 503 : 200,
    );
  });

  app.get('/metrics', (c) => {
    c.header('content-type', 'text/plain; version=0.0.4');
    return c.body(deps.metrics.toPrometheus());
  });

  return app;
}

export { formatLocator };

/**
 * The key to ask a provider with: the workspace's own first, then the deployment's.
 *
 * A workspace that brings its own key is asking about its own account, and the answer can
 * differ — model availability is granted per organisation.
 */
async function resolveProviderKey(
  deps: AppDeps,
  tenant: TenantContext,
  provider: 'openai' | 'anthropic',
): Promise<string> {
  const stored = await deps.repos.settings.listModelConfigurations(tenant);
  const row = stored.find((entry) => entry.provider === provider && entry.credentialEncrypted);
  if (row?.credentialEncrypted) {
    return decryptSecret(row.credentialEncrypted, deps.env.ENCRYPTION_KEY);
  }
  return provider === 'openai' ? deps.env.OPENAI_API_KEY : deps.env.ANTHROPIC_API_KEY;
}
