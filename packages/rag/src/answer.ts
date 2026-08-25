import type {
  AnswerDecision,
  Citation,
  Claim,
  ConfidenceBreakdown,
  EvidenceCoverage,
  Finding,
  Requirement,
  RiskLevel,
  StructuredAnswer,
  TaskMode,
} from '@uxe/contracts';
import { formatLocator } from '@uxe/contracts';
import type { FusedCandidate } from './fusion.js';
import { normalizeWhitespace, splitSentences, contentTokens, lightStem } from './text.js';
import { selectExcerpt } from './citations.js';

export interface DocumentReviewed {
  sourceId: string;
  sourceVersionId: string;
  title: string;
  version: string;
  role: 'governing' | 'project';
  pages: number | null;
}

export interface AssembleInput {
  answerId: string;
  task: TaskMode;
  question: string;
  citations: Citation[];
  claims: Claim[];
  coverage: EvidenceCoverage;
  confidence: ConfidenceBreakdown;
  documentsReviewed: DocumentReviewed[];
  requirements?: Requirement[];
  findings?: Finding[];
  decision?: AnswerDecision | null;
  decisionQualifier?: string | null;
  riskLevel?: RiskLevel;
  assumptions?: string[];
  missingEvidence?: string[];
  uncertainties?: string[];
  conflicts?: Array<{ description: string; citationIds: string[] }>;
  calculations?: Array<{ label: string; expression: string; value: string; citationIds: string[] }>;
  recommendedActions?: Array<{
    action: string;
    priority: 'critical' | 'high' | 'medium' | 'low';
    requirementIds: string[];
  }>;
  followUpQuestion?: string | null;
  abstainReason?: string | null;
  usedGeneralModel?: boolean;
  injectionWarnings?: Array<{
    sourceId: string;
    sourceTitle: string;
    pattern: string;
    excerpt: string;
  }>;
  modelDescriptor: string;
  modelConfigurationId?: string | null;
  scope?: string | null;
  headlineOverride?: string | null;
  summaryOverride?: string | null;
}

/**
 * Assembles the single structured answer object.
 *
 * Every answer style is a *projection* of this object — see `renderYesNo`, `renderOptimal`
 * and `renderDetails` below. Switching style in the UI re-renders from the same verified
 * evidence and therefore cannot produce a contradictory answer, which is the behaviour
 * section 11 of the brief requires.
 */
export function assembleAnswer(input: AssembleInput): StructuredAnswer {
  const verified = input.citations.filter((c) => c.verified);
  const decision = input.decision ?? null;
  const findings = input.findings ?? [];

  const keyFindings = buildKeyFindings(input, findings);
  const headline = input.headlineOverride ?? buildHeadline(input, decision, findings);
  const decisiveReason = buildDecisiveReason(input, decision, findings, verified);
  const summary = input.summaryOverride ?? buildSummary(input, findings, keyFindings);

  return {
    answerId: input.answerId,
    task: input.task,
    decision,
    decisionQualifier: input.decisionQualifier ?? null,
    headline,
    decisiveReason,
    summary,
    scope: input.scope ?? null,
    documentsReviewed: input.documentsReviewed,
    assumptions: input.assumptions ?? [],
    keyFindings,
    claims: input.claims,
    requirements: input.requirements ?? [],
    findings,
    calculations: input.calculations ?? [],
    conflicts: input.conflicts ?? [],
    missingEvidence: input.missingEvidence ?? [],
    uncertainties: input.abstainReason
      ? [input.abstainReason, ...(input.uncertainties ?? [])]
      : (input.uncertainties ?? []),
    followUpQuestion: input.followUpQuestion ?? null,
    recommendedActions: input.recommendedActions ?? [],
    riskLevel: input.riskLevel ?? 'none',
    coverage: input.coverage,
    confidence: input.confidence,
    citations: input.citations,
    usedGeneralModel: input.usedGeneralModel ?? false,
    injectionWarnings: input.injectionWarnings ?? [],
    generatedAt: new Date().toISOString(),
    modelConfigurationId: input.modelConfigurationId ?? null,
    modelDescriptor: input.modelDescriptor,
  };
}

