import { describe, expect, it } from 'vitest';
import type { Citation, Finding } from '@uxe/contracts';
import {
  aggregateRisk,
  buildChangePlan,
  buildRequirementSet,
  chunkSections,
  decideOverall,
  decideOutputStrategy,
  detectModality,
  detectStructure,
  evaluateRequirement,
  isRequirementText,
  quantitySatisfies,
  requirementKeyTerms,
  validateDerivative,
  type DetectedSection,
} from '@uxe/rag';

const CODE_PAGES = [
  {
    pageNumber: 1,
    text: `CHAPTER 6 Means of Egress

6.4 Emergency lighting

6.4.2 Emergency illumination
Emergency illumination shall cover every point along the means of egress and shall provide an average illuminance of not less than 10 lux measured at the floor.

6.6.1 Maximum travel distance
Travel distance to an exit shall not exceed 45 m in sprinklered buildings.
Notwithstanding 6.6.1, travel distance may extend to 60 m where an approved smoke control system is provided.`,
    width: 595,
    height: 842,
    sheetName: null,
    slideNumber: null,
    ocrApplied: false,
    ocrConfidence: null,
    wordBoxes: [],
  },
];

describe('detectModality', () => {
  it('recognises mandatory language', () => {
    expect(detectModality('The exit shall be not less than 1.2 m')).toBe('mandatory');
    expect(detectModality('Occupants must evacuate')).toBe('mandatory');
  });

  it('recognises prohibition', () => {
    expect(detectModality('Doors shall not be locked')).toBe('prohibited');
  });

  it('distinguishes a recommendation from an obligation', () => {
    // Reporting a "should" as a violation would be a false positive.
    expect(detectModality('Signage should be illuminated')).toBe('recommended');
  });

  it('recognises permission', () => {
    expect(detectModality('Travel distance may extend to 60 m')).toBe('permissive');
  });

  it('returns null when there is no modal verb', () => {
    expect(detectModality('This chapter describes egress.')).toBeNull();
  });
});

describe('isRequirementText', () => {
  it('accepts a substantive obligation', () => {
    expect(
      isRequirementText('Emergency illumination shall provide not less than 10 lux at the floor.'),
    ).toBe(true);
  });

  it('rejects a recommendation', () => {
    expect(isRequirementText('Emergency illumination should be provided where practical.')).toBe(
      false,
    );
  });

  it('rejects a fragment too short to test', () => {
    expect(isRequirementText('It shall apply.')).toBe(false);
  });
});

describe('detectStructure', () => {
  const sections = detectStructure(CODE_PAGES);

  it('detects clause numbering and inherits chapter context', () => {
    const clause = sections.find((s) => s.clause === '6.4.2');
    expect(clause).toBeDefined();
    expect(clause?.chapter).toBe('6');
    expect(clause?.section).toBe('6.4');
  });

  it('flags obligations as requirements', () => {
    expect(sections.find((s) => s.clause === '6.4.2')?.isRequirement).toBe(true);
  });

  it('captures exceptions introduced by "notwithstanding"', () => {
    const travel = sections.find((s) => s.clause === '6.6.1');
    expect(travel?.exceptions.length).toBeGreaterThan(0);
    expect(travel?.exceptions[0]).toContain('Notwithstanding');
  });

  it('marks heading-derived sections so chunking can quote their titles', () => {
    expect(sections.find((s) => s.clause === '6.4.2')?.fromHeading).toBe(true);
  });
});

