import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  BulkSourceActionRequest,
  CreateConnectorRequest,
  CreateUploadRequest,
  SourcesQuery,
  UpdateSourceRequest,
  type SourceDetail,
  type SourceSummary,
  type SourcesResponse,
} from '@uxe/contracts';
import { computeKnowledgeHealth, KNOWLEDGE_HEALTH_FORMULA } from '@uxe/rag';
import type { TenantContext } from '@uxe/db';
import type { AppBindings, AppDeps } from '../context.js';
import { ApiError } from '../errors.js';
import { body, query, requireId, validateJson, validateQuery } from '../middleware/validate.js';
import { clientIp, requirePermission, userAgent } from '../middleware/index.js';
import { RateLimitBuckets } from '../services/rate-limit.js';
import { buildStorageKey } from '../services/storage.js';
import { canonicalizeUrl, safeFetch, SsrfError } from '../services/url-fetch.js';
import { toJobView } from './jobs.js';

export function sourceRoutes(deps: AppDeps) {
  const app = new Hono<AppBindings>();

  /* ---------------------------------------------------------------------- */
  /* List                                                                   */
  /* ---------------------------------------------------------------------- */

  app.get('/', requirePermission('source:read'), validateQuery(SourcesQuery), async (c) => {
    const tenant = c.get('tenant');
    if (!tenant) throw ApiError.unauthenticated();
    const params = query<typeof SourcesQuery._output>(c);

    const [{ items, total }, counts, health] = await Promise.all([
      deps.repos.sources.list(tenant, params),
      deps.repos.sources.statusCounts(tenant),
      deps.repos.sources.healthMetrics(tenant),
    ]);

    const ownerIds = [
      ...new Set(items.map((s) => s.ownerUserId).filter((v): v is string => v !== null)),
    ];
    const owners = new Map<string, string>();
    for (const id of ownerIds) {
      const user = await deps.repos.identity.findUserById(id);
      if (user) owners.set(id, user.fullName);
    }

    const versionByCurrent = new Map<
      string,
      { version: string; pages: number | null; sizeBytes: number }
    >();
    for (const source of items) {
      if (!source.currentVersionId) continue;
      const versions = await deps.repos.sources.listVersions(tenant, source.id);
      const current = versions.find((v) => v.id === source.currentVersionId);
      if (current) {
        versionByCurrent.set(source.id, {
          version: current.version,
          pages: current.pages,
          sizeBytes: current.sizeBytes,
        });
      }
    }

    const summaries: SourceSummary[] = items.map((source) => {
      const version = versionByCurrent.get(source.id);
      return {
        id: source.id,
        title: source.title,
        documentType: source.documentType as SourceSummary['documentType'],
        status: source.status as SourceSummary['status'],
        pages: version?.pages ?? null,
        currentVersion: version?.version ?? 'v1.0',
        currentVersionId: source.currentVersionId,
        accessScope: source.accessScope as SourceSummary['accessScope'],
        accessLabel: accessLabel(source.accessScope),
        tags: source.tags,
        ownerName: source.ownerUserId ? (owners.get(source.ownerUserId) ?? 'Unknown') : 'System',
        sizeBytes: version?.sizeBytes ?? null,
        lastSyncedAt: source.lastSyncedAt?.toISOString() ?? null,
        updatedAt: source.updatedAt.toISOString(),
        createdAt: source.createdAt.toISOString(),
        connectorKind: source.connectorKind,
        failureReason: source.failureReason,
        processingPercent: await0(source.status),
        isPromotedUpload: source.promotedToKnowledge,
        effectiveDate: source.effectiveDate?.toISOString() ?? null,
        version: source.version,
      };
    });

    const pipeline = await buildPipelineView(deps, tenant.workspaceId);

    const response: SourcesResponse = {
      items: summaries,
      total,
      page: params.page,
      pageSize: params.pageSize,
      totalPages: Math.ceil(total / params.pageSize),
      counts,
      pipeline,
      knowledgeHealth: {
        score: computeKnowledgeHealth(health),
        ready: health.ready,
        processing: health.processing,
        needsReview: health.needsReview,
        failed: health.failed,
        formula: KNOWLEDGE_HEALTH_FORMULA,
      },
    };

    return c.json(response);
  });

  /* ---------------------------------------------------------------------- */
  /* Detail                                                                 */
  /* ---------------------------------------------------------------------- */

  /** Builds the full source document; shared by GET and by PATCH's response. */
  async function buildSourceDetail(tenant: TenantContext, id: string): Promise<SourceDetail> {
    const source = await deps.repos.sources.getById(tenant, id);
    const versions = await deps.repos.sources.listVersions(tenant, id);
    const permissions = await deps.repos.sources.listPermissions(tenant, id);
    const jobs = await deps.repos.jobs.listForTarget(tenant, 'source', id);
    const current = versions.find((v) => v.id === source.currentVersionId) ?? versions[0] ?? null;
    const structure = current
      ? await deps.repos.sources.structureCounts(current.id)
      : { headings: 0, clauses: 0, tables: 0, definitions: 0, chunks: 0 };

    const owner = source.ownerUserId
      ? await deps.repos.identity.findUserById(source.ownerUserId)
      : null;
    const creators = new Map<string, string>();
    for (const version of versions) {
      if (!version.createdByUserId || creators.has(version.createdByUserId)) continue;
      const user = await deps.repos.identity.findUserById(version.createdByUserId);
      creators.set(version.createdByUserId, user?.fullName ?? 'Unknown');
    }

    const detail: SourceDetail = {
      id: source.id,
      title: source.title,
      description: source.description,
      documentType: source.documentType as SourceDetail['documentType'],
      status: source.status as SourceDetail['status'],
      pages: current?.pages ?? null,
      currentVersion: current?.version ?? 'v1.0',
      currentVersionId: source.currentVersionId,
      accessScope: source.accessScope as SourceDetail['accessScope'],
      accessLabel: accessLabel(source.accessScope),
      tags: source.tags,
      ownerName: owner?.fullName ?? 'System',
      sizeBytes: current?.sizeBytes ?? null,
      lastSyncedAt: source.lastSyncedAt?.toISOString() ?? null,
      updatedAt: source.updatedAt.toISOString(),
      createdAt: source.createdAt.toISOString(),
      connectorKind: source.connectorKind,
      failureReason: source.failureReason,
      processingPercent: await0(source.status),
      isPromotedUpload: source.promotedToKnowledge,
      effectiveDate: source.effectiveDate?.toISOString() ?? null,
      version: source.version,
      versions: versions.map((v) => ({
        id: v.id,
        version: v.version,
        sha256: v.sha256,
        normalizedSha256: v.normalizedSha256,
        pages: v.pages,
        sizeBytes: v.sizeBytes,
        status: v.status as SourceDetail['status'],
        isCurrent: v.isCurrent,
        createdAt: v.createdAt.toISOString(),
        promotedAt: v.promotedAt?.toISOString() ?? null,
        createdByName: v.createdByUserId
          ? (creators.get(v.createdByUserId) ?? 'Unknown')
          : 'System',
        ocrApplied: v.ocrApplied,
        ocrConfidence: v.ocrConfidence,
        extractionCoverage: v.extractionCoverage,
        notes: v.notes,
      })),
      permissions: await Promise.all(
        permissions.map(async (p) => ({
          id: p.id,
          scope: p.scope as SourceDetail['accessScope'],
          subjectId: p.userId ?? p.groupId,
          subjectLabel: await subjectLabel(deps, p.userId, p.groupId),
          capability: p.capability as 'read' | 'manage',
        })),
      ),
      syncHistory: jobs
        .filter((j) => j.kind === 'source_sync')
        .map((j) => ({
          id: j.id,
          at: (j.finishedAt ?? j.createdAt).toISOString(),
          result: j.status === 'succeeded' ? ('success' as const) : ('failed' as const),
          detail: j.error ? String(j.error.message ?? '') : 'Synced successfully',
        })),
      processingLog: (
        await Promise.all(
          jobs.map(async (job) => {
            const attempts = await deps.repos.jobs.listAttempts(job.id);
            return attempts.map((attempt) => ({
              id: attempt.id,
              stage: attempt.stage ?? job.kind,
              status: attempt.status as SourceDetail['processingLog'][number]['status'],
              message:
                attempt.message ??
                (attempt.error ? String(attempt.error.message ?? '') : 'Completed'),
              at: attempt.startedAt.toISOString(),
              attempt: attempt.attempt,
            }));
          }),
        )
      ).flat(),
      structure,
      quarantine: source.quarantine
        ? {
            reason: String(source.quarantine.reason ?? ''),
            patterns: (source.quarantine.patterns as string[] | undefined) ?? [],
            excerpt: String(source.quarantine.excerpt ?? ''),
          }
        : null,
    };

    return detail;
  }

  app.get('/:id', requirePermission('source:read'), async (c) => {
    const tenant = c.get('tenant');
    if (!tenant) throw ApiError.unauthenticated();
    return c.json(await buildSourceDetail(tenant, requireId(c, 'id')));
  });

  app.get('/:id/versions', requirePermission('source:read'), async (c) => {
    const tenant = c.get('tenant');
    if (!tenant) throw ApiError.unauthenticated();
    const versions = await deps.repos.sources.listVersions(tenant, requireId(c, 'id'));
    return c.json(
      versions.map((v) => ({
        id: v.id,
        version: v.version,
        sha256: v.sha256,
        normalizedSha256: v.normalizedSha256,
        pages: v.pages,
        sizeBytes: v.sizeBytes,
        status: v.status,
        isCurrent: v.isCurrent,
        createdAt: v.createdAt.toISOString(),
        promotedAt: v.promotedAt?.toISOString() ?? null,
        createdByName: 'Unknown',
        ocrApplied: v.ocrApplied,
        ocrConfidence: v.ocrConfidence,
        extractionCoverage: v.extractionCoverage,
        notes: v.notes,
      })),
    );
  });

  /* ---------------------------------------------------------------------- */
  /* Uploads                                                                */
  /* ---------------------------------------------------------------------- */

  app.post(
    '/uploads',
    requirePermission('source:create'),
    validateJson(CreateUploadRequest),
    async (c) => {
      const tenant = c.get('tenant');
      if (!tenant) throw ApiError.unauthenticated();
      const input = body<typeof CreateUploadRequest._output>(c);

      const limit = await deps.services.rateLimiter.check(
        RateLimitBuckets.uploadByWorkspace(tenant.workspaceId),
        deps.env.RATE_LIMIT_UPLOAD_PER_HOUR,
        3600,
      );
      if (!limit.allowed) throw ApiError.rateLimited(limit.retryAfterSeconds);

      const tickets = [];
      for (const file of input.files) {
        if (file.sizeBytes > deps.env.MAX_UPLOAD_BYTES) {
          throw new ApiError(
            413,
            'payload_too_large',
            `${file.fileName} is ${Math.round(file.sizeBytes / 1_048_576)} MB, above the ${Math.round(deps.env.MAX_UPLOAD_BYTES / 1_048_576)} MB limit.`,
          );
        }

        const source = await deps.repos.sources.create(tenant, {
          title: stripExtension(file.fileName),
          documentType: 'unknown',
          tags: input.tags,
          accessScope: input.accessScope,
          promotedToKnowledge: input.promoteToKnowledge,
          status: 'pending',
        });

        const storageKey = buildStorageKey({
          organizationId: tenant.organizationId,
          workspaceId: tenant.workspaceId,
          kind: 'source',
          id: source.id,
          fileName: file.fileName,
        });

        const ticket = await deps.repos.uploads.create(tenant, {
          sourceId: source.id,
          fileName: file.fileName,
          contentType: file.contentType,
          declaredBytes: file.sizeBytes,
          storageKey,
          promoteToKnowledge: input.promoteToKnowledge,
          tags: input.tags,
          accessScope: input.accessScope,
        });

        tickets.push({
          uploadId: ticket.id,
          sourceId: source.id,
          fileName: file.fileName,
          // Relative, so the browser uploads to the origin it loaded the app from and the
          // session cookie travels. An absolute URL to another origin makes the request
          // cross-site, and a SameSite=Lax cookie is not sent on one — the upload would
          // arrive unauthenticated.
          uploadUrl: `/api/v1/sources/uploads/${ticket.id}/content`,
          method: 'PUT' as const,
          headers: { 'content-type': file.contentType },
          expiresAt: ticket.expiresAt.toISOString(),
          maxBytes: deps.env.MAX_UPLOAD_BYTES,
        });
      }

      await deps.repos.audit.record({
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
        actorUserId: tenant.userId,
        actorName: c.get('session')?.user.fullName ?? 'Unknown',
        action: 'source.upload.requested',
        category: 'source',
        result: 'success',
        ipAddress: clientIp(c),
        userAgent: userAgent(c),
        traceId: tenant.traceId,
        summary: `Requested upload tickets for ${input.files.length} file(s).`,
      });

      return c.json({ tickets }, 201);
    },
  );

  /**
   * Receives the bytes for an upload ticket.
   *
   * The body is streamed to storage and only then queued for ingestion, so a client that
   * disconnects mid-upload leaves a pending ticket rather than a half-indexed source.
   */
  app.put('/uploads/:ticketId/content', requirePermission('source:create'), async (c) => {
    const tenant = c.get('tenant');
    if (!tenant) throw ApiError.unauthenticated();
    const ticketId = requireId(c, 'ticketId');

    const ticket = await deps.repos.uploads.findPending(tenant, ticketId);
    if (!ticket) throw ApiError.notFound('Upload');

    const chunk = readChunkHeaders(c);
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength === 0) throw ApiError.badRequest('The uploaded file is empty.');

    /*
     * Large files arrive in parts.
     *
     * Not because this server cannot take them whole — it can — but because a proxy in
     * front of it usually will not. Cloudflare refuses a request body over 100MB on most
     * plans, and it refuses it at the edge, so a single-shot upload of a large document
     * never reaches this code at all. Parts keep every individual request small enough to
     * survive the trip, whatever sits in the middle.
     */
    if (chunk) {
      await deps.services.storage.put(
        'originals',
        partKey(ticket.storageKey, chunk.index),
        body,
        'application/octet-stream',
      );

      if (chunk.index < chunk.total) {
        return c.json({ received: chunk.index, of: chunk.total, complete: false }, 202);
      }
    }

    const bytes = chunk ? await assembleParts(deps, ticket.storageKey, chunk.total) : body;

    if (bytes.byteLength > deps.env.MAX_UPLOAD_BYTES) {
      await discardParts(deps, ticket.storageKey, chunk?.total ?? 0);
      throw new ApiError(413, 'payload_too_large', 'That file exceeds the upload limit.');
    }
    // The ticket declared a size and the quota was reserved against it. Accepting a
    // different number of bytes would make that declaration meaningless.
    if (bytes.byteLength !== ticket.declaredBytes) {
      await discardParts(deps, ticket.storageKey, chunk?.total ?? 0);
      throw ApiError.badRequest(
        `This upload is ${bytes.byteLength} bytes but the ticket was issued for ${ticket.declaredBytes}. Start the upload again.`,
      );
    }

    const stored = await deps.services.storage.put(
      'originals',
      ticket.storageKey,
      bytes,
      ticket.contentType,
    );
    // The assembled object is the file now; the parts are scratch and go immediately.
    await discardParts(deps, ticket.storageKey, chunk?.total ?? 0);

    const sourceId = ticket.sourceId;
    await deps.repos.uploads.markReceived(ticketId, stored.sizeBytes);

    // Workspace-wide duplicate check, before a version is created. Re-uploading a file the
    // workspace already holds points at the existing source instead of creating a second
    // copy that would need de-duplicating and re-permissioning later.
    const existing = await deps.repos.sources.findDuplicateInWorkspace(
      tenant,
      stored.sha256,
      sourceId,
    );
    if (existing) {
      await deps.repos.sources.discardEmptySource(tenant, sourceId);
      await deps.services.storage.delete('originals', stored.key);

      /*
       * Already indexed is not the same as already attached.
       *
       * Sending a document into a conversation says "review this", and answering "we
       * already have those bytes" leaves the conversation with nothing to review — the
       * upload appears to succeed and the answer comes back about the regulations alone.
       * The existing source is attached instead, which is the same outcome without the
       * second copy.
       */
      if (ticket.consultationId) {
        await deps.repos.consultations.addSource(
          tenant,
          ticket.consultationId,
          existing.source.id,
          existing.version.id,
          'project',
        );
      }

      /*
       * Nor is it the same as already published.
       *
       * Uploading a code on the Knowledge page says "this governs". If the workspace
       * happens to hold the same bytes from a consultation upload, deduplicating onto that
       * copy silently answered "already in your knowledge base" about a document that was
       * not in the knowledge base at all — leaving the screen showing success, the
       * knowledge base empty, and every later review with nothing to judge against. The
       * dedupe is right; skipping the promotion it asked for was not.
       *
       * Only ever in this direction. A consultation upload never demotes a published
       * source: the request that publishes is the one that counts.
       */
      const promoted =
        ticket.promoteToKnowledge && !existing.source.promotedToKnowledge
          ? await deps.repos.sources.promoteToKnowledge(tenant, existing.source.id)
          : null;

      if (promoted) {
        await deps.repos.audit.record({
          organizationId: tenant.organizationId,
          workspaceId: tenant.workspaceId,
          actorUserId: tenant.userId,
          actorName: c.get('session')?.user.fullName ?? 'Unknown',
          action: 'source.promoted',
          category: 'source',
          targetType: 'source',
          targetId: existing.source.id,
          targetLabel: existing.source.title,
          traceId: tenant.traceId,
          summary: `Published "${existing.source.title}" to the knowledge base by re-uploading it there.`,
        });
      }

      return c.json({
        sourceId: existing.source.id,
        versionId: existing.version.id,
        duplicate: true,
        message: ticket.consultationId
          ? `These exact bytes are already indexed as "${existing.source.title}" (${existing.version.version}), so that copy has been attached to this consultation.`
          : promoted
            ? `The workspace already held these exact bytes as "${existing.source.title}" (${existing.version.version}). That copy is now published to the knowledge base; no duplicate was created.`
            : existing.source.promotedToKnowledge
              ? `These exact bytes are already in your knowledge base as "${existing.source.title}" (${existing.version.version}). No duplicate was created.`
              : `The workspace already holds these exact bytes as "${existing.source.title}" (${existing.version.version}), which is not part of the knowledge base. No duplicate was created.`,
        job: null,
      });
    }

    const { version, duplicate } = await deps.repos.sources.createVersion(tenant, {
      sourceId,
      sha256: stored.sha256,
      storageKey: stored.key,
      contentType: ticket.contentType,
      sizeBytes: stored.sizeBytes,
    });

    if (duplicate) {
      // Same bytes re-uploaded as a new version of the same source: nothing changed.
      await deps.repos.sources.setSourceStatus(sourceId, { status: 'ready' });
      if (ticket.consultationId) {
        await deps.repos.consultations.addSource(
          tenant,
          ticket.consultationId,
          sourceId,
          version.id,
          'project',
        );
      }
      return c.json({
        sourceId,
        versionId: version.id,
        duplicate: true,
        message: 'This version already exists with identical content, so nothing was re-indexed.',
        job: null,
      });
    }

    const { job } = await deps.repos.jobs.enqueue(tenant, {
      kind: 'source_ingest',
      idempotencyKey: `ingest:${version.id}`,
      payload: {
        sourceId,
        sourceVersionId: version.id,
        storageKey: stored.key,
        fileName: ticket.fileName,
        contentType: ticket.contentType,
        // Carried so the finished document can be attached to the conversation that asked
        // for it. It cannot be attached now: a source with no promoted version has nothing
        // to pin, and pinning the version is what makes an answer reproducible.
        consultationId: ticket.consultationId,
      },
      targetType: 'source',
      targetId: sourceId,
    });

    return c.json({ sourceId, versionId: version.id, duplicate: false, job: toJobView(job) }, 202);
  });

  /* ---------------------------------------------------------------------- */
  /* Connectors                                                             */
  /* ---------------------------------------------------------------------- */

  app.post(
    '/connectors',
    requirePermission('source:create'),
    validateJson(CreateConnectorRequest),
    async (c) => {
      const tenant = c.get('tenant');
      if (!tenant) throw ApiError.unauthenticated();
      const input = body<typeof CreateConnectorRequest._output>(c);

      if (input.kind === 'text') {
        const bytes = new TextEncoder().encode(input.content);
        const source = await deps.repos.sources.create(tenant, {
          title: input.title,
          documentType: 'text',
          tags: input.tags,
          promotedToKnowledge: true,
          connectorKind: 'text',
          status: 'pending',
        });

        const key = buildStorageKey({
          organizationId: tenant.organizationId,
          workspaceId: tenant.workspaceId,
          kind: 'source',
          id: source.id,
          fileName: `${input.title}.txt`,
        });
        const stored = await deps.services.storage.put('originals', key, bytes, 'text/plain');
        const { version } = await deps.repos.sources.createVersion(tenant, {
          sourceId: source.id,
          sha256: stored.sha256,
          storageKey: stored.key,
          contentType: 'text/plain',
          sizeBytes: stored.sizeBytes,
        });

        const { job } = await deps.repos.jobs.enqueue(tenant, {
          kind: 'source_ingest',
          idempotencyKey: `ingest:${version.id}`,
          payload: {
            sourceId: source.id,
            sourceVersionId: version.id,
            storageKey: stored.key,
            fileName: `${input.title}.txt`,
            contentType: 'text/plain',
          },
          targetType: 'source',
          targetId: source.id,
        });

        return c.json({ sourceId: source.id, job: toJobView(job) }, 202);
      }

      if (input.kind === 'website') {
        const canonical = canonicalizeUrl(input.url);
        let fetched;
        try {
          fetched = await safeFetch(canonical, {
            allowedSchemes: deps.env.URL_INGEST_ALLOWED_SCHEMES.split(','),
            blockPrivateNetworks: deps.env.URL_INGEST_BLOCK_PRIVATE_NETWORKS,
            maxBytes: Math.min(deps.env.MAX_UPLOAD_BYTES, 50 * 1024 * 1024),
            timeoutMs: 20_000,
            maxRedirects: 4,
            allowedDomains: input.allowedDomains,
          });
        } catch (error) {
          if (error instanceof SsrfError)
            throw ApiError.badRequest(error.message, { url: [error.message] });
          throw error;
        }

        const source = await deps.repos.sources.create(tenant, {
          title: canonical,
          documentType: fetched.contentType.includes('pdf') ? 'pdf' : 'html',
          promotedToKnowledge: true,
          connectorKind: 'website',
          externalUrl: fetched.finalUrl,
          status: 'pending',
        });

        const key = buildStorageKey({
          organizationId: tenant.organizationId,
          workspaceId: tenant.workspaceId,
          kind: 'source',
          id: source.id,
          fileName: 'page.html',
        });
        const stored = await deps.services.storage.put(
          'originals',
          key,
          fetched.bytes,
          fetched.contentType,
        );
        const { version } = await deps.repos.sources.createVersion(tenant, {
          sourceId: source.id,
          sha256: stored.sha256,
          storageKey: stored.key,
          contentType: fetched.contentType,
          sizeBytes: stored.sizeBytes,
        });

        const { job } = await deps.repos.jobs.enqueue(tenant, {
          kind: 'source_ingest',
          idempotencyKey: `ingest:${version.id}`,
          payload: {
            sourceId: source.id,
            sourceVersionId: version.id,
            storageKey: stored.key,
            fileName: 'page.html',
            contentType: fetched.contentType,
          },
          targetType: 'source',
          targetId: source.id,
        });

        return c.json({ sourceId: source.id, job: toJobView(job) }, 202);
      }

      // Drive / OneDrive / SharePoint need an OAuth grant that this deployment has not
      // been given. The failure is explicit and tells the operator exactly what is missing,
      // rather than presenting a button that quietly does nothing.
      throw new ApiError(
        400,
        'provider_unconfigured',
        `The ${input.kind.replace(/_/g, ' ')} connector needs an OAuth application to be configured for this deployment. Set the corresponding client ID and secret, then reconnect from Settings.`,
        { details: { connector: input.kind, requiredEnv: connectorEnvFor(input.kind) } },
      );
    },
  );

  /* ---------------------------------------------------------------------- */
  /* Mutations                                                              */
  /* ---------------------------------------------------------------------- */

  app.patch(
    '/:id',
    requirePermission('source:update'),
    validateJson(UpdateSourceRequest),
    async (c) => {
      const tenant = c.get('tenant');
      if (!tenant) throw ApiError.unauthenticated();
      const id = requireId(c, 'id');
      const input = body<typeof UpdateSourceRequest._output>(c);

      const before = await deps.repos.sources.getById(tenant, id);

      const patch: Record<string, unknown> = {};
      if (input.title !== undefined) patch.title = input.title;
      if (input.description !== undefined) patch.description = input.description;
      if (input.tags !== undefined) patch.tags = input.tags;
      if (input.effectiveDate !== undefined) {
        patch.effectiveDate = input.effectiveDate ? new Date(input.effectiveDate) : null;
      }
      if (input.status !== undefined) patch.status = input.status;

      await deps.repos.sources.update(tenant, id, input.version, patch);

      if (input.accessScope !== undefined) {
        await deps.repos.sources.setPermissions(
          tenant,
          id,
          input.accessScope,
          input.accessSubjectIds ?? [],
        );
      }

      const after = await deps.repos.sources.getById(tenant, id);
      await deps.repos.audit.record({
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
        actorUserId: tenant.userId,
        actorName: c.get('session')?.user.fullName ?? 'Unknown',
        action: 'source.updated',
        category: 'source',
        targetType: 'source',
        targetId: id,
        targetLabel: after.title,
        ipAddress: clientIp(c),
        userAgent: userAgent(c),
        traceId: tenant.traceId,
        summary: `Updated source "${after.title}".`,
        before: {
          title: before.title,
          tags: before.tags,
          accessScope: before.accessScope,
          status: before.status,
        },
        after: {
          title: after.title,
          tags: after.tags,
          accessScope: after.accessScope,
          status: after.status,
        },
      });

      // The updated document, not a redirect: a PATCH that 303s cannot carry field errors,
      // and every other mutation in this API answers with the resource it changed.
      return c.json(await buildSourceDetail(tenant, id));
    },
  );

  app.post('/:id/reprocess', requirePermission('source:reprocess'), async (c) => {
    const tenant = c.get('tenant');
    if (!tenant) throw ApiError.unauthenticated();
    const id = requireId(c, 'id');

    const source = await deps.repos.sources.getById(tenant, id);
    const versions = await deps.repos.sources.listVersions(tenant, id);
    const target = versions.find((v) => v.id === source.currentVersionId) ?? versions[0];
    if (!target) throw ApiError.badRequest('This source has no stored version to reprocess.');

    const { job } = await deps.repos.jobs.enqueue(tenant, {
      kind: 'source_reprocess',
      // A fresh key per attempt: reprocessing is an explicit user action that should run
      // again even if a previous reprocess of the same version already completed.
      idempotencyKey: `reprocess:${target.id}:${Date.now()}`,
      payload: {
        sourceId: id,
        sourceVersionId: target.id,
        storageKey: target.storageKey,
        fileName: `${source.title}`,
        contentType: target.contentType,
      },
      targetType: 'source',
      targetId: id,
    });

    await deps.repos.sources.setSourceStatus(id, { status: 'pending', failureReason: null });
    return c.json({ job: toJobView(job) }, 202);
  });

  app.post('/:id/sync', requirePermission('source:reprocess'), async (c) => {
    const tenant = c.get('tenant');
    if (!tenant) throw ApiError.unauthenticated();
    const id = requireId(c, 'id');
    const source = await deps.repos.sources.getById(tenant, id);

    if (source.connectorKind !== 'website' || !source.externalUrl) {
      throw ApiError.badRequest(
        'Only website-connected sources can be synced. Upload a new version to update a file-based source.',
      );
    }

    const { job } = await deps.repos.jobs.enqueue(tenant, {
      kind: 'source_sync',
      idempotencyKey: `sync:${id}:${Math.floor(Date.now() / 60_000)}`,
      payload: { sourceId: id, url: source.externalUrl },
      targetType: 'source',
      targetId: id,
    });

    return c.json({ job: toJobView(job) }, 202);
  });

  app.post('/:id/promote', requirePermission('source:promote'), async (c) => {
    const tenant = c.get('tenant');
    if (!tenant) throw ApiError.unauthenticated();
    const id = requireId(c, 'id');
    const source = await deps.repos.sources.promoteToKnowledge(tenant, id);

    await deps.repos.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: tenant.userId,
      actorName: c.get('session')?.user.fullName ?? 'Unknown',
      action: 'source.promoted',
      category: 'source',
      targetType: 'source',
      targetId: id,
      targetLabel: source.title,
      ipAddress: clientIp(c),
      userAgent: userAgent(c),
      traceId: tenant.traceId,
      summary: `Promoted "${source.title}" from a consultation upload into the knowledge base.`,
    });

    return c.json({ ok: true as const, sourceId: id });
  });

  app.post(
    '/bulk',
    requirePermission('source:update'),
    validateJson(BulkSourceActionRequest),
    async (c) => {
      const tenant = c.get('tenant');
      if (!tenant) throw ApiError.unauthenticated();
      const input = body<typeof BulkSourceActionRequest._output>(c);

      // One inaccessible id fails the whole batch rather than partially applying.
      await deps.repos.sources.assertAllVisible(tenant, input.sourceIds);

      let affected = 0;
      for (const sourceId of input.sourceIds) {
        const source = await deps.repos.sources.getById(tenant, sourceId);
        switch (input.action) {
          case 'tag':
            await deps.repos.sources.update(tenant, sourceId, source.version, {
              tags: [...new Set([...source.tags, ...(input.tags ?? [])])],
            });
            break;
          case 'set_access':
            if (input.accessScope) {
              await deps.repos.sources.setPermissions(
                tenant,
                sourceId,
                input.accessScope,
                input.accessSubjectIds ?? [],
              );
            }
            break;
          case 'reprocess': {
            const versions = await deps.repos.sources.listVersions(tenant, sourceId);
            const target = versions.find((v) => v.isCurrent) ?? versions[0];
            if (target) {
              await deps.repos.jobs.enqueue(tenant, {
                kind: 'source_reprocess',
                idempotencyKey: `reprocess:${target.id}:${Date.now()}`,
                payload: {
                  sourceId,
                  sourceVersionId: target.id,
                  storageKey: target.storageKey,
                  fileName: source.title,
                  contentType: target.contentType,
                },
                targetType: 'source',
                targetId: sourceId,
              });
            }
            break;
          }
          case 'archive':
            await deps.repos.sources.archive(tenant, sourceId);
            break;
          case 'restore':
            await deps.repos.sources.update(tenant, sourceId, source.version, { status: 'ready' });
            break;
          case 'delete':
            await deps.repos.sources.softDelete(tenant, sourceId);
            break;
          case 'export':
            // Export is handled by the artifacts route; nothing mutates here.
            break;
        }
        affected += 1;
      }

      await deps.repos.audit.record({
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
        actorUserId: tenant.userId,
        actorName: c.get('session')?.user.fullName ?? 'Unknown',
        action: `source.bulk.${input.action}`,
        category: 'source',
        ipAddress: clientIp(c),
        userAgent: userAgent(c),
        traceId: tenant.traceId,
        summary: `Bulk ${input.action} applied to ${affected} source(s).`,
        after: { sourceIds: input.sourceIds },
      });

      return c.json({ affected });
    },
  );

  app.delete('/:id', requirePermission('source:delete'), async (c) => {
    const tenant = c.get('tenant');
    if (!tenant) throw ApiError.unauthenticated();
    const id = requireId(c, 'id');
    const source = await deps.repos.sources.getById(tenant, id);
    await deps.repos.sources.softDelete(tenant, id);

    const policy = await deps.repos.settings.getRetentionPolicy(tenant);
    await deps.repos.settings.createDeletionRequest(tenant, {
      targetType: 'source',
      targetId: id,
      graceDays: policy?.purgeGraceDays ?? deps.env.PURGE_GRACE_PERIOD_DAYS,
    });

    await deps.repos.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: tenant.userId,
      actorName: c.get('session')?.user.fullName ?? 'Unknown',
      action: 'source.deleted',
      category: 'deletion',
      targetType: 'source',
      targetId: id,
      targetLabel: source.title,
      ipAddress: clientIp(c),
      userAgent: userAgent(c),
      traceId: tenant.traceId,
      summary: `Soft-deleted "${source.title}". Citations remain resolvable for audit until the retention purge runs.`,
    });

    return c.json({ ok: true as const });
  });

  return app;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function accessLabel(scope: string): string {
  return scope === 'workspace'
    ? 'All users'
    : scope === 'group'
      ? 'Selected groups'
      : 'Named users';
}

