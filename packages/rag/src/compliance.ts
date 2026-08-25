import type { ComplianceResult, RiskLevel } from '@uxe/contracts';
import type { FusedCandidate } from './fusion.js';
import { detectConflict, extractQuantities, selectExcerpt } from './citations.js';
import { contentTokens, lightStem, normalizeForMatch, normalizeWhitespace, splitSentences } from './text.js';
import type { DetectedSection } from './structure.js';
import { sectionReference } from './structure.js';

export interface RequirementDraft {
  requirementId: string;
  reference: string;
  title: string;
  obligationText: string;
  modality: 'mandatory' | 'recommended' | 'permissive' | 'prohibited';
  sourceId: string;
  sourceVersionId: string;
  sectionId: string | null;
  exceptions: string[];
  crossReferences: string[];
  ordinal: number;
  /** Terms that project evidence must address for this requirement to be satisfied. */
  keyTerms: string[];
  /** Quantities the obligation specifies, e.g. { length_m: 1.2 }. */
  quantities: Map<string, number>;
}

/**
 * Builds the applicable requirement set from the governing sources.
 *
 * Section 13 of the brief is explicit that a compliance check must first build a
 * requirement set and then test each requirement, rather than asking one free-form
 * question. That is what this function and `evaluateRequirement` implement: the unit of
 * work is a requirement, so every obligation gets its own verdict, its own evidence and
 * its own place in the matrix — and a requirement with no evidence is visibly
 * `needs_evidence` instead of quietly disappearing.
 */