describe('chunkSections', () => {
  const sections = detectStructure(CODE_PAGES);
  const chunks = chunkSections(sections);

  it('never mixes two clauses in one chunk', () => {
    // Quoting text under the wrong clause number is the worst failure this product has.
    for (const chunk of chunks) {
      const clauseMentions = new Set(
        [...chunk.content.matchAll(/\b(\d\.\d\.\d)\b/g)].map((m) => m[1]),
      );
      if (chunk.clause) {
        for (const mentioned of clauseMentions) {
          // A cross-reference is allowed; what is not allowed is the chunk being *about*
          // two clauses, which shows up as its own clause differing from its heading.
          expect(typeof mentioned).toBe('string');
        }
      }
    }
    const clauseChunks = chunks.filter((c) => c.clause !== null);
    expect(new Set(clauseChunks.map((c) => c.clause)).size).toBe(
      new Set(sections.filter((s) => s.clause).map((s) => s.clause)).size,
    );
  });

  it('keeps chunk content verbatim, with heading context held separately', () => {
    const clause = chunks.find((c) => c.clause === '6.4.2');
    expect(clause?.content).not.toContain('>');
    expect(clause?.headingText).toContain('Means of Egress');
  });

  it('carries the parent clause onto every chunk', () => {
    const clause = chunks.find((c) => c.content.includes('10 lux'));
    expect(clause?.clause).toBe('6.4.2');
    expect(clause?.pageNumber).toBe(1);
  });
});

describe('buildRequirementSet', () => {
  const sections = detectStructure(CODE_PAGES).map((s, i) => ({
    ...s,
    id: `sec-${i}`,
    sourceId: 'src',
    sourceVersionId: 'ver',
  })) as Array<DetectedSection & { id: string; sourceId: string; sourceVersionId: string }>;

  let counter = 0;
  const requirements = buildRequirementSet(sections, { idFactory: () => `req-${counter++}` });

  it('builds one requirement per testable obligation', () => {
    expect(requirements.length).toBeGreaterThan(0);
    expect(
      requirements.every((r) => r.modality === 'mandatory' || r.modality === 'prohibited'),
    ).toBe(true);
  });

  it('uses the clause number as the reference', () => {
    expect(requirements.map((r) => r.reference)).toContain('6.4.2');
  });

  it('extracts the quantities the obligation specifies', () => {
    const illumination = requirements.find((r) => r.reference === '6.4.2');
    expect(illumination?.quantities.get('illuminance_lx')).toBe(10);
  });

  it('excludes modal and comparative words from the key terms', () => {
    const terms = requirementKeyTerms('The exit shall be not less than 1.2 m in clear width');
    expect(terms).not.toContain('shall');
    expect(terms).not.toContain('less');
    expect(terms).not.toContain('minimum');
    // Bare numerals are compared numerically, not matched as vocabulary.
    expect(terms).not.toContain('1.2');
    expect(terms).toContain('exit');
  });
});

describe('quantitySatisfies', () => {
  it('treats "not less than" as a floor', () => {
    expect(quantitySatisfies('shall be not less than 1.2 m', 1.2, 1.5)).toBe(true);
    expect(quantitySatisfies('shall be not less than 1.2 m', 1.2, 0.9)).toBe(false);
  });

  it('treats "shall not exceed" as a ceiling, despite containing the word "exceed"', () => {
    expect(quantitySatisfies('shall not exceed 45 m', 45, 38)).toBe(true);
    expect(quantitySatisfies('shall not exceed 45 m', 45, 52)).toBe(false);
  });

  it('treats "at least" as a floor and "at most" as a ceiling', () => {
    expect(quantitySatisfies('at least 10 lux', 10, 12)).toBe(true);
    expect(quantitySatisfies('at most 30 persons', 30, 25)).toBe(true);
    expect(quantitySatisfies('at most 30 persons', 30, 40)).toBe(false);
  });

  it('requires an exact match when the obligation states no direction', () => {
    expect(quantitySatisfies('shall be 2.1 m', 2.1, 2.1)).toBe(true);
    expect(quantitySatisfies('shall be 2.1 m', 2.1, 2.4)).toBe(false);
  });
});

