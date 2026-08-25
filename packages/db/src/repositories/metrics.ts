import { and, count, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  complianceReviews,
  consultations,
  findings,
  generatedArtifacts,
  processingJobs,
  sourceVersions,
  sources,
} from '../schema/index.js';
import { requirePermission, type TenantContext } from '../tenant.js';
import { visibleSourcePredicate } from './sources.js';

export interface PeriodSummary {
  consultations: number;
  documentsReviewed: number;
  /** Fraction of assessed requirements that came out compliant, 0..1. */
  complianceRate: number;
  /** Mean evidence coverage across completed reviews, 0..1. */
  evidenceCoverage: number;
}

/**
 * Read-only aggregate queries for the dashboard.
 *
 * Kept in its own repository because these are the only queries in the system that span
 * several domains at once; mixing them into the entity repositories would blur the tenant
 * scoping rules that each of those enforces.
 */
export class MetricsRepository {
  constructor(private readonly db: Database) {}

  /** Cheap liveness probe used by the readiness endpoint. */
  async ping(): Promise<void> {
    await this.db.execute(sql`SELECT 1`);
  }

  async summary(ctx: TenantContext, from: Date, to: Date): Promise<PeriodSummary> {
    requirePermission(ctx, 'workspace:read');
    // postgres-js cannot encode a Date bound inside a raw fragment, so timestamps are
    // passed as ISO strings and cast in SQL. Drizzle's typed column helpers (gte/lt) do
    // their own encoding and take Dates directly.
    const fromIso = from.toISOString();
    const toIso = to.toISOString();

    const [consultationRow] = await this.db
      .select({ value: count() })
      .from(consultations)
      .where(
        and(
          eq(consultations.workspaceId, ctx.workspaceId),
          isNull(consultations.deletedAt),
          gte(consultations.createdAt, from),
          lt(consultations.createdAt, to),
        ),
      );

    const [reviewRow] = await this.db
      .select({
        reviews: count(),
        compliant: sql<number>`coalesce(sum(${complianceReviews.compliantCount}), 0)`,
        assessed: sql<number>`coalesce(sum(${complianceReviews.compliantCount} + ${complianceReviews.nonCompliantCount} + ${complianceReviews.needsEvidenceCount}), 0)`,
        coverage: sql<number>`coalesce(avg(${complianceReviews.evidenceCoverage}), 0)`,
      })
      .from(complianceReviews)
      .where(
        and(
          eq(complianceReviews.workspaceId, ctx.workspaceId),
          eq(complianceReviews.status, 'complete'),
          gte(complianceReviews.createdAt, from),
          lt(complianceReviews.createdAt, to),
        ),
      );

    // "Documents reviewed" counts distinct source versions that were actually cited in a
    // consultation in the period, not every version that happens to exist.
    const documentRows = await this.db.execute(sql`
      SELECT count(DISTINCT cs.source_version_id) AS value
      FROM consultation_sources cs
      JOIN consultations c ON c.id = cs.consultation_id
      WHERE c.workspace_id = ${ctx.workspaceId}
        AND c.deleted_at IS NULL
        AND c.created_at >= ${fromIso}::timestamptz
        AND c.created_at < ${toIso}::timestamptz
    `);
    const documentsReviewed = Number(
      (documentRows as unknown as Array<{ value: number }>)[0]?.value ?? 0,
    );

    const assessed = Number(reviewRow?.assessed ?? 0);
    const compliant = Number(reviewRow?.compliant ?? 0);

    return {
      consultations: Number(consultationRow?.value ?? 0),
      documentsReviewed,
      complianceRate: assessed === 0 ? 0 : compliant / assessed,
      evidenceCoverage: Number(reviewRow?.coverage ?? 0),
    };
  }

  /** Daily consultation counts, with zero-filled gaps so the chart has no holes. */
  async activitySeries(
    ctx: TenantContext,
    from: Date,
    to: Date,
  ): Promise<Array<{ date: string; consultations: number }>> {
    requirePermission(ctx, 'workspace:read');
    const fromIso = from.toISOString();
    const toIso = to.toISOString();

    const rows = await this.db.execute(sql`
      SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*) AS value
      FROM consultations
      WHERE workspace_id = ${ctx.workspaceId}
        AND deleted_at IS NULL
        AND created_at >= ${fromIso}::timestamptz
        AND created_at < ${toIso}::timestamptz
      GROUP BY 1
      ORDER BY 1
    `);

    const byDay = new Map(
      (rows as unknown as Array<{ day: string; value: number }>).map((r) => [
        r.day,
        Number(r.value),
      ]),
    );

    const out: Array<{ date: string; consultations: number }> = [];
    for (let d = new Date(from); d < to; d = new Date(d.getTime() + 86_400_000)) {
      const key = d.toISOString().slice(0, 10);
      out.push({ date: key, consultations: byDay.get(key) ?? 0 });
    }
    return out;
  }

  async complianceOutcomes(ctx: TenantContext, from: Date, to: Date) {
    requirePermission(ctx, 'workspace:read');

    const [row] = await this.db
      .select({
        compliant: sql<number>`count(*) filter (where ${findings.result} = 'compliant')`,
        nonCompliant: sql<number>`count(*) filter (where ${findings.result} = 'non_compliant')`,
        needsEvidence: sql<number>`count(*) filter (where ${findings.result} = 'needs_evidence')`,
        notAssessed: sql<number>`count(*) filter (where ${findings.result} = 'not_assessed')`,
        total: count(),
      })
      .from(findings)
      .innerJoin(complianceReviews, eq(complianceReviews.id, findings.reviewId))
      .where(
        and(
          eq(findings.workspaceId, ctx.workspaceId),
          gte(complianceReviews.createdAt, from),
          lt(complianceReviews.createdAt, to),
        ),
      );

    return {
      compliant: Number(row?.compliant ?? 0),
      needsEvidence: Number(row?.needsEvidence ?? 0),
      nonCompliant: Number(row?.nonCompliant ?? 0),
      notAssessed: Number(row?.notAssessed ?? 0),
      total: Number(row?.total ?? 0),
    };
  }