/** Processing sources report an indeterminate percentage until a job stage lands. */
function await0(status: string): number | null {
  return ['pending', 'scanning', 'extracting', 'indexing', 'validating'].includes(status)
    ? 0
    : null;
}

async function subjectLabel(
  deps: AppDeps,
  userId: string | null,
  groupId: string | null,
): Promise<string> {
  if (userId) {
    const user = await deps.repos.identity.findUserById(userId);
    return user?.fullName ?? 'Unknown user';
  }
  if (groupId) return 'Group';
  return 'All users in this workspace';
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[A-Za-z0-9]{1,6}$/, '').slice(0, 300) || fileName;
}

/** Where one part of a multi-part upload lives until the whole file is assembled. */
function partKey(storageKey: string, index: number): string {
  return `${storageKey}.part${index}`;
}

/**
 * The part headers, or null for an ordinary single-shot upload.
 *
 * Both are required together and are validated before a single byte is stored: a part
 * index without a total, or a total this server will not assemble, is a malformed request
 * rather than something to guess at.
 */
function readChunkHeaders(c: Context<AppBindings>): { index: number; total: number } | null {
  const rawIndex = c.req.header('x-upload-part');
  const rawTotal = c.req.header('x-upload-parts');
  if (!rawIndex && !rawTotal) return null;

  const index = Number(rawIndex);
  const total = Number(rawTotal);
  if (
    !Number.isInteger(index) ||
    !Number.isInteger(total) ||
    total < 1 ||
    total > MAX_UPLOAD_PARTS ||
    index < 1 ||
    index > total
  ) {
    throw ApiError.badRequest(
      `x-upload-part and x-upload-parts must be whole numbers, with the part between 1 and the total, and the total no more than ${MAX_UPLOAD_PARTS}.`,
    );
  }
  return { index, total };
}