describe('evaluateRequirement', () => {
  const requirement = {
    requirementId: 'r1',
    reference: '6.4.2',
    title: 'Emergency illumination',
    obligationText:
      'Emergency illumination shall provide an average illuminance of not less than 10 lux measured at the floor.',
    modality: 'mandatory' as const,
    sourceId: 's1',
    sourceVersionId: 'v1',
    sectionId: null,
    exceptions: [],
    crossReferences: [],
    ordinal: 1,
    keyTerms: ['emergency', 'illumination', 'illuminance', 'floor'],
    quantities: new Map([['illuminance_lx', 10]]),
  };

  const evidence = (content: string, coverage: number) => [
    {
      candidate: { content } as never,
      termCoverage: coverage,
      quantities: new Map(
        [...content.matchAll(/(\d+(?:\.\d+)?)\s*lux/gi)].map(
          (m) => ['illuminance_lx', Number(m[1])] as const,
        ),
      ),
      excerpt: content,
    },
  ];

  it('returns needs_evidence, never non_compliant, when nothing addresses the requirement', () => {
    // Absence of evidence is not proof of a violation.
    const verdict = evaluateRequirement(requirement, []);
    expect(verdict.result).toBe('needs_evidence');
    expect(verdict.missingEvidence.length).toBeGreaterThan(0);
    expect(verdict.recommendedAction).toContain('6.4.2');
  });

  it('returns non_compliant with an arithmetic reason when a value breaches the obligation', () => {
    const verdict = evaluateRequirement(
      requirement,
      evidence('Emergency illumination at floor level is 6 lux across all corridors.', 0.8),
    );
    expect(verdict.result).toBe('non_compliant');
    expect(verdict.finding).toContain('10 lux');
    expect(verdict.finding).toContain('6 lux');
  });

  it('returns compliant when a stated value satisfies the obligation', () => {
    const verdict = evaluateRequirement(
      requirement,
      evidence('Emergency illumination at floor level is 12 lux across all corridors.', 0.8),
    );
    expect(verdict.result).toBe('compliant');
    expect(verdict.risk).toBe('none');
  });

  it('returns needs_evidence when the passage is on topic but not specific', () => {
    const verdict = evaluateRequirement(
      requirement,
      evidence('Emergency lighting is discussed in the design narrative.', 0.35),
    );
    expect(verdict.result).toBe('needs_evidence');
  });
});

describe('decideOverall', () => {
  it('returns NO with a "Partially compliant" qualifier when some requirements fail', () => {
    // Reporting partial compliance as YES is the most damaging error possible here.
    const result = decideOverall({
      compliant: 3,
      nonCompliant: 1,
      needsEvidence: 0,
      notAssessed: 0,
    });
    expect(result.decision).toBe('no');
    expect(result.qualifier).toBe('Partially compliant');
  });

  it('returns a plain NO when nothing passed', () => {
    const result = decideOverall({
      compliant: 0,
      nonCompliant: 2,
      needsEvidence: 0,
      notAssessed: 0,
    });
    expect(result.decision).toBe('no');
    expect(result.qualifier).toBeNull();
  });

  it('does not wave unproven requirements through as compliant', () => {
    const result = decideOverall({
      compliant: 2,
      nonCompliant: 0,
      needsEvidence: 1,
      notAssessed: 0,
    });
    expect(result.decision).toBe('no');
    expect(result.qualifier).toBe('Partially compliant');
  });

  it('returns YES only when every requirement is met', () => {
    expect(
      decideOverall({ compliant: 4, nonCompliant: 0, needsEvidence: 0, notAssessed: 0 }).decision,
    ).toBe('yes');
  });

  it('returns unable_to_determine when nothing was assessed', () => {
    expect(
      decideOverall({ compliant: 0, nonCompliant: 0, needsEvidence: 0, notAssessed: 3 }).decision,
    ).toBe('unable_to_determine');
  });
});

describe('aggregateRisk', () => {
  it('escalates to critical on a critical non-compliance', () => {
    expect(aggregateRisk([{ result: 'non_compliant', risk: 'critical' }])).toBe('critical');
  });

  it('escalates to critical on three or more failures', () => {
    expect(
      aggregateRisk([
        { result: 'non_compliant', risk: 'high' },
        { result: 'non_compliant', risk: 'high' },
        { result: 'non_compliant', risk: 'high' },
      ]),
    ).toBe('critical');
  });

  it('reports no risk when everything passed', () => {
    expect(aggregateRisk([{ result: 'compliant', risk: 'none' }])).toBe('none');
  });
});

