import type { ComplianceResult, RiskLevel } from '@uxe/contracts';
import type { FusedCandidate } from './fusion.js';
import {
  detectConflict,
  extractMeasurements,
  extractQuantities,
  selectExcerpt,
  type Measurement,
} from './citations.js';
import {
  contentTokens,
  lightStem,
  normalizeForMatch,
  normalizeWhitespace,
  splitSentences,
} from './text.js';
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
  /** The same magnitudes, each keeping the words it was written among. */
  measurements: Measurement[];
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
  /*
   * Obligations the cap left out.
   *
   * Counted rather than silently dropped: a review of sixty requirements from a document
   * that contains six hundred is a sample, and reporting "9 not met" without saying so
   * reads as a verdict on the whole code. The caller needs the number to be able to say
   * what was and was not looked at.
   */
  let omitted = 0;

  for (const section of sections) {
    if (out.length >= max) {
      if (section.isRequirement && !section.supersededNote) omitted += 1;
      continue;
    }
    if (!section.isRequirement) continue;
    if (section.modality !== 'mandatory' && section.modality !== 'prohibited') continue;

    const reference = sectionReference(section);
    /*
     * A chapter is not a testable obligation.
     *
     * `sectionReference` falls back to "Ch. 2" when neither a clause nor a section number
     * was detected, and the review dutifully tested those, producing findings addressed to
     * "Ch. 0" and "Ch. 5" — a whole chapter's worth of prose collapsed into one verdict,
     * with nothing an engineer could look up. A finding has to cite an exact clause to be
     * worth anything, so an obligation that cannot be cited to one is not tested. Counted
     * as omitted rather than dropped in silence.
     */
    if (!section.clause && !section.section) {
      omitted += 1;
      continue;
    }

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
      measurements: extractMeasurements(obligation),
    });
  }

  // Attached to the array rather than changing the return type: every caller keeps working,
  // and the one that reports scope can say how much of the document was actually tested.
  Object.defineProperty(out, 'omittedRequirements', { value: omitted, enumerable: false });
  return out;
}

/** How many obligations the cap left untested, for a caller that has to disclose it. */
export function omittedRequirements(drafts: RequirementDraft[]): number {
  return (drafts as RequirementDraft[] & { omittedRequirements?: number }).omittedRequirements ?? 0;
}

