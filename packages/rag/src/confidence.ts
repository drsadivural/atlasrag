import type {
  Citation,
  ConfidenceBreakdown,
  EvidenceCoverage,
  Finding,
  Claim,
} from '@uxe/contracts';

/**
 * Evidence coverage and confidence are computed from observable facts about the retrieval
 * and verification that just happened. Nothing here asks a model how sure it is: a model's
 * self-reported confidence is uncorrelated with whether the quoted clause actually exists,
 * which is precisely the failure this product must not have.
 */

export interface CoverageInput {
  claims: Claim[];
  citations: Citation[];
  /** For compliance work, coverage is measured over requirements rather than sentences. */
  findings?: Finding[];
  regulationSourceIds: string[];
  projectSourceIds: string[];
}

export function computeEvidenceCoverage(input: CoverageInput): EvidenceCoverage {
  const verified = input.citations.filter((c) => c.verified);
  const unverified = input.citations.filter((c) => !c.verified);
  const conflicting = input.citations.filter((c) => c.entailment === 'contradicts');

  const verifiedIds = new Set(verified.map((c) => c.citationId));

  // A claim counts as supported only when at least one of its citations survived
  // verification. A claim citing three unverified passages is unsupported.
  const materialClaims = input.claims.filter((c) => !c.fromGeneralModel);
  const supportedClaims = materialClaims.filter((c) =>
    c.citationIds.some((id) => verifiedIds.has(id)),
  );

  let claimsTotal = materialClaims.length;
  let claimsSupported = supportedClaims.length;

  // For a compliance review the unit of coverage is the requirement: a requirement with
  // no project evidence is not "covered" even if the obligation itself is well cited.
  if (input.findings && input.findings.length > 0) {
    claimsTotal = input.findings.length;
    claimsSupported = input.findings.filter(
      (f) =>
        f.result !== 'not_assessed' &&
        (f.projectEvidenceCitationIds.some((id) => verifiedIds.has(id)) ||
          (f.result === 'needs_evidence' &&
            f.governingCitationIds.some((id) => verifiedIds.has(id)))),
    ).length;
  }

  const usedSourceIds = new Set(verified.map((c) => c.sourceId));
  const regulationsUsed = input.regulationSourceIds.filter((id) => usedSourceIds.has(id)).length;
  const projectDocumentsUsed = input.projectSourceIds.filter((id) => usedSourceIds.has(id)).length;

  const score = claimsTotal === 0 ? 0 : claimsSupported / claimsTotal;

  return {
    score: clamp01(score),
    citedPassages: verified.length,
    regulationsUsed,
    projectDocumentsUsed,
    verifiedCitations: verified.length,
    unverifiedCitations: unverified.length,
    conflictingCitations: conflicting.length,
    claimsTotal,
    claimsSupported,
  };
}

export interface ConfidenceInput {
  coverage: EvidenceCoverage;
  citations: Citation[];
  /** Rerank scores of the passages actually used, 0..1. */
  retrievalScores: number[];
  /** True when a governing source carries an explicit effective date and authority. */
  sourceAuthorityScores: number[];
  /** Effective dates of the governing sources used, for recency decay. */
  effectiveDates: Array<Date | null>;
  conflictCount: number;
  now?: Date;
}

/**
 * Deterministic confidence.
 *
 * Six observable components, each in 0..1, combined with fixed weights and then reduced by
 * a contradiction penalty. The breakdown is stored alongside the answer so a reviewer can
 * see exactly why a number is what it is, and so two identical inputs always produce the
 * identical number.
 */
export function computeConfidence(input: ConfidenceInput): ConfidenceBreakdown {
  /*
   * Truncated to the day.
   *
   * Recency is how old a regulation is, measured in years — a signal with no business
   * knowing what minute it is. Reading the clock straight made the same answer score
   * fractionally differently on every recomputation, which is not what a number printed
   * next to a citation should do, and quietly broke the promise two paragraphs above this
   * one that identical inputs produce an identical result.
   *
   * Applied to a supplied instant too, not only to the default: a caller that passes a
   * timestamp is entitled to the same guarantee.
   */
  const now = startOfUtcDay(input.now ?? new Date());

  // 1. How much of the answer is actually backed by verified evidence.
  const evidenceCoverage = clamp01(input.coverage.score);

  // 2. How strong the retrieval was for the passages that were used.
  const retrievalQuality =
    input.retrievalScores.length === 0 ? 0 : clamp01(mean(input.retrievalScores));

  // 3. What fraction of citations survived verbatim verification. This is weighted
  //    heavily: it is the difference between real and invented evidence.
  const total = input.citations.length;
  const citationVerification =
    total === 0 ? 0 : clamp01(input.citations.filter((c) => c.verified).length / total);

  // 4. Authority of the governing sources.
  const sourceAuthority =
    input.sourceAuthorityScores.length === 0 ? 0.5 : clamp01(mean(input.sourceAuthorityScores));

  // 5. Recency: a regulation from twelve years ago is weaker evidence than this year's.
  const recency = computeRecency(input.effectiveDates, now);

  // 6. Contradictions reduce confidence rather than being averaged away.
  const contradictionPenalty = clamp01(1 - Math.min(1, input.conflictCount * 0.2));

  const weighted =
    0.3 * evidenceCoverage +
    0.2 * retrievalQuality +
    0.28 * citationVerification +
    0.1 * sourceAuthority +
    0.07 * recency +
    0.05 * contradictionPenalty;

  // The penalty also scales the whole result, so a directly contradicted answer can never
  // present as high confidence just because every other component looked healthy.
  const overall = clamp01(weighted * (0.6 + 0.4 * contradictionPenalty));

  return {
    evidenceCoverage,
    retrievalQuality,
    citationVerification,
    sourceAuthority,
    recency,
    contradictionPenalty,
    overall,
  };
}