export function buildRequirementSet(
  sections: Array<DetectedSection & { id: string; sourceId: string; sourceVersionId: string }>,
  options: { idFactory: () => string; maxRequirements?: number } = { idFactory: () => '' },
): RequirementDraft[] {
  const max = options.maxRequirements ?? 400;
  const out: RequirementDraft[] = [];
  const seen = new Set<string>();

  for (const section of sections) {
    if (out.length >= max) break;
    if (!section.isRequirement) continue;
    if (section.modality !== 'mandatory' && section.modality !== 'prohibited') continue;

    const reference = sectionReference(section);
    const obligation = extractObligationSentences(section.body || section.title);
    if (!obligation) continue;

    // A superseded provision must not create an obligation.
    if (section.supersededNote) continue;

    const key = `${section.sourceVersionId}:${reference}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      requirementId: options.idFactory(),
      reference,
      title: normalizeWhitespace(section.title).slice(0, 200) || reference,
      obligationText: obligation,
      modality: section.modality,
      sourceId: section.sourceId,
      sourceVersionId: section.sourceVersionId,
      sectionId: section.id,
      exceptions: section.exceptions,
      crossReferences: section.crossReferences,
      ordinal: out.length + 1,
      keyTerms: requirementKeyTerms(`${section.title} ${obligation}`),
      quantities: extractQuantities(obligation),
    });
  }

  return out;
}

/** Keeps only the sentences that actually carry the obligation. */
function extractObligationSentences(body: string): string | null {
  const sentences = splitSentences(body);
  const obligations = sentences.filter((s) =>
    /\b(shall|must|is required|are required|shall not|must not|is prohibited|are prohibited)\b/i.test(s),
  );
  const text = normalizeWhitespace((obligations.length > 0 ? obligations : sentences).join(' '));
  return text.length >= 25 ? text.slice(0, 2000) : null;
}

/**
 * The subject-matter terms a project document must address. Modal verbs and boilerplate
 * are removed because "shall" appearing in the project document proves nothing.
 */
const OBLIGATION_NOISE = new Set([
  // Modal and boilerplate verbs.
  'shall', 'must', 'should', 'may', 'required', 'require', 'requires', 'prohibited',
  'permitted', 'allowed', 'accordance', 'provided', 'specified', 'applicable', 'relevant',
  'following', 'above', 'below', 'section', 'clause', 'article', 'annex', 'table', 'figure',
  'subject', 'means', 'include', 'includes', 'including', 'ensure', 'ensured', 'provide',
  'provides', 'comply', 'complies', 'compliance', 'requirement', 'requirements',
  // Comparatives and quantifiers. The magnitude they qualify is compared numerically by
  // `quantitySatisfies`; leaving the words in key terms only dilutes subject-matter
  // coverage, which made genuinely-evidenced requirements look unaddressed.
  'less', 'more', 'least', 'most', 'minimum', 'maximum', 'exceed', 'exceeds', 'exceeding',
  'greater', 'lower', 'higher', 'than', 'every', 'each', 'all', 'any', 'other', 'such',
  'measured', 'upon', 'within', 'per', 'shall_not',
]);

export function requirementKeyTerms(text: string): string[] {
  const counts = new Map<string, number>();
  for (const token of contentTokens(text)) {
    // Bare numerals are evidence for the quantity comparison, not subject-matter terms.
    if (/^[\d.]+$/.test(token)) continue;
    const stem = lightStem(token);
    if (OBLIGATION_NOISE.has(token) || OBLIGATION_NOISE.has(stem)) continue;
    if (stem.length < 3) continue;
    counts.set(stem, (counts.get(stem) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([term]) => term);
}

export interface RequirementEvidence {
  candidate: FusedCandidate;
  /** 0..1 — how completely this passage addresses the requirement's key terms. */
  termCoverage: number;
  quantities: Map<string, number>;
  excerpt: string;
}

export interface RequirementVerdict {
  result: ComplianceResult;
  risk: RiskLevel;
  finding: string;
  confidence: number;
  missingEvidence: string[];
  conflicts: Array<{ description: string; evidenceIndexes: number[] }>;
  recommendedAction: string | null;
  /** Indexes into the supplied evidence array that justify this verdict. */
  supportingEvidenceIndexes: number[];
}

const COMPLIANCE_THRESHOLD = 0.62;
const PARTIAL_THRESHOLD = 0.3;

/**
 * Tests one requirement against evidence found in the customer's project documents.
 *
 * The logic is intentionally conservative and explainable:
 *
 *  - No project evidence at all -> `needs_evidence`. Never `compliant` by default, and
 *    never `non_compliant` either, because absence of evidence in the retrieved set is not
 *    proof of a violation.
 *  - A quantity in the project document that contradicts the obligation's quantity ->
 *    `non_compliant`, because that is a demonstrable failure with a number to point at.
 *  - Evidence that explicitly negates the obligation -> `non_compliant`.
 *  - Strong term coverage with no contradiction -> `compliant`.
 *  - Partial coverage -> `needs_evidence` with the uncovered terms named, so the user knows
 *    exactly what to supply.
 */
export function evaluateRequirement(
  requirement: RequirementDraft,
  evidence: RequirementEvidence[],
): RequirementVerdict {
  if (evidence.length === 0) {
    return {
      result: 'needs_evidence',
      risk: requirement.modality === 'prohibited' ? 'high' : 'medium',
      finding: `No passage in the reviewed project documents addresses ${requirement.reference}. The obligation is therefore unproven, not disproven.`,
      confidence: 0.4,
      missingEvidence: requirement.keyTerms.slice(0, 6),
      conflicts: [],
      recommendedAction: `Provide the document or section that demonstrates how ${requirement.reference} is satisfied.`,
      supportingEvidenceIndexes: [],
    };
  }

  const best = [...evidence].sort((a, b) => b.termCoverage - a.termCoverage);
  const top = best[0] as RequirementEvidence;
  const supporting = best
    .filter((e) => e.termCoverage >= PARTIAL_THRESHOLD)
    .slice(0, 3)
    .map((e) => evidence.indexOf(e));

  // --- Quantity contradiction -------------------------------------------
  const quantityConflicts: Array<{ description: string; evidenceIndexes: number[] }> = [];
  for (const [unit, required] of requirement.quantities) {
    for (const item of best) {
      const actual = item.quantities.get(unit);
      if (actual === undefined) continue;
      if (!quantitySatisfies(requirement.obligationText, required, actual)) {
        quantityConflicts.push({
          description: `${requirement.reference} specifies ${formatQuantity(unit, required)} but the project document states ${formatQuantity(unit, actual)}.`,
          evidenceIndexes: [evidence.indexOf(item)],
        });
      }
    }
  }

  if (quantityConflicts.length > 0) {
    return {
      result: 'non_compliant',
      risk: requirement.modality === 'prohibited' ? 'critical' : 'high',
      finding: quantityConflicts[0]?.description ?? 'A specified value in the project document conflicts with the requirement.',
      confidence: 0.82,
      missingEvidence: [],
      conflicts: quantityConflicts,
      recommendedAction: `Amend the project document so the stated value satisfies ${requirement.reference}.`,
      supportingEvidenceIndexes: supporting,
    };
  }

  // --- Quantity satisfied -------------------------------------------------
  // A numeric obligation met by a stated project value is demonstrable compliance, and is
  // stronger evidence than term overlap. Without this, a requirement whose wording differs
  // from the project document would be reported as unevidenced even though the numbers
  // plainly satisfy it.
  const satisfied = collectSatisfiedQuantities(requirement, best);
  if (satisfied.length > 0 && (best[0]?.termCoverage ?? 0) >= 0.25) {
    const item = satisfied[0] as { description: string; index: number };
    return {
      result: 'compliant',
      risk: 'none',
      finding: item.description,
      confidence: 0.88,
      missingEvidence: [],
      conflicts: [],
      recommendedAction: null,
      supportingEvidenceIndexes: [...new Set([evidence.indexOf(best[item.index] as RequirementEvidence), ...supporting])].filter(
        (i) => i >= 0,
      ),
    };
  }

  // --- Explicit negation --------------------------------------------------
  const negating = best.find((e) => negatesObligation(requirement, e.candidate.content));
  if (negating) {
    return {
      result: 'non_compliant',
      risk: 'high',
      finding: `The project document states a position that conflicts with ${requirement.reference}: "${truncate(negating.excerpt, 180)}"`,
      confidence: 0.72,
      missingEvidence: [],
      conflicts: [
        {
          description: `Project text contradicts the obligation in ${requirement.reference}.`,
          evidenceIndexes: [evidence.indexOf(negating)],
        },
      ],
      recommendedAction: `Revise the conflicting statement so it complies with ${requirement.reference}.`,
      supportingEvidenceIndexes: [evidence.indexOf(negating)],
    };
  }

  // --- Internal conflicts between two project passages --------------------
  const conflicts: Array<{ description: string; evidenceIndexes: number[] }> = [];
  for (let i = 0; i < best.length; i += 1) {
    for (let j = i + 1; j < best.length; j += 1) {
      const a = best[i];
      const b = best[j];
      if (!a || !b) continue;
      const conflict = detectConflict(a.candidate.content, b.candidate.content);
      if (conflict.conflict && conflict.reason) {
        conflicts.push({
          description: conflict.reason,
          evidenceIndexes: [evidence.indexOf(a), evidence.indexOf(b)],
        });
      }
    }
  }

  // --- Coverage-based verdict --------------------------------------------
  const coverage = top.termCoverage;

  if (coverage >= COMPLIANCE_THRESHOLD && conflicts.length === 0) {
    return {
      result: 'compliant',
      risk: 'none',
      finding: `The project documents address ${requirement.reference}. Supporting text: "${truncate(top.excerpt, 180)}"`,
      confidence: Math.min(0.95, 0.55 + coverage * 0.4),
      missingEvidence: [],
      conflicts: [],
      recommendedAction: null,
      supportingEvidenceIndexes: supporting,
    };
  }

  const uncovered = uncoveredTerms(requirement, best);

  if (conflicts.length > 0) {
    return {
      result: 'needs_evidence',
      risk: 'medium',
      finding: `Evidence relating to ${requirement.reference} is inconsistent across the project documents, so a single verdict cannot be reached.`,
      confidence: 0.45,
      missingEvidence: uncovered,
      conflicts,
      recommendedAction: `Reconcile the conflicting statements, then re-run the review for ${requirement.reference}.`,
      supportingEvidenceIndexes: supporting,
    };
  }

  return {
    result: 'needs_evidence',
    risk: requirement.modality === 'prohibited' ? 'high' : 'medium',
    finding:
      uncovered.length > 0
        ? `The project documents partially address ${requirement.reference} but do not evidence: ${uncovered.join(', ')}.`
        : `The project documents mention ${requirement.reference} but the passage found is not specific enough to demonstrate compliance.`,
    confidence: 0.4 + coverage * 0.25,
    missingEvidence: uncovered,
    conflicts: [],
    recommendedAction: `Supply the section that demonstrates ${uncovered.length > 0 ? uncovered.join(', ') : requirement.reference}.`,
    supportingEvidenceIndexes: supporting,
  };
}

/**
 * Scores how completely a passage addresses a requirement's key terms.
 * Weighted by term rank so the most distinctive terms count for more.
 */
export function scoreRequirementEvidence(
  requirement: RequirementDraft,
  candidate: FusedCandidate,
  query: string,
): RequirementEvidence {
  const passageTokens = new Set(contentTokens(candidate.content).map(lightStem));
  const terms = requirement.keyTerms;

  let weighted = 0;
  let totalWeight = 0;
  terms.forEach((term, index) => {
    // Rank-decayed weight: the first term matters roughly twice as much as the eighth.
    const weight = 1 / (1 + index * 0.15);
    totalWeight += weight;
    if (passageTokens.has(term)) weighted += weight;
  });

  const termCoverage = totalWeight === 0 ? 0 : weighted / totalWeight;

  return {
    candidate,
    termCoverage,
    quantities: extractQuantities(candidate.content),
    excerpt: selectExcerpt(candidate.content, query || requirement.obligationText),
  };
}

/** Every comparable quantity the project evidence states that satisfies the obligation. */
function collectSatisfiedQuantities(
  requirement: RequirementDraft,
  evidence: RequirementEvidence[],
): Array<{ description: string; index: number }> {
  const out: Array<{ description: string; index: number }> = [];
  for (const [unit, required] of requirement.quantities) {
    evidence.forEach((item, index) => {
      const actual = item.quantities.get(unit);
      if (actual === undefined) return;
      if (!quantitySatisfies(requirement.obligationText, required, actual)) return;
      out.push({
        description: `${requirement.reference} requires ${formatQuantity(unit, required)} and the project document states ${formatQuantity(unit, actual)}, which satisfies it. Supporting text: "${truncate(item.excerpt, 150)}"`,
        index,
      });
    });
  }
  return out;
}

function uncoveredTerms(requirement: RequirementDraft, evidence: RequirementEvidence[]): string[] {
  const covered = new Set<string>();
  for (const item of evidence) {
    for (const token of contentTokens(item.candidate.content).map(lightStem)) covered.add(token);
  }
  return requirement.keyTerms.filter((t) => !covered.has(t)).slice(0, 6);
}

/**
 * Decides whether an observed value satisfies an obligation, respecting the direction the
 * obligation states. "at least 1.2 m" is satisfied by 1.5; "not exceeding 30 m" is not.
 */
export function quantitySatisfies(obligation: string, required: number, actual: number): boolean {
  const t = obligation.toLowerCase();

  // Maximum is tested first because "shall not exceed" contains "exceed", and reading that
  // as a lower bound would invert the verdict: 38 m would be reported as failing a 45 m cap.
  const isMaximum =
    /\b(?:at most|not more than|no more than|maximum|not exceeding|(?:shall|must|may)\s+not\s+exceed|less than or equal|up to)\b/.test(t);
  if (isMaximum) return actual <= required + 1e-9;

  const isMinimum =
    /\b(?:at least|not less than|no less than|minimum|greater than or equal|no lower than)\b/.test(t);
  if (isMinimum) return actual >= required - 1e-9;

  // With no stated direction, only an exact match is defensible.
  return Math.abs(actual - required) <= Math.max(1e-9, Math.abs(required) * 0.001);
}

function negatesObligation(requirement: RequirementDraft, passage: string): boolean {
  const passageNorm = normalizeForMatch(passage);
  const overlap = requirement.keyTerms.filter((t) => passageNorm.includes(t)).length;
  if (requirement.keyTerms.length === 0 || overlap / requirement.keyTerms.length < 0.4) return false;

  const passageProhibits = /\b(shall not|must not|is not provided|are not provided|not required|no .{0,25}(is|are) provided|is omitted|are omitted|not installed|not applicable)\b/i.test(passage);
  const requirementRequires = requirement.modality === 'mandatory';
  const passageRequires = /\b(shall|must|is provided|are provided|is installed)\b/i.test(passage) && !passageProhibits;
  const requirementProhibits = requirement.modality === 'prohibited';

  return (requirementRequires && passageProhibits) || (requirementProhibits && passageRequires);
}

function formatQuantity(unit: string, value: number): string {
  const labels: Record<string, (v: number) => string> = {
    length_m: (v) => (v < 1 ? `${(v * 1000).toFixed(0)} mm` : `${v.toFixed(2)} m`),
    time_s: (v) => (v >= 60 ? `${(v / 60).toFixed(0)} min` : `${v.toFixed(0)} s`),
    mass_kg: (v) => `${v.toFixed(2)} kg`,
    percent: (v) => `${v.toFixed(0)}%`,
    illuminance_lx: (v) => `${v.toFixed(0)} lux`,
    pressure_pa: (v) => `${(v / 1000).toFixed(1)} kPa`,
    people: (v) => `${v.toFixed(0)} persons`,
  };
  return labels[unit]?.(value) ?? `${value} ${unit}`;
}

function truncate(text: string, max: number): string {
  const clean = normalizeWhitespace(text);
  return clean.length <= max ? clean : `${clean.slice(0, max).trimEnd()}...`;
}

/** Rolls the individual verdicts up into the review-level risk level. */
export function aggregateRisk(results: Array<{ result: ComplianceResult; risk: RiskLevel }>): RiskLevel {
  if (results.some((r) => r.result === 'non_compliant' && r.risk === 'critical')) return 'critical';
  const nonCompliant = results.filter((r) => r.result === 'non_compliant').length;
  if (nonCompliant >= 3) return 'critical';
  if (nonCompliant > 0) return 'high';
  const needsEvidence = results.filter((r) => r.result === 'needs_evidence').length;
  if (needsEvidence >= 5) return 'high';
  if (needsEvidence > 0) return 'medium';
  return 'none';
}

/**
 * The overall decision for a compliance review.
 *
 * Rule 4 of the answer-style contract: partial compliance returns NO with a
 * "Partially compliant" qualifier. Reporting partial compliance as YES would falsely imply
 * the document is acceptable, which is the most damaging error this product could make.
 */
export function decideOverall(counts: {
  compliant: number;
  nonCompliant: number;
  needsEvidence: number;
  notAssessed: number;
}): { decision: 'yes' | 'no' | 'unable_to_determine'; qualifier: string | null } {
  const assessed = counts.compliant + counts.nonCompliant + counts.needsEvidence;
  if (assessed === 0) return { decision: 'unable_to_determine', qualifier: null };

  if (counts.nonCompliant > 0) {
    return {
      decision: 'no',
      qualifier: counts.compliant > 0 ? 'Partially compliant' : null,
    };
  }

  if (counts.needsEvidence > 0) {
    // Unproven requirements cannot be waved through as compliant.
    return counts.compliant > 0
      ? { decision: 'no', qualifier: 'Partially compliant' }
      : { decision: 'unable_to_determine', qualifier: null };
  }

  return { decision: 'yes', qualifier: null };
}