function buildHeadline(
  input: AssembleInput,
  decision: AnswerDecision | null,
  findings: Finding[],
): string {
  if (input.task === 'check_compliance') {
    const critical = findings.filter((f) => f.result === 'non_compliant').length;
    const gaps = findings.filter((f) => f.result === 'needs_evidence').length;
    if (decision === 'unable_to_determine') {
      return 'Unable to determine compliance from the available evidence';
    }
    if (critical > 0) {
      return `${critical} ${critical === 1 ? 'gap requires' : 'critical gaps require'} correction`;
    }
    if (gaps > 0)
      return `${gaps} ${gaps === 1 ? 'requirement needs' : 'requirements need'} evidence`;
    return 'All reviewed requirements are met';
  }

  if (input.task === 'summarize') {
    const count = input.documentsReviewed.length;
    return `Summary of ${count} ${count === 1 ? 'document' : 'documents'}`;
  }

  if (decision === 'unable_to_determine' || input.abstainReason) {
    return 'The selected sources do not answer this question';
  }

  const first = input.claims.find((c) => c.supported);
  return first ? truncate(first.text, 110) : 'Answer grounded in the selected sources';
}

function buildDecisiveReason(
  input: AssembleInput,
  decision: AnswerDecision | null,
  findings: Finding[],
  verified: Citation[],
): string | null {
  if (input.abstainReason) return input.abstainReason;

  if (input.task === 'check_compliance') {
    const blocking = findings.find((f) => f.result === 'non_compliant');
    if (blocking) return blocking.finding;
    const gap = findings.find((f) => f.result === 'needs_evidence');
    if (gap) return gap.finding;
    if (findings.length > 0) {
      return `Every one of the ${findings.length} reviewed requirements is supported by evidence in the project documents.`;
    }
    return null;
  }

  if (decision === 'unable_to_determine') return null;

  const primary = verified[0];
  if (!primary) return null;
  return `${primary.documentTitle} states: "${truncate(primary.supportingExcerpt, 200)}" (${formatLocator(primary)}).`;
}

function buildKeyFindings(input: AssembleInput, findings: Finding[]): string[] {
  if (findings.length > 0) {
    return findings
      .filter((f) => f.result !== 'compliant')
      .slice(0, 6)
      .map(
        (f) => `${f.requirementReference} - ${labelResult(f.result)}: ${truncate(f.finding, 180)}`,
      );
  }
  return input.claims
    .filter((c) => c.supported)
    .slice(0, 6)
    .map((c) => truncate(c.text, 200));
}

function buildSummary(input: AssembleInput, findings: Finding[], keyFindings: string[]): string {
  if (input.abstainReason) {
    return [
      input.abstainReason,
      input.followUpQuestion ? `To proceed: ${input.followUpQuestion}` : null,
    ]
      .filter(Boolean)
      .join(' ');
  }

  if (input.task === 'check_compliance' && findings.length > 0) {
    const compliant = findings.filter((f) => f.result === 'compliant').length;
    const nonCompliant = findings.filter((f) => f.result === 'non_compliant').length;
    const needsEvidence = findings.filter((f) => f.result === 'needs_evidence').length;
    const docs = input.documentsReviewed;
    const governing = docs.filter((d) => d.role === 'governing');
    const project = docs.filter((d) => d.role === 'project');

    const lead = `Reviewed ${findings.length} ${findings.length === 1 ? 'requirement' : 'requirements'} drawn from ${governing.length} ${governing.length === 1 ? 'regulation' : 'regulations'} against ${project.length} project ${project.length === 1 ? 'document' : 'documents'}.`;
    const tally = `${compliant} met, ${nonCompliant} not met, ${needsEvidence} awaiting evidence.`;
    const detail = keyFindings.slice(0, 3).join(' ');
    return normalizeWhitespace(`${lead} ${tally} ${detail}`);
  }

  const supported = input.claims.filter((c) => c.supported);
  if (supported.length === 0) {
    return 'No statement in this answer could be supported by a verified passage from the selected sources.';
  }
  return normalizeWhitespace(supported.map((c) => c.text).join(' '));
}

function labelResult(result: Finding['result']): string {
  switch (result) {
    case 'compliant':
      return 'Compliant';
    case 'non_compliant':
      return 'Non-compliant';
    case 'needs_evidence':
      return 'Needs evidence';
    default:
      return 'Not assessed';
  }
}

/* -------------------------------------------------------------------------- */
/* Extractive claim construction                                              */
/* -------------------------------------------------------------------------- */