  /**
   * Items for the "Needs attention" rail: critical gaps, unresolved evidence, stale
   * knowledge and consultations awaiting review.
   */
  async attentionItems(ctx: TenantContext, limit: number) {
    requirePermission(ctx, 'workspace:read');
    const items: Array<{
      id: string;
      kind: 'critical_gap' | 'unresolved_evidence' | 'stale_knowledge' | 'pending_review';
      title: string;
      detail: string;
      severity: 'critical' | 'warning' | 'info';
      href: string;
    }> = [];

    const criticalReviews = await this.db
      .select({
        id: complianceReviews.id,
        consultationId: complianceReviews.consultationId,
        title: consultations.title,
        nonCompliant: complianceReviews.nonCompliantCount,
        needsEvidence: complianceReviews.needsEvidenceCount,
      })
      .from(complianceReviews)
      .innerJoin(consultations, eq(consultations.id, complianceReviews.consultationId))
      .where(
        and(
          eq(complianceReviews.workspaceId, ctx.workspaceId),
          eq(complianceReviews.status, 'complete'),
          sql`${complianceReviews.nonCompliantCount} > 0 OR ${complianceReviews.needsEvidenceCount} > 0`,
        ),
      )
      .orderBy(sql`${complianceReviews.nonCompliantCount} DESC`)
      .limit(limit);

    for (const review of criticalReviews) {
      if (review.nonCompliant > 0) {
        items.push({
          id: review.id,
          kind: 'critical_gap',
          title: review.title,
          detail: `${review.nonCompliant} critical ${review.nonCompliant === 1 ? 'gap' : 'gaps'}`,
          severity: 'critical',
          href: `/consult/${review.consultationId}`,
        });
      } else {
        items.push({
          id: review.id,
          kind: 'unresolved_evidence',
          title: review.title,
          detail: `${review.needsEvidence} ${review.needsEvidence === 1 ? 'item needs' : 'items need'} evidence`,
          severity: 'warning',
          href: `/consult/${review.consultationId}`,
        });
      }
    }

    const stale = await this.db
      .select({ id: sources.id, title: sources.title, lastSyncedAt: sources.lastSyncedAt })
      .from(sources)
      .where(
        and(
          visibleSourcePredicate(ctx),
          eq(sources.promotedToKnowledge, true),
          sql`${sources.lastSyncedAt} < now() - interval '180 days'`,
        ),
      )
      .limit(3);

    for (const source of stale) {
      items.push({
        id: source.id,
        kind: 'stale_knowledge',
        title: source.title,
        detail: 'Not synced in over 180 days',
        severity: 'info',
        href: `/knowledge/${source.id}`,
      });
    }

    const pending = await this.db
      .select({ id: consultations.id, title: consultations.title })
      .from(consultations)
      .where(
        and(
          eq(consultations.workspaceId, ctx.workspaceId),
          eq(consultations.status, 'report_ready'),
          isNull(consultations.deletedAt),
        ),
      )
      .limit(3);

    for (const consultation of pending) {
      items.push({
        id: consultation.id,
        kind: 'pending_review',
        title: consultation.title,
        detail: 'Report ready for review',
        severity: 'info',
        href: `/consult/${consultation.id}`,
      });
    }

    return items.slice(0, limit);
  }

  /** How many sources a given member can actually see, for the Users page. */
  async accessibleSourceCount(ctx: TenantContext, userId: string): Promise<number> {
    const groupRows = await this.db.execute(sql`
      SELECT gm.group_id FROM group_members gm
      JOIN groups g ON g.id = gm.group_id
      WHERE gm.user_id = ${userId} AND g.workspace_id = ${ctx.workspaceId}
    `);
    const groupIds = (groupRows as unknown as Array<{ group_id: string }>).map((r) => r.group_id);

    const [row] = await this.db
      .select({ value: count() })
      .from(sources)
      .where(
        and(
          // Evaluate visibility as the TARGET user, not the caller: this answers
          // "what can they see", which is the question the Users page asks.
          visibleSourcePredicate({ ...ctx, userId, groupIds, role: 'member' }),
          eq(sources.promotedToKnowledge, true),
        ),
      );

    return Number(row?.value ?? 0);
  }

  async artifactCounts(ctx: TenantContext) {
    const [row] = await this.db
      .select({
        total: count(),
        ready: sql<number>`count(*) filter (where ${generatedArtifacts.status} = 'ready')`,
      })
      .from(generatedArtifacts)
      .where(
        and(
          eq(generatedArtifacts.workspaceId, ctx.workspaceId),
          isNull(generatedArtifacts.deletedAt),
        ),
      );
    return { total: Number(row?.total ?? 0), ready: Number(row?.ready ?? 0) };
  }

  async versionCount(ctx: TenantContext) {
    const [row] = await this.db
      .select({ value: count() })
      .from(sourceVersions)
      .where(eq(sourceVersions.workspaceId, ctx.workspaceId));
    return Number(row?.value ?? 0);
  }

  async queueDepth(ctx: TenantContext) {
    const [row] = await this.db
      .select({ value: count() })
      .from(processingJobs)
      .where(
        and(eq(processingJobs.workspaceId, ctx.workspaceId), eq(processingJobs.status, 'queued')),
      );
    return Number(row?.value ?? 0);
  }
}
