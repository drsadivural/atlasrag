import { z } from 'zod';
import { DocumentType, Id, Sha256, Timestamp } from './primitives.js';

/**
 * Normalised page coordinates (0..1 of page width/height) so a highlight survives
 * whatever zoom level or render width the viewer happens to use.
 */
export const BoundingBox = z.object({
  page: z.number().int().min(1),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
});
export type BoundingBox = z.infer<typeof BoundingBox>;

/**
 * How a cited passage relates to the claim it is attached to. `context` means the
 * passage is relevant background but does not by itself decide the claim, which is
 * why a `context`-only finding can never be reported as verified-compliant.
 */
export const Entailment = z.enum(['supports', 'contradicts', 'context']);
export type Entailment = z.infer<typeof Entailment>;

/**
 * A citation is a first-class stored record, never a model-formatted string.
 * `supportingExcerpt` is re-checked verbatim against the stored extracted text
 * before the answer that references it is persisted.
 */
export const Citation = z.object({
  citationId: Id,
  tenantId: Id,
  sourceId: Id,
  sourceVersionId: Id,
  sourceSha256: Sha256,
  documentTitle: z.string().min(1),
  documentType: DocumentType,
  pageNumber: z.number().int().min(1).nullable(),
  sheetName: z.string().nullable(),
  cellRange: z.string().nullable(),
  slideNumber: z.number().int().min(1).nullable(),
  shapeName: z.string().nullable(),
  chapter: z.string().nullable(),
  section: z.string().nullable(),
  clause: z.string().nullable(),
  headingPath: z.array(z.string()).default([]),
  paragraphIndex: z.number().int().min(0).nullable(),
  charStart: z.number().int().min(0).nullable(),
  charEnd: z.number().int().min(0).nullable(),
  urlFragment: z.string().nullable(),
  boundingBoxes: z.array(BoundingBox).default([]),
  supportingExcerpt: z.string().min(1),
  retrievalScore: z.number().min(0).max(1),
  rerankScore: z.number().min(0).max(1),
  entailment: Entailment,
  /** False when verbatim re-check failed; such citations render as "unverified". */
  verified: z.boolean(),
  verificationMethod: z.enum(['exact', 'normalized', 'failed']),
  effectiveDate: Timestamp.nullable(),
  supersededBy: Id.nullable(),
  createdAt: Timestamp,
});
export type Citation = z.infer<typeof Citation>;

/**
 * The human-readable locator shown on a citation chip, e.g.
 * "Ch. 6 · §6.4.2 · p. 214" or "Sheet Budget · B12:D40".
 * Kept in the contract so web, reports and exports never drift apart.
 */
export function formatLocator(
  c: Pick<
    Citation,
    | 'chapter'
    | 'section'
    | 'clause'
    | 'pageNumber'
    | 'sheetName'
    | 'cellRange'
    | 'slideNumber'
    | 'headingPath'
    | 'paragraphIndex'
    | 'urlFragment'
  >,
): string {
  const parts: string[] = [];
  if (c.chapter) parts.push(`Ch. ${c.chapter}`);
  if (c.clause) parts.push(`§${c.clause}`);
  else if (c.section) parts.push(`§${c.section}`);
  if (c.sheetName) parts.push(`Sheet ${c.sheetName}`);
  if (c.cellRange) parts.push(c.cellRange);
  if (c.slideNumber) parts.push(`Slide ${c.slideNumber}`);
  if (typeof c.pageNumber === 'number') parts.push(`p. ${c.pageNumber}`);
  if (parts.length === 0 && c.headingPath.length > 0) parts.push(c.headingPath.join(' › '));
  if (parts.length === 0 && typeof c.paragraphIndex === 'number') {
    parts.push(`¶${c.paragraphIndex + 1}`);
  }
  if (parts.length === 0 && c.urlFragment) parts.push(c.urlFragment);
  return parts.join(' · ');
}

export const ComplianceResult = z.enum([
  'compliant',
  'non_compliant',
  'needs_evidence',
  'not_assessed',
]);
export type ComplianceResult = z.infer<typeof ComplianceResult>;

export const RiskLevel = z.enum(['critical', 'high', 'medium', 'low', 'none']);
export type RiskLevel = z.infer<typeof RiskLevel>;

/** One requirement extracted from a regulation, standard, policy or playbook. */
export const Requirement = z.object({
  requirementId: Id,
  reference: z.string().min(1),
  title: z.string().min(1),
  obligationText: z.string().min(1),
  /** "shall"/"must" are mandatory; "should" is recommended; "may" is permissive. */
  modality: z.enum(['mandatory', 'recommended', 'permissive', 'prohibited']),
  sourceId: Id,
  sourceVersionId: Id,
  citationId: Id.nullable(),
  exceptions: z.array(z.string()).default([]),
  crossReferences: z.array(z.string()).default([]),
});
export type Requirement = z.infer<typeof Requirement>;