export interface ClaimBuildInput {
  question: string;
  candidates: FusedCandidate[];
  citationIdByChunk: Map<string, string>;
  idFactory: () => string;
  maxClaims?: number;
}

/**
 * Builds claims by *selecting* sentences from retrieved passages rather than writing new
 * prose about them.
 *
 * This is the mechanism behind "never invent a quote": a claim's text is a verbatim
 * sentence from a source, so the citation attached to it is true by construction and then
 * independently re-verified against the stored page text. The engine can be wrong about
 * *relevance*, but it cannot be wrong about *what the document says*.
 */
export function buildExtractiveClaims(input: ClaimBuildInput): Claim[] {
  const max = input.maxClaims ?? 6;
  const queryTerms = new Set(contentTokens(input.question).map(lightStem));
  const claims: Claim[] = [];
  const usedSentences = new Set<string>();

  for (const candidate of input.candidates) {
    if (claims.length >= max) break;
    const citationId = input.citationIdByChunk.get(candidate.chunkId);
    if (!citationId) continue;

    const sentences = splitSentences(candidate.content)
      .map((sentence) => {
        const terms = contentTokens(sentence).map(lightStem);
        const hits = terms.filter((t) => queryTerms.has(t)).length;
        const density = terms.length === 0 ? 0 : hits / Math.sqrt(terms.length);
        const obligation = /\b(shall|must|shall not|must not|required|prohibited)\b/i.test(sentence)
          ? 0.3
          : 0;
        return { sentence: normalizeWhitespace(sentence), score: density + obligation };
      })
      // A heading fragment is not a claim; require enough substance to stand alone.
      .filter((s) => s.sentence.length >= 40 && s.score > 0)
      .sort((a, b) => b.score - a.score);

    const best = sentences[0];
    if (!best) continue;

    const key = best.sentence.toLowerCase();
    if (usedSentences.has(key)) continue;
    usedSentences.add(key);

    claims.push({
      claimId: input.idFactory(),
      text: best.sentence,
      citationIds: [citationId],
      supported: true,
      fromGeneralModel: false,
    });
  }

  return claims;
}

/**
 * Extractive summarisation, used by the Summarize task.
 *
 * Sentences are scored by term centrality (how much vocabulary they share with the rest of
 * the document) plus a small position bonus, then returned in original reading order so the
 * summary reads as prose rather than a ranked list.
 */
export function extractiveSummary(
  passages: Array<{ text: string; heading: string | null }>,
  options: { maxSentences?: number } = {},
): Array<{ heading: string | null; sentence: string }> {
  const maxSentences = options.maxSentences ?? 8;

  const documentFrequency = new Map<string, number>();
  const all: Array<{ heading: string | null; sentence: string; index: number; terms: string[] }> =
    [];
  let index = 0;

  for (const passage of passages) {
    for (const sentence of splitSentences(passage.text)) {
      if (sentence.length < 40) continue;
      const terms = [...new Set(contentTokens(sentence).map(lightStem))];
      for (const term of terms) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      all.push({ heading: passage.heading, sentence: normalizeWhitespace(sentence), index, terms });
      index += 1;
    }
  }

  if (all.length === 0) return [];

  const scored = all.map((item) => {
    const terms = [...new Set(contentTokens(item.sentence).map(lightStem))];
    // Centrality: how much of this sentence's vocabulary recurs elsewhere in the document.
    const centrality =
      terms.length === 0
        ? 0
        : terms.reduce((sum, t) => sum + (documentFrequency.get(t) ?? 0), 0) /
          (terms.length * all.length);
    // Early sentences in a section usually carry the topic statement.
    const positionBonus = 1 / (1 + item.index * 0.02);
    const obligation = /\b(shall|must|required|prohibited)\b/i.test(item.sentence) ? 0.15 : 0;
    return { ...item, score: centrality * 0.7 + positionBonus * 0.15 + obligation };
  });

  return [...scored]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSentences)
    .sort((a, b) => a.index - b.index)
    .map(({ heading, sentence }) => ({ heading, sentence }));
}

/* -------------------------------------------------------------------------- */
/* Answer style projections                                                   */
/* -------------------------------------------------------------------------- */

export interface YesNoView {
  decision: 'YES' | 'NO' | 'UNABLE TO DETERMINE';
  qualifier: string | null;
  reason: string;
  citations: Citation[];
}