/** Enough for a 500MB file in the client's chunk size, and a bound on the fan-out. */
const MAX_UPLOAD_PARTS = 64;

async function assembleParts(
  deps: AppDeps,
  storageKey: string,
  total: number,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for (let index = 1; index <= total; index += 1) {
    const part = await deps.services.storage.get('originals', partKey(storageKey, index));
    if (!part) {
      await discardParts(deps, storageKey, total);
      throw ApiError.badRequest(`Part ${index} of ${total} never arrived. Start the upload again.`);
    }
    parts.push(part);
  }

  const assembled = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    assembled.set(part, offset);
    offset += part.byteLength;
  }
  return assembled;
}

/** Best effort: a leftover part is scratch, and failing to remove one is not worth an error. */
async function discardParts(deps: AppDeps, storageKey: string, total: number): Promise<void> {
  for (let index = 1; index <= total; index += 1) {
    await deps.services.storage.delete('originals', partKey(storageKey, index)).catch(() => false);
  }
}

function connectorEnvFor(kind: string): string[] {
  if (kind === 'google_drive') return ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'];
  return ['MICROSOFT_OAUTH_CLIENT_ID', 'MICROSOFT_OAUTH_CLIENT_SECRET'];
}

/** Aggregates per-stage progress across all in-flight ingestion jobs. */
async function buildPipelineView(deps: AppDeps, workspaceId: string) {
  const stages = [
    'malware_scan',
    'extraction',
    'structure_analysis',
    'chunking',
    'embeddings',
    'lexical_index',
    'citation_map',
    'validation',
  ] as const;

  const list = await deps.repos.pipeline.recentIngestJobs(workspaceId);

  /*
   * What the pipeline is about: the work happening now, not a lifetime total.
   *
   * Two rules, and both matter.
   *
   * The newest attempt per document wins. A document that failed and was then reprocessed
   * successfully is a document that succeeded; counting the superseded failure as well is
   * how a file reads "Ready" in the table and "failed" in the pipeline at the same time.
   *
   * And the view is the current batch: everything still working, plus everything started
   * alongside the newest job. Uploading a file starts a new batch rather than adding one
   * more row to a running total nobody can find their document in.
   */
  const newestPerSource = new Map<string, (typeof list)[number]>();
  for (const job of list) {
    // `list` arrives newest first, so the first sighting of a document is its latest job.
    const key = job.targetId ?? job.id;
    if (!newestPerSource.has(key)) newestPerSource.set(key, job);
  }

  const candidates = [...newestPerSource.values()];
  const newestAt = candidates[0]?.createdAt?.getTime() ?? null;
  const batch = candidates.filter(
    (job) =>
      job.status === 'queued' ||
      job.status === 'running' ||
      (newestAt !== null && job.createdAt.getTime() >= newestAt - BATCH_WINDOW_MS),
  );

  // Titles for the documents a stage may need to name. Resolved once for the whole view
  // rather than per stage, since the same handful of documents appear across all eight.
  const targetIds = [...new Set(batch.map((job) => job.targetId).filter(Boolean))] as string[];
  const titles = await deps.repos.pipeline.titlesForSources(targetIds);

  return stages.map((stage) => {
    let completed = 0;
    let running = 0;
    let blocked = 0;
    const documents: Array<{
      sourceId: string;
      title: string;
      state: 'running' | 'failed' | 'pending';
      detail: string | null;
      startedAt: string | null;
    }> = [];

    for (const job of batch) {
      const entry = (job.stages ?? []).find((s) => s.key === stage);
      if (!entry) continue;
      if (entry.state === 'complete' || entry.state === 'skipped') completed += 1;
      else if (entry.state === 'running') running += 1;
      else if (entry.state === 'failed') blocked += 1;

      // A finished stage has nothing left to explain; the rest are what somebody opens
      // the stage to read.
      if (entry.state === 'running' || entry.state === 'failed' || entry.state === 'pending') {
        // A job outlives the document it ran on. One whose source has since been deleted
        // has no title here and is left out rather than named as something removed.
        const title = job.targetId ? titles.get(job.targetId) : undefined;
        if (job.targetId && title && documents.length < MAX_STAGE_DOCUMENTS) {
          documents.push({
            sourceId: job.targetId,
            title,
            state: entry.state === 'pending' ? 'pending' : entry.state,
            detail: entry.detail ?? null,
            startedAt: job.startedAt?.toISOString() ?? null,
          });
        }
      }
    }

    const total = batch.length;
    return {
      stage,
      completed,
      total,
      // Failures first: a stage is opened because something stopped, not because
      // something is still going.
      documents: documents.sort((a, b) => rankState(a.state) - rankState(b.state)),
      state:
        blocked > 0
          ? ('blocked' as const)
          : running > 0
            ? ('running' as const)
            : total > 0 && completed === total
              ? ('complete' as const)
              : ('idle' as const),
    };
  });
}

/** Enough to explain a stall without turning a summary card into a table. */
const MAX_STAGE_DOCUMENTS = 25;

/**
 * How close together two uploads have to be to count as the same batch.
 *
 * Long enough that a folder dropped in one go stays together while its documents queue,
 * short enough that yesterday's work is not still on screen while today's uploads.
 */
const BATCH_WINDOW_MS = 10 * 60 * 1000;

function rankState(state: 'running' | 'failed' | 'pending'): number {
  return state === 'failed' ? 0 : state === 'running' ? 1 : 2;
}