/** The outcome of testing one requirement against the project documents. */
export const Finding = z.object({
  findingId: Id,
  requirementId: Id,
  requirementReference: z.string(),
  requirementTitle: z.string(),
  result: ComplianceResult,
  risk: RiskLevel,
  /** Plain-language statement of what was found. Never speculative. */
  finding: z.string().min(1),
  /** Evidence located in the customer's own documents, if any. */
  projectEvidenceCitationIds: z.array(Id).default([]),
  /** Evidence in the governing regulation that defines the obligation. */
  governingCitationIds: z.array(Id).default([]),
  /** Explicitly recorded when nothing in the project documents addresses the requirement. */
  missingEvidence: z.array(z.string()).default([]),
  conflicts: z
    .array(
      z.object({
        description: z.string(),
        citationIds: z.array(Id),
      }),
    )
    .default([]),
  recommendedAction: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});
export type Finding = z.infer<typeof Finding>;

/**
 * Confidence is derived, never a model self-report. These are the inputs, kept on the
 * record so a reviewer can see exactly why a number is what it is.
 */
export const ConfidenceBreakdown = z.object({
  evidenceCoverage: z.number().min(0).max(1),
  retrievalQuality: z.number().min(0).max(1),
  citationVerification: z.number().min(0).max(1),
  sourceAuthority: z.number().min(0).max(1),
  recency: z.number().min(0).max(1),
  contradictionPenalty: z.number().min(0).max(1),
  overall: z.number().min(0).max(1),
});
export type ConfidenceBreakdown = z.infer<typeof ConfidenceBreakdown>;

export const EvidenceCoverage = z.object({
  /** Fraction of material claims (or requirements) backed by a verified citation. */
  score: z.number().min(0).max(1),
  citedPassages: z.number().int().min(0),
  regulationsUsed: z.number().int().min(0),
  projectDocumentsUsed: z.number().int().min(0),
  verifiedCitations: z.number().int().min(0),
  unverifiedCitations: z.number().int().min(0),
  conflictingCitations: z.number().int().min(0),
  claimsTotal: z.number().int().min(0),
  claimsSupported: z.number().int().min(0),
});
export type EvidenceCoverage = z.infer<typeof EvidenceCoverage>;

export const AnswerDecision = z.enum(['yes', 'no', 'unable_to_determine']);
export type AnswerDecision = z.infer<typeof AnswerDecision>;

export const AnswerStyle = z.enum(['yes_no', 'optimal', 'details']);
export type AnswerStyle = z.infer<typeof AnswerStyle>;

export const TaskMode = z.enum(['ask', 'summarize', 'check_compliance', 'correct_document']);
export type TaskMode = z.infer<typeof TaskMode>;

/** A single assertion in an answer, paired with the citations that back it. */
export const Claim = z.object({
  claimId: Id,
  text: z.string().min(1),
  citationIds: z.array(Id).default([]),
  supported: z.boolean(),
  /** True when the sentence came from a general model rather than the knowledge base. */
  fromGeneralModel: z.boolean().default(false),
});
export type Claim = z.infer<typeof Claim>;

/**
 * The single structured answer object. All three answer styles are rendered from THIS —
 * switching style must never re-run retrieval and produce a contradictory answer.
 */
export const StructuredAnswer = z.object({
  answerId: Id,
  task: TaskMode,
  decision: AnswerDecision.nullable(),
  /** e.g. "Partially compliant" — shown alongside a NO, never instead of it. */
  decisionQualifier: z.string().nullable(),
  headline: z.string().min(1),
  decisiveReason: z.string().nullable(),
  summary: z.string(),
  scope: z.string().nullable(),
  documentsReviewed: z
    .array(
      z.object({
        sourceId: Id,
        sourceVersionId: Id,
        title: z.string(),
        version: z.string(),
        role: z.enum(['governing', 'project']),
        pages: z.number().int().min(0).nullable(),
      }),
    )
    .default([]),
  assumptions: z.array(z.string()).default([]),
  keyFindings: z.array(z.string()).default([]),
  claims: z.array(Claim).default([]),
  requirements: z.array(Requirement).default([]),
  findings: z.array(Finding).default([]),
  calculations: z
    .array(
      z.object({
        label: z.string(),
        expression: z.string(),
        value: z.string(),
        citationIds: z.array(Id).default([]),
      }),
    )
    .default([]),
  conflicts: z
    .array(
      z.object({
        description: z.string(),
        citationIds: z.array(Id),
      }),
    )
    .default([]),
  missingEvidence: z.array(z.string()).default([]),
  uncertainties: z.array(z.string()).default([]),
  followUpQuestion: z.string().nullable(),
  recommendedActions: z
    .array(
      z.object({
        action: z.string(),
        priority: z.enum(['critical', 'high', 'medium', 'low']),
        requirementIds: z.array(Id).default([]),
      }),
    )
    .default([]),
  riskLevel: RiskLevel,
  coverage: EvidenceCoverage,
  confidence: ConfidenceBreakdown,
  citations: z.array(Citation).default([]),
  /** True when general-model fallback contributed any sentence; drives a visible label. */
  usedGeneralModel: z.boolean().default(false),
  /** Populated when a source tried to inject instructions; the UI shows a warning banner. */
  injectionWarnings: z
    .array(
      z.object({ sourceId: Id, sourceTitle: z.string(), pattern: z.string(), excerpt: z.string() }),
    )
    .default([]),
  generatedAt: Timestamp,
  modelConfigurationId: Id.nullable(),
  modelDescriptor: z.string(),
});
export type StructuredAnswer = z.infer<typeof StructuredAnswer>;