/**
 * Yes / No projection.
 *
 * Hard rules from section 11:
 *  - the first line is exactly YES, NO or UNABLE TO DETERMINE;
 *  - partial compliance is NO with a secondary "Partially compliant" label, never YES;
 *  - at most three decisive citations;
 *  - a binary is never forced when the evidence is insufficient.
 */
export function renderYesNo(answer: StructuredAnswer): YesNoView {
  const decision: YesNoView['decision'] =
    answer.decision === 'yes' ? 'YES' : answer.decision === 'no' ? 'NO' : 'UNABLE TO DETERMINE';

  const decisive = pickDecisiveCitations(answer, 3);

  const reason =
    answer.decisiveReason ??
    (decision === 'UNABLE TO DETERMINE'
      ? 'The selected sources do not contain enough verified evidence to decide this question.'
      : answer.headline);

  return {
    decision,
    qualifier: answer.decisionQualifier,
    reason: truncate(reason, 320),
    citations: decisive,
  };
}

export interface OptimalView {
  status: string;
  statusTone: 'positive' | 'warning' | 'negative' | 'neutral';
  explanation: string;
  keyFindings: string[];
  evidenceTable: Array<{
    requirement: string;
    result: Finding['result'];
    locator: string;
    citationId: string | null;
  }>;
  risk: RiskLevel;
  recommendedActions: StructuredAnswer['recommendedActions'];
  confidence: number;
  citations: Citation[];
  followUpQuestion: string | null;
}

/** Optimal projection: an executive answer, roughly 150-350 words, plus a compact table. */
export function renderOptimal(answer: StructuredAnswer): OptimalView {
  const status = statusLabel(answer);
  const evidenceTable = answer.findings.slice(0, 8).map((finding) => {
    const citationId =
      finding.projectEvidenceCitationIds[0] ?? finding.governingCitationIds[0] ?? null;
    const citation = answer.citations.find((c) => c.citationId === citationId) ?? null;
    return {
      requirement: finding.requirementTitle || finding.requirementReference,
      result: finding.result,
      locator: citation
        ? `${citation.documentTitle} - ${formatLocator(citation)}`
        : 'No located evidence',
      citationId,
    };
  });

  return {
    status,
    statusTone: statusTone(answer),
    explanation: clampWords(answer.summary, 150, 350),
    keyFindings: answer.keyFindings,
    evidenceTable,
    risk: answer.riskLevel,
    recommendedActions: answer.recommendedActions.slice(0, 5),
    confidence: answer.confidence.overall,
    citations: pickDecisiveCitations(answer, 6),
    followUpQuestion: answer.followUpQuestion,
  };
}

export interface EvidenceRow {
  requirement: string;
  result: Finding['result'];
  finding: string;
  source: string;
  version: string;
  location: string;
  page: number | null;
  excerpt: string;
  confidence: number;
  verified: boolean;
  citationId: string | null;
}

export interface DetailsView {
  scope: string;
  documentsReviewed: StructuredAnswer['documentsReviewed'];
  assumptions: string[];
  evidenceRows: EvidenceRow[];
  calculations: StructuredAnswer['calculations'];
  conflicts: StructuredAnswer['conflicts'];
  missingEvidence: string[];
  uncertainties: string[];
  risk: RiskLevel;
  remediation: StructuredAnswer['recommendedActions'];
  confidence: ConfidenceBreakdown;
  citations: Citation[];
}