/** Midnight UTC of the given instant. */
function startOfUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

function computeRecency(dates: Array<Date | null>, now: Date): number {
  const known = dates.filter((d): d is Date => d instanceof Date && !Number.isNaN(d.getTime()));
  if (known.length === 0) return 0.5; // Unknown is neither fresh nor stale.
  const newest = known.reduce((a, b) => (a.getTime() > b.getTime() ? a : b));
  const years = (now.getTime() - newest.getTime()) / (365 * 86_400_000);
  if (years <= 0) return 1;
  // Linear decay to zero over fifteen years.
  return clamp01(1 - years / 15);
}

/**
 * Source authority.
 *
 * Regulations and standards outrank internal policies, which outrank a customer's own
 * project document. A promoted, versioned, dated source outranks a one-off upload.
 */
export function sourceAuthorityScore(input: {
  role: 'governing' | 'project';
  hasEffectiveDate: boolean;
  promoted: boolean;
  tags: string[];
  superseded: boolean;
}): number {
  if (input.superseded) return 0.15;
  let score = input.role === 'governing' ? 0.7 : 0.45;
  const tags = input.tags.map((t) => t.toLowerCase());
  if (tags.some((t) => ['regulation', 'law', 'code', 'statute'].includes(t))) score += 0.2;
  else if (tags.some((t) => ['standard', 'iso', 'astm', 'nfpa', 'en'].includes(t))) score += 0.15;
  else if (tags.some((t) => ['policy', 'playbook', 'procedure'].includes(t))) score += 0.05;
  if (input.hasEffectiveDate) score += 0.06;
  if (input.promoted) score += 0.04;
  return clamp01(score);
}

/**
 * Knowledge health, shown on the Dashboard and Knowledge Base with this exact formula in a
 * tooltip so the number is never a black box.
 */
export const KNOWLEDGE_HEALTH_FORMULA =
  'health = 100 x (0.40 x pipelineSuccess + 0.15 x freshness + 0.15 x metadataCompleteness + 0.15 x citationReadiness + 0.10 x (1 - duplicateRate) + 0.05 x permissionIntegrity)';

export interface KnowledgeHealthInput {
  total: number;
  ready: number;
  failed: number;
  processing: number;
  needsReview: number;
  outdated: number;
  missingMetadata: number;
  unlinkedContent: number;
  duplicates: number;
  permissionIssues: number;
}

export function computeKnowledgeHealth(input: KnowledgeHealthInput): number {
  if (input.total === 0) return 100;
  const n = input.total;

  // Pipeline success: sources that finished indexing without failing or needing review.
  const pipelineSuccess = clamp01((n - input.failed - input.needsReview) / n);
  const freshness = clamp01((n - input.outdated) / n);
  const metadataCompleteness = clamp01((n - input.missingMetadata) / n);
  // Citation readiness: a source with no indexed content cannot support a citation.
  const citationReadiness = clamp01((n - input.unlinkedContent) / n);
  const duplicateRate = clamp01(input.duplicates / n);
  const permissionIntegrity = clamp01((n - input.permissionIssues) / n);

  const score =
    0.4 * pipelineSuccess +
    0.15 * freshness +
    0.15 * metadataCompleteness +
    0.15 * citationReadiness +
    0.1 * (1 - duplicateRate) +
    0.05 * permissionIntegrity;

  return Math.round(clamp01(score) * 100);
}

/**
 * Decides whether the evidence is strong enough to answer at all.
 *
 * When this returns `abstain`, the product says so visibly and asks a precise follow-up
 * instead of producing a confident-looking answer from thin evidence. This is what keeps
 * "UNABLE TO DETERMINE" an honest outcome rather than a failure state.
 */
export function shouldAbstain(input: {
  coverage: EvidenceCoverage;
  confidence: ConfidenceBreakdown;
  minimumEvidenceThreshold: number;
  askWhenUncertain: boolean;
  verifiedCitations: number;
}): { abstain: boolean; reason: string | null } {
  if (input.verifiedCitations === 0) {
    return {
      abstain: true,
      reason: 'No passage in the selected sources could be verified as supporting an answer.',
    };
  }
  if (input.coverage.score < input.minimumEvidenceThreshold) {
    return {
      abstain: true,
      reason: `Evidence coverage is ${Math.round(input.coverage.score * 100)}%, below the workspace minimum of ${Math.round(
        input.minimumEvidenceThreshold * 100,
      )}%.`,
    };
  }
  if (input.askWhenUncertain && input.confidence.overall < 0.35) {
    return {
      abstain: true,
      reason: 'The available evidence is too weak or too contradictory to support a decision.',
    };
  }
  return { abstain: false, reason: null };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