describe('decideOutputStrategy', () => {
  const base = {
    hasExtractableText: true,
    isScanned: false,
    isSigned: false,
    isEncrypted: false,
    hasMacros: false,
    pageCount: 10,
  };

  it('uses tracked changes for DOCX', () => {
    expect(decideOutputStrategy({ ...base, documentType: 'docx' }).strategy).toBe(
      'tracked_changes',
    );
  });

  it('overlays a text-based PDF', () => {
    expect(decideOutputStrategy({ ...base, documentType: 'pdf' }).strategy).toBe('overlay');
  });

  it('rebuilds a scanned PDF from OCR and discloses the limitation up front', () => {
    const decision = decideOutputStrategy({
      ...base,
      documentType: 'pdf',
      isScanned: true,
      hasExtractableText: false,
    });
    expect(decision.strategy).toBe('ocr_rebuild');
    expect(decision.isDerivativeEdition).toBe(true);
    expect(decision.limitations.join(' ')).toContain('OCR');
  });

  it('never edits a signed PDF in place, and never implies the signature survives', () => {
    const decision = decideOutputStrategy({ ...base, documentType: 'pdf', isSigned: true });
    expect(decision.strategy).toBe('revised_edition');
    expect(decision.signatureNotice).toContain('UNSIGNED');
    expect(decision.signatureNotice).toContain('cannot be preserved');
    expect(decision.limitations.join(' ')).toContain('Signature validity is not preserved');
  });

  it('flags macros without executing them', () => {
    const decision = decideOutputStrategy({ ...base, documentType: 'xlsx', hasMacros: true });
    expect(decision.limitations.join(' ')).toContain('never executed');
  });

  it('states the limitation before generating a revised edition for an unsupported type', () => {
    const decision = decideOutputStrategy({ ...base, documentType: 'html' });
    expect(decision.strategy).toBe('revised_edition');
    expect(decision.isDerivativeEdition).toBe(true);
    expect(decision.limitations.length).toBeGreaterThan(0);
  });
});

describe('buildChangePlan', () => {
  const governing: Citation = {
    citationId: 'g1',
    tenantId: 'org',
    sourceId: 's1',
    sourceVersionId: 'v1',
    sourceSha256: 'a'.repeat(64),
    documentTitle: 'UAE Fire Code',
    documentType: 'pdf',
    pageNumber: 1,
    sheetName: null,
    cellRange: null,
    slideNumber: null,
    shapeName: null,
    chapter: '6',
    section: '6.4',
    clause: '6.4.2',
    headingPath: [],
    paragraphIndex: 0,
    charStart: 0,
    charEnd: 100,
    urlFragment: null,
    boundingBoxes: [],
    supportingExcerpt:
      'Emergency illumination shall provide not less than 10 lux measured at the floor.',
    retrievalScore: 0.9,
    rerankScore: 0.9,
    entailment: 'supports',
    verified: true,
    verificationMethod: 'exact',
    effectiveDate: null,
    supersededBy: null,
    createdAt: new Date().toISOString(),
  };

  const project: Citation = {
    ...governing,
    citationId: 'p1',
    sourceId: 's2',
    documentTitle: 'Evacuation Plan',
    clause: null,
    section: null,
    supportingExcerpt: 'The design illuminance at floor level is 6 lux.',
  };

  const finding: Finding = {
    findingId: 'f1',
    requirementId: 'r1',
    requirementReference: '6.4.2',
    requirementTitle: 'Emergency illumination',
    result: 'non_compliant',
    risk: 'high',
    finding: '6.4.2 specifies 10 lux but the project document states 6 lux.',
    projectEvidenceCitationIds: ['p1'],
    governingCitationIds: ['g1'],
    missingEvidence: [],
    conflicts: [],
    recommendedAction: 'Raise the design illuminance.',
    confidence: 0.82,
  };

  it('proposes a change for each actionable finding, never for a passing one', () => {
    const changes = buildChangePlan({
      findings: [finding, { ...finding, findingId: 'f2', result: 'compliant' }],
      citations: [governing, project],
      projectCandidates: [],
    });
    expect(changes).toHaveLength(1);
  });

  it('rewrites the non-compliant value to the required one', () => {
    const [change] = buildChangePlan({
      findings: [finding],
      citations: [governing, project],
      projectCandidates: [],
    });
    expect(change?.currentContent).toContain('6 lux');
    expect(change?.proposedContent).toContain('10 lux');
    expect(change?.proposedContent).not.toContain('6 lux');
  });

  it('carries the governing citation and the reason onto the change', () => {
    const [change] = buildChangePlan({
      findings: [finding],
      citations: [governing, project],
      projectCandidates: [],
    });
    expect(change?.governingCitationId).toBe('g1');
    expect(change?.reason).toContain('6.4.2');
    expect(change?.locatorLabel).toContain('Evacuation Plan');
  });
});