/** Details + references projection: the full audit-grade view with every citation. */
export function renderDetails(answer: StructuredAnswer): DetailsView {
  const byId = new Map(answer.citations.map((c) => [c.citationId, c]));

  const evidenceRows: EvidenceRow[] =
    answer.findings.length > 0
      ? answer.findings.map((finding) => {
          const citationId =
            finding.projectEvidenceCitationIds[0] ?? finding.governingCitationIds[0] ?? null;
          const citation = citationId ? (byId.get(citationId) ?? null) : null;
          return {
            requirement: `${finding.requirementReference} ${finding.requirementTitle}`.trim(),
            result: finding.result,
            finding: finding.finding,
            source: citation?.documentTitle ?? 'Not located',
            version: citation ? citation.sourceVersionId.slice(0, 8) : '-',
            location: citation ? formatLocator(citation) : '-',
            page: citation?.pageNumber ?? null,
            excerpt: citation?.supportingExcerpt ?? '',
            confidence: finding.confidence,
            verified: citation?.verified ?? false,
            citationId,
          };
        })
      : answer.claims.map((claim) => {
          const citation = claim.citationIds[0] ? (byId.get(claim.citationIds[0]) ?? null) : null;
          return {
            requirement: truncate(claim.text, 90),
            result: claim.supported ? ('compliant' as const) : ('needs_evidence' as const),
            finding: claim.text,
            source: citation?.documentTitle ?? 'Not located',
            version: citation ? citation.sourceVersionId.slice(0, 8) : '-',
            location: citation ? formatLocator(citation) : '-',
            page: citation?.pageNumber ?? null,
            excerpt: citation?.supportingExcerpt ?? '',
            confidence: answer.confidence.overall,
            verified: citation?.verified ?? false,
            citationId: claim.citationIds[0] ?? null,
          };
        });

  const scope =
    answer.scope ??
    `Reviewed ${answer.documentsReviewed.length} document(s) at the versions pinned to this consultation.`;

  return {
    scope,
    documentsReviewed: answer.documentsReviewed,
    assumptions: answer.assumptions,
    evidenceRows,
    calculations: answer.calculations,
    conflicts: answer.conflicts,
    missingEvidence: answer.missingEvidence,
    uncertainties: answer.uncertainties,
    risk: answer.riskLevel,
    remediation: answer.recommendedActions,
    confidence: answer.confidence,
    citations: answer.citations,
  };
}

/**
 * Chooses the citations that actually decide the answer: verified first, contradicting
 * evidence prioritised (it is what makes a NO defensible), then by rerank score.
 */
export function pickDecisiveCitations(answer: StructuredAnswer, limit: number): Citation[] {
  const decisiveIds = new Set<string>();
  for (const finding of answer.findings) {
    if (finding.result === 'non_compliant' || finding.result === 'needs_evidence') {
      for (const id of finding.governingCitationIds) decisiveIds.add(id);
      for (const id of finding.projectEvidenceCitationIds) decisiveIds.add(id);
    }
  }

  return [...answer.citations]
    .sort((a, b) => {
      if (a.verified !== b.verified) return a.verified ? -1 : 1;
      const aDecisive = decisiveIds.has(a.citationId) ? 1 : 0;
      const bDecisive = decisiveIds.has(b.citationId) ? 1 : 0;
      if (aDecisive !== bDecisive) return bDecisive - aDecisive;
      if (a.entailment !== b.entailment) {
        const order = { contradicts: 0, supports: 1, context: 2 } as const;
        return order[a.entailment] - order[b.entailment];
      }
      return b.rerankScore - a.rerankScore;
    })
    .slice(0, limit);
}

export function statusLabel(answer: StructuredAnswer): string {
  if (answer.decision === 'unable_to_determine') return 'UNABLE TO DETERMINE';
  if (answer.decisionQualifier) return answer.decisionQualifier.toUpperCase();
  if (answer.task === 'check_compliance') {
    if (answer.decision === 'yes') return 'COMPLIANT';
    if (answer.decision === 'no') return 'NON-COMPLIANT';
  }
  if (answer.decision === 'yes') return 'YES';
  if (answer.decision === 'no') return 'NO';
  return 'GROUNDED ANSWER';
}

function statusTone(answer: StructuredAnswer): OptimalView['statusTone'] {
  if (answer.decision === 'unable_to_determine') return 'neutral';
  if (answer.decisionQualifier) return 'warning';
  if (answer.decision === 'no') return 'negative';
  if (answer.decision === 'yes') return 'positive';
  return 'neutral';
}

/** Keeps the executive answer inside its word budget without cutting mid-sentence. */
export function clampWords(text: string, min: number, max: number): string {
  const sentences = splitSentences(text);
  const out: string[] = [];
  let words = 0;

  for (const sentence of sentences) {
    const count = sentence.split(/\s+/).filter(Boolean).length;
    if (words + count > max && words >= min) break;
    out.push(sentence);
    words += count;
    if (words >= max) break;
  }

  return out.length > 0 ? out.join(' ') : truncate(text, max * 7);
}

function truncate(text: string, max: number): string {
  const clean = normalizeWhitespace(text);
  return clean.length <= max ? clean : `${clean.slice(0, max).trimEnd()}...`;
}

/** Re-exported so the report generator uses the same excerpt selection as the UI. */
export { selectExcerpt };