/** Keeps only the sentences that actually carry the obligation. */
function extractObligationSentences(body: string): string | null {
  const sentences = splitSentences(body);
  const obligations = sentences.filter((s) =>
    /\b(shall|must|is required|are required|shall not|must not|is prohibited|are prohibited)\b/i.test(
      s,
    ),
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
  'shall',
  'must',
  'should',
  'may',
  'required',
  'require',
  'requires',
  'prohibited',
  'permitted',
  'allowed',
  'accordance',
  'provided',
  'specified',
  'applicable',
  'relevant',
  'following',
  'above',
  'below',
  'section',
  'clause',
  'article',
  'annex',
  'table',
  'figure',
  'subject',
  'means',
  'include',
  'includes',
  'including',
  'ensure',
  'ensured',
  'provide',
  'provides',
  'comply',
  'complies',
  'compliance',
  'requirement',
  'requirements',
  // Comparatives and quantifiers. The magnitude they qualify is compared numerically by
  // `quantitySatisfies`; leaving the words in key terms only dilutes subject-matter
  // coverage, which made genuinely-evidenced requirements look unaddressed.
  'less',
  'more',
  'least',
  'most',
  'minimum',
  'maximum',
  'exceed',
  'exceeds',
  'exceeding',
  'greater',
  'lower',
  'higher',
  'than',
  'every',
  'each',
  'all',
  'any',
  'other',
  'such',
  'measured',
  'upon',
  'within',
  'per',
  'shall_not',
  /*
   * Filler that survives the global stopword list.
   *
   * These reached the reports verbatim — "2.17.6.4 ... do not evidence: baluster, guard,
   * one, panel, supported, american" — where "one", "supported" and "american" say nothing
   * an engineer can act on. Worse, they are eligible to anchor a numeric comparison, so a
   * figure written near the word "one" could be compared against a clause about something
   * else entirely. Removing them sharpens both the wording and the verdict.
   */
  'one',
  'two',
  'three',
  'four',
  'five',
  'see',
  'top',
  'bottom',
  'side',
  'part',
  'case',
  'type',
  'kind',
  'use',
  'used',
  'using',
  'given',
  'made',
  'taken',
  'having',
  'where',
  'when',
  'while',
  'also',
  'both',
  'either',
  'neither',
  'unless',
  'except',
  'considered',
  'accepted',
  'american',
  'british',
  'european',
  'international',
  'national',
  'general',
  'various',
  'certain',
  'similar',
  'appropriate',
  'suitable',
  'necessary',
  'adequate',
  'sufficient',
  'permitted',
  'allowed',
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
  /** Every magnitude in the passage, with the words around it. */
  measurements: Measurement[];
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
      finding: `${requirement.reference} requires ${obligationInPlainWords(requirement)}. Nothing on the reviewed sheets covers this.`,
      confidence: 0.4,
      missingEvidence: requirement.keyTerms.slice(0, 6),
      conflicts: [],
      recommendedAction: `Show on the drawing that ${obligationInPlainWords(requirement)} (${requirement.reference}), or supply the document that does.`,
      supportingEvidenceIndexes: [],
    };
  }

  const best = [...evidence].sort((a, b) => b.termCoverage - a.termCoverage);
  const top = best[0] as RequirementEvidence;
  const supporting = best
    .filter((e) => e.termCoverage >= PARTIAL_THRESHOLD)
    .slice(0, 3)
    .map((e) => evidence.indexOf(e));

  // --- Numeric comparison, anchored to its subject ------------------------
  // Both directions go through the same gate. Only comparing figures that are demonstrably
  // about the same thing is the whole point: without it a drawing that happens to state
  // "240 min" anywhere is reported as breaching a 30-minute clause it never mentions.
  const comparisons = anchoredComparisons(requirement, evidence, best);
  const disputed = comparisons.filter((c) => c.disputed !== undefined);
  const breaches = comparisons.filter((c) => !c.satisfied);
  const meets = comparisons.filter((c) => c.satisfied && c.disputed === undefined);

  // The submission disagreeing with itself is reported as exactly that. Calling it a pass
  // would bury a breaching figure; calling it a failure would convict on a possible stray.
  if (disputed.length > 0) {
    const hit = disputed[0] as AnchoredComparison;
    const other = hit.disputed as AnchoredComparison;
    const description = `${requirement.reference} requires ${formatQuantity(hit.required.unit, hit.required.value)}. The drawing states both ${hit.observed.raw} and ${other.observed.raw}.`;
    return {
      result: 'needs_evidence',
      risk: 'medium',
      finding: `${description} Which governs cannot be determined from the drawing.`,
      confidence: 0.45,
      missingEvidence: [],
      conflicts: [{ description, evidenceIndexes: [hit.evidenceIndex, other.evidenceIndex] }],
      recommendedAction: `Reconcile the two stated values, then re-run the check for ${requirement.reference}.`,
      supportingEvidenceIndexes: [
        ...new Set([hit.evidenceIndex, other.evidenceIndex, ...supporting]),
      ],
    };
  }

  if (breaches.length > 0) {
    const conflicts = breaches.map((c) => ({
      description: `${requirement.reference} requires ${formatQuantity(c.required.unit, c.required.value)}. The drawing states ${c.observed.raw}.`,
      evidenceIndexes: [c.evidenceIndex],
    }));
    return {
      result: 'non_compliant',
      risk: requirement.modality === 'prohibited' ? 'critical' : 'high',
      finding: conflicts[0]?.description ?? 'A stated value conflicts with the requirement.',
      confidence: 0.82,
      missingEvidence: [],
      conflicts,
      recommendedAction: `Amend the project document so the stated value satisfies ${requirement.reference}.`,
      supportingEvidenceIndexes: [
        ...new Set([...breaches.map((c) => c.evidenceIndex), ...supporting]),
      ],
    };
  }

  if (meets.length > 0) {
    // A numeric obligation met by a stated project value is demonstrable compliance, and
    // is stronger evidence than term overlap.
    const hit = meets[0] as AnchoredComparison;
    /*
     * The finding says what was found; the citation carries the quotation.
     *
     * It used to end with `Supporting text: "..."`, which put a quoted passage inside a
     * sentence that is also shown where no evidence is meant to appear — a report asked
     * for without its evidence still carried quotations, smuggled through the one field
     * that was never filtered. The excerpt travels with the citation, which is what gets
     * dropped when evidence is excluded.
     */
    return {
      result: 'compliant',
      risk: 'none',
      finding: `${requirement.reference} requires ${formatQuantity(hit.required.unit, hit.required.value)}. The drawing states ${hit.observed.raw}, which meets it.`,
      confidence: 0.88,
      missingEvidence: [],
      conflicts: [],
      recommendedAction: null,
      supportingEvidenceIndexes: [...new Set([hit.evidenceIndex, ...supporting])].filter(
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
      // Same rule as the compliant branch: no quotation inside the finding sentence. The
      // conflicting passage is the citation attached to this finding.
      finding: `The drawing states the opposite of what ${requirement.reference} requires: ${obligationInPlainWords(requirement)}.`,
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

  /*
   * Internal conflicts between two project passages.
   *
   * Held to the same standard as everything else here: both passages must actually address
   * the obligation before their disagreement is allowed to decide it. Without the gate a
   * drawing set produced a steady stream of "evidence relating to 3.10.1 is inconsistent"
   * — two sheets that mention smoke dampers and quote different duct sizes, which is what
   * a drawing set looks like, not a contradiction.
   */
  const onPoint = best.filter((e) => e.termCoverage >= QUANTITY_ANCHOR_COVERAGE);
  const conflicts: Array<{ description: string; evidenceIndexes: number[] }> = [];
  for (let i = 0; i < onPoint.length; i += 1) {
    for (let j = i + 1; j < onPoint.length; j += 1) {
      const a = onPoint[i];
      const b = onPoint[j];
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

  /*
   * A clause that sets a figure can only be satisfied by a figure.
   *
   * This sits ahead of the word-overlap pass on purpose. Overlap shows a submission is
   * *about* the same subject, which is enough to conclude that something required to be
   * provided has been provided — but not that something required to reach 120 minutes
   * reaches it. Left below, a drawing that named every word in a fire-resistance clause and
   * no rating at all came back with a green tick, and the excerpt underneath it did not
   * contain the number the tick was claiming. That is the specific way this product would
   * be worth less than nothing to somebody signing off a building.
   *
   * It is also the commonest unverifiable case on a drawing, and worth naming precisely:
   * saying which figure is missing and where it belongs tells an engineer what to add.
   */
  const numeric = requirement.measurements[0];
  if (numeric && comparisons.length === 0) {
    return {
      result: 'needs_evidence',
      risk: requirement.modality === 'prohibited' ? 'high' : 'medium',
      finding: `${requirement.reference} requires ${obligationInPlainWords(requirement)}. The drawing gives no figure for it.`,
      confidence: 0.4 + coverage * 0.2,
      missingEvidence: uncoveredTerms(requirement, best),
      conflicts: [],
      recommendedAction: `Mark the ${formatQuantity(numeric.unit, numeric.value)} required by ${requirement.reference} on the drawing.`,
      supportingEvidenceIndexes: supporting,
    };
  }

  if (coverage >= COMPLIANCE_THRESHOLD && conflicts.length === 0) {
    return {
      result: 'compliant',
      risk: 'none',
      finding: `The drawing shows ${obligationInPlainWords(requirement)}, as ${requirement.reference} requires.`,
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
      finding: `Two passages of the submission disagree about ${requirement.reference} (${conflicts[0]?.description ?? 'conflicting statements'}), so a single verdict cannot be reached from the drawing.`,
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
    finding: `${requirement.reference} requires ${obligationInPlainWords(requirement)}. The drawing does not show it.`,
    confidence: 0.4 + coverage * 0.25,
    missingEvidence: uncovered,
    conflicts: [],
    recommendedAction: `Show on the drawing that ${obligationInPlainWords(requirement)} (${requirement.reference}).`,
    supportingEvidenceIndexes: supporting,
  };
}

/**
 * The obligation as the clause states it, short enough to read at a glance.
 *
 * What used to be here was the matcher's own leftovers — "do not evidence: area, included,
 * civil, construction, defence, horizontal" and, worse, stemmed fragments like "featur".
 * That is the internals of a term-overlap score printed at a reader who wants to know what
 * to draw. It also reached the recommended actions verbatim, so the instruction a person
 * was given read "Supply the section that demonstrates window, outward, see, top".
 *
 * The clause's own first sentence says what is required, in the words of the code the
 * reader is being held to. Trimmed of the modal preamble because "shall be provided" is
 * true of every clause and carries nothing.
 */
function obligationInPlainWords(requirement: RequirementDraft): string {
  /*
   * The first sentence is usually the obligation, but not always.
   *
   * Clause bodies in a real code begin with list markers — "a.", "iii." — and splitting on
   * full stops turns those into sentences of their own. Taking the first one blindly
   * produced findings that read "2.16.6.3 requires a.", which is worse than the token
   * lists it replaced. So the first sentence with something in it is used, and the
   * clause's own title stands in when none of them has.
   */
  const candidate =
    splitSentences(requirement.obligationText).find((sentence) => isSubstantive(sentence)) ??
    (isSubstantive(requirement.title) ? requirement.title : requirement.obligationText);

  const trimmed = normalizeWhitespace(candidate)
    // Drop the list marker a sentence may still carry, then the modal preamble: "shall be
    // provided" is true of every clause in the book and tells a reader nothing.
    .replace(/^(?:[a-z]|[ivx]{1,4}|\d{1,2})[.)]\s+/i, '')
    .replace(/\s*\b(?:shall|must)\s+(not\s+)?(?:be\s+)?/i, (_m, negated: string | undefined) =>
      negated === undefined ? ' ' : ' not ',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.;:,]+$/, '');

  // Short enough to read in the row it sits in. A reader who wants the full wording opens
  // the clause, which every finding cites.
  const short = trimmed.length > 110 ? `${cutOnWord(trimmed, 110)}...` : trimmed;
  return short.charAt(0).toLowerCase() + short.slice(1);
}

/** Enough words to mean something, rather than a numbering artefact. */
function isSubstantive(text: string): boolean {
  const words = normalizeWhitespace(text)
    .replace(/^(?:[a-z]|[ivx]{1,4}|\d{1,2})[.)]\s*/i, '')
    .split(' ')
    .filter((word) => /\p{L}{3}/u.test(word));
  return words.length >= 3;
}

/** Truncates on a word boundary, so a clause never ends mid-word. */
function cutOnWord(text: string, max: number): string {
  const clipped = text.slice(0, max);
  const lastSpace = clipped.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? clipped.slice(0, lastSpace) : clipped).trimEnd();
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
    measurements: extractMeasurements(candidate.content),
    excerpt: selectExcerpt(candidate.content, query || requirement.obligationText),
  };
}