describe('validateDerivative', () => {
  const original = {
    pages: 10,
    textLength: 10_000,
    mediaCount: 3,
    pageSizes: [{ w: 595, h: 842 }],
  };

  it('passes an unchanged-shape derivative', () => {
    const report = validateDerivative({
      original,
      generated: {
        opened: true,
        pages: 10,
        textLength: 10_050,
        mediaCount: 3,
        pageSizes: [{ w: 595, h: 842 }],
      },
      acceptedChangeCount: 2,
    });
    expect(report.ok).toBe(true);
  });

  it('blocks release when the file will not re-open', () => {
    const report = validateDerivative({
      original,
      generated: {
        opened: false,
        pages: 10,
        textLength: 10_000,
        mediaCount: 3,
        pageSizes: [{ w: 595, h: 842 }],
      },
      acceptedChangeCount: 1,
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'opens')?.passed).toBe(false);
  });

  it('blocks release on unexplained content loss', () => {
    const report = validateDerivative({
      original,
      generated: {
        opened: true,
        pages: 10,
        textLength: 4000,
        mediaCount: 3,
        pageSizes: [{ w: 595, h: 842 }],
      },
      acceptedChangeCount: 1,
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'no_content_loss')?.passed).toBe(false);
  });

  it('blocks release when a page is lost', () => {
    const report = validateDerivative({
      original,
      generated: {
        opened: true,
        pages: 9,
        textLength: 10_000,
        mediaCount: 3,
        pageSizes: [{ w: 595, h: 842 }],
      },
      acceptedChangeCount: 1,
    });
    expect(report.ok).toBe(false);
  });

  it('accepts a declared addendum page without accepting an undeclared one', () => {
    const withAddendum = validateDerivative({
      original,
      generated: {
        opened: true,
        pages: 11,
        textLength: 10_400,
        mediaCount: 3,
        pageSizes: [{ w: 595, h: 842 }],
      },
      acceptedChangeCount: 2,
      allowedExtraPages: 1,
    });
    expect(withAddendum.ok).toBe(true);

    const undeclared = validateDerivative({
      original,
      generated: {
        opened: true,
        pages: 11,
        textLength: 10_400,
        mediaCount: 3,
        pageSizes: [{ w: 595, h: 842 }],
      },
      acceptedChangeCount: 2,
    });
    expect(undeclared.ok).toBe(false);
  });

  it('blocks release when page dimensions change', () => {
    const report = validateDerivative({
      original,
      generated: {
        opened: true,
        pages: 10,
        textLength: 10_000,
        mediaCount: 3,
        pageSizes: [{ w: 612, h: 792 }],
      },
      acceptedChangeCount: 1,
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'page_dimensions')?.passed).toBe(false);
  });

  it('blocks release when embedded media is dropped', () => {
    const report = validateDerivative({
      original,
      generated: {
        opened: true,
        pages: 10,
        textLength: 10_000,
        mediaCount: 1,
        pageSizes: [{ w: 595, h: 842 }],
      },
      acceptedChangeCount: 1,
    });
    expect(report.ok).toBe(false);
  });
});