/**
 * Minimum share of the obligation's own subject words a passage must carry before any
 * number inside it is compared against that obligation.
 */
const QUANTITY_ANCHOR_COVERAGE = 0.34;

/** Subject words the two figures must share before they count as the same measurement. */
const MIN_SHARED_SUBJECT = 2;

/** One figure in the code compared against one figure in the submission. */
export interface AnchoredComparison {
  required: Measurement;
  observed: Measurement;
  /** Index into the caller's evidence array. */
  evidenceIndex: number;
  satisfied: boolean;
  /** The words that tie the two figures to the same subject. */
  sharedSubject: string[];
  /**
   * Set when another passage states a breaching value for this same subject — the
   * submission disagreeing with itself, which is neither a pass nor a failure.
   */
  disputed?: AnchoredComparison;
}

/**
 * Pairs a magnitude in the obligation with a magnitude in the submission — but only when
 * both are demonstrably about the same thing.
 *
 * This gate is the difference between a review and a random-number generator. Sharing a
 * unit family proves nothing: a fire code and a fire-alarm drawing both state lengths in
 * metres on nearly every page, and comparing the first of each produced findings like
 * "2.17.2.2 specifies 1.20 m but the project document states 152.40 m" — a guard-rail
 * height measured against a drawing coordinate. Three conditions must all hold:
 *
 *  1. the passage addresses the obligation at all (`termCoverage`), so a stray sheet does
 *     not get to decide a clause it never mentions;
 *  2. the two figures are written among the same subject words; and
 *  3. at least one of those shared words is one the obligation itself is about.
 *
 * When no pair clears all three, there is no numeric verdict — which is a `needs_evidence`
 * outcome, never a violation.
 */
export function anchoredComparisons(
  requirement: RequirementDraft,
  evidence: RequirementEvidence[],
  ranked: RequirementEvidence[] = evidence,
): AnchoredComparison[] {
  if (requirement.measurements.length === 0) return [];
  const keyTerms = new Set(requirement.keyTerms);
  const out: AnchoredComparison[] = [];

  for (const item of ranked) {
    if (item.termCoverage < QUANTITY_ANCHOR_COVERAGE) continue;
    const index = evidence.indexOf(item);
    if (index < 0) continue;

    for (const required of requirement.measurements) {
      for (const observed of item.measurements) {
        if (observed.unit !== required.unit) continue;

        const shared = required.context.filter((term) => observed.context.includes(term));
        if (shared.length < MIN_SHARED_SUBJECT) continue;
        // At least one shared word has to be something the obligation is actually about.
        // "provided" and "system" appear beside every figure in both documents.
        const onSubject = shared.filter((term) => keyTerms.has(term));
        if (onSubject.length === 0) continue;

        out.push({
          required,
          observed,
          evidenceIndex: index,
          satisfied: quantitySatisfies(requirement.obligationText, required.value, observed.value),
          sharedSubject: onSubject.slice(0, 4),
        });
      }
    }
  }

  /*
   * One verdict per subject.
   *
   * A drawing states the same kind of dimension on many sheets, so the same clause can
   * legitimately draw several comparisons. Where they agree there is nothing to choose
   * between them. Where they do not — one sheet satisfying the clause and another
   * breaching it — the submission contradicts itself, and neither "compliant" nor
   * "non-compliant" is the honest answer: the group is marked `disputed` and the caller
   * reports it as something to reconcile, with both figures named.
   */
  const bySubject = new Map<string, AnchoredComparison[]>();
  for (const comparison of out) {
    const key = `${comparison.required.unit}:${comparison.sharedSubject.join('|')}`;
    bySubject.set(key, [...(bySubject.get(key) ?? []), comparison]);
  }

  return [...bySubject.values()].map((group) => {
    const pass = group.find((c) => c.satisfied);
    const fail = group.find((c) => !c.satisfied);
    if (pass && fail) return { ...pass, disputed: fail };
    return (pass ?? group[0]) as AnchoredComparison;
  });
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
    /\b(?:at most|not more than|no more than|maximum|not exceeding|(?:shall|must|may)\s+not\s+exceed|less than or equal|up to)\b/.test(
      t,
    );
  if (isMaximum) return actual <= required + 1e-9;

  const isMinimum =
    /\b(?:at least|not less than|no less than|minimum|greater than or equal|no lower than)\b/.test(
      t,
    );
  if (isMinimum) return actual >= required - 1e-9;

  // With no stated direction, only an exact match is defensible.
  return Math.abs(actual - required) <= Math.max(1e-9, Math.abs(required) * 0.001);
}

function negatesObligation(requirement: RequirementDraft, passage: string): boolean {
  const passageNorm = normalizeForMatch(passage);
  const overlap = requirement.keyTerms.filter((t) => passageNorm.includes(t)).length;
  if (requirement.keyTerms.length === 0 || overlap / requirement.keyTerms.length < 0.4)
    return false;

  const passageProhibits =
    /\b(shall not|must not|is not provided|are not provided|not required|no .{0,25}(is|are) provided|is omitted|are omitted|not installed|not applicable)\b/i.test(
      passage,
    );
  const requirementRequires = requirement.modality === 'mandatory';
  const passageRequires =
    /\b(shall|must|is provided|are provided|is installed)\b/i.test(passage) && !passageProhibits;
  const requirementProhibits = requirement.modality === 'prohibited';

  return (requirementRequires && passageProhibits) || (requirementProhibits && passageRequires);
}

/** "45.00" -> "45", "1.20" -> "1.2". */
function trimZeros(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}

function formatQuantity(unit: string, value: number): string {
  const labels: Record<string, (v: number) => string> = {
    // Trailing zeros are noise: a 45 m limit is written "45 m", not "45.00 m".
    length_m: (v) => (v < 1 ? `${(v * 1000).toFixed(0)} mm` : `${trimZeros(v.toFixed(2))} m`),
    time_s: (v) => (v >= 60 ? `${(v / 60).toFixed(0)} min` : `${v.toFixed(0)} s`),
    mass_kg: (v) => `${trimZeros(v.toFixed(2))} kg`,
    percent: (v) => `${v.toFixed(0)}%`,
    illuminance_lx: (v) => `${v.toFixed(0)} lux`,
    pressure_pa: (v) => `${(v / 1000).toFixed(1)} kPa`,
    people: (v) => `${v.toFixed(0)} persons`,
  };
  return labels[unit]?.(value) ?? `${value} ${unit}`;
}

/** Rolls the individual verdicts up into the review-level risk level. */
export function aggregateRisk(
  results: Array<{ result: ComplianceResult; risk: RiskLevel }>,
): RiskLevel {
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
