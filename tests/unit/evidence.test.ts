import { describe, expect, it } from 'vitest';
import type { Citation, Claim, Finding } from '@uxe/contracts';
import { formatLocator } from '@uxe/contracts';
import {
  classifyEntailment,
  computeBoundingBoxes,
  computeConfidence,
  computeEvidenceCoverage,
  computeKnowledgeHealth,
  detectConflict,
  extractQuantities,
  selectExcerpt,
  shouldAbstain,
  sourceAuthorityScore,
  verifyExcerpt,
} from '@uxe/rag';

function citation(overrides: Partial<Citation> = {}): Citation {
  return {
    citationId: 'c1',
    tenantId: 'org',
    sourceId: 's1',
    sourceVersionId: 'v1',
    sourceSha256: 'a'.repeat(64),
    documentTitle: 'UAE Fire Code',
    documentType: 'pdf',
    pageNumber: 214,
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
    charEnd: 10,
    urlFragment: null,
    boundingBoxes: [],
    supportingExcerpt: 'Emergency illumination shall cover every point.',
    retrievalScore: 0.8,
    rerankScore: 0.9,
    entailment: 'supports',
    verified: true,
    verificationMethod: 'exact',
    effectiveDate: null,
    supersededBy: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('formatLocator', () => {
  it('formats a chapter/clause/page locator', () => {
    expect(formatLocator(citation())).toBe('Ch. 6 · §6.4.2 · p. 214');
  });

  it('falls back to a sheet and cell range for a spreadsheet', () => {
    expect(
      formatLocator(
        citation({
          chapter: null,
          section: null,
          clause: null,
          pageNumber: null,
          sheetName: 'Budget',
          cellRange: 'B12:D40',
        }),
      ),
    ).toBe('Sheet Budget · B12:D40');
  });

  it('falls back to a slide number', () => {
    expect(
      formatLocator(
        citation({ chapter: null, section: null, clause: null, pageNumber: null, slideNumber: 4 }),
      ),
    ).toBe('Slide 4');
  });

  it('falls back to the heading path when nothing else is available', () => {
    expect(
      formatLocator(
        citation({
          chapter: null,
          section: null,
          clause: null,
          pageNumber: null,
          headingPath: ['Part A', 'Scope'],
        }),
      ),
    ).toBe('Part A › Scope');
  });

  it('falls back to a paragraph index as a last resort', () => {
    expect(
      formatLocator(
        citation({
          chapter: null,
          section: null,
          clause: null,
          pageNumber: null,
          paragraphIndex: 3,
        }),
      ),
    ).toBe('¶4');
  });
});

describe('verifyExcerpt', () => {
  const page = {
    pageNumber: 214,
    text: 'Emergency illumination shall cover every point along the means of egress.',
    width: 595,
    height: 842,
    wordBoxes: [],
  };

  it('verifies text that is present', () => {
    const result = verifyExcerpt('shall cover every point', page);
    expect(result.verified).toBe(true);
    expect(result.method).toBe('exact');
    expect(result.reason).toBeNull();
  });

  it('refuses text that is absent, and says why', () => {
    const result = verifyExcerpt('shall provide a fire blanket', page);
    expect(result.verified).toBe(false);
    expect(result.method).toBe('failed');
    expect(result.reason).toContain('does not appear on page 214');
  });

  it('refuses when the cited page could not be loaded', () => {
    const result = verifyExcerpt('anything', null);
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('could not be loaded');
  });

  it('refuses an empty excerpt', () => {
    expect(verifyExcerpt('   ', page).verified).toBe(false);
  });
});

describe('computeBoundingBoxes', () => {
  const page = {
    pageNumber: 1,
    text: 'Emergency illumination shall cover',
    width: 595,
    height: 842,
    wordBoxes: [
      { t: 'Emergency', x: 0.1, y: 0.2, w: 0.09, h: 0.015 },
      { t: 'illumination', x: 0.2, y: 0.2, w: 0.1, h: 0.015 },
      { t: 'shall', x: 0.31, y: 0.2, w: 0.04, h: 0.015 },
      // Wrapped onto the next visual line.
      { t: 'cover', x: 0.1, y: 0.23, w: 0.05, h: 0.015 },
    ],
  };

  it('produces one rectangle per visual line', () => {
    const boxes = computeBoundingBoxes(page, 'Emergency illumination shall cover');
    expect(boxes).toHaveLength(2);
    expect(boxes[0]?.page).toBe(1);
    // The first line spans from the first word to the last on that line.
    expect(boxes[0]?.x).toBeCloseTo(0.1, 3);
    expect(boxes[0]?.width).toBeCloseTo(0.25, 2);
  });

  it('returns nothing when the document has no coordinate data', () => {
    expect(computeBoundingBoxes({ ...page, wordBoxes: [] }, 'Emergency')).toEqual([]);
  });
});

describe('quantities', () => {
  it('extracts and canonicalises units', () => {
    const q = extractQuantities('not less than 1.2 m and at least 10 lux for 90 minutes');
    expect(q.get('length_m')).toBeCloseTo(1.2);
    expect(q.get('illuminance_lx')).toBe(10);
    expect(q.get('time_s')).toBe(5400);
  });

  it('normalises millimetres to metres', () => {
    expect(extractQuantities('a clear width of 1200 mm').get('length_m')).toBeCloseTo(1.2);
  });
});

describe('detectConflict', () => {
  it('reports conflicting values for the same subject', () => {
    const result = detectConflict(
      'The clear width of every exit shall be 1.2 m.',
      'The clear width of every exit shall be 0.9 m.',
    );
    expect(result.conflict).toBe(true);
    expect(result.reason).toContain('Conflicting values');
  });

  it('does not report a conflict between unrelated measurements', () => {
    // Both are lengths in metres, but exit width and travel distance are different things.
    const result = detectConflict(
      'All exit doors provide a clear width of 1.5 m.',
      'The longest travel distance to a protected stair is 38 m.',
    );
    expect(result.conflict).toBe(false);
  });

  it('reports opposite polarity over shared subject matter', () => {
    const result = detectConflict(
      'Emergency lighting shall be provided in every stairwell.',
      'Emergency lighting shall not be provided in every stairwell.',
    );
    expect(result.conflict).toBe(true);
  });
});

describe('classifyEntailment', () => {
  it('marks a supporting passage', () => {
    expect(
      classifyEntailment(
        'Emergency lighting must be installed along the egress path',
        'Emergency lighting shall be installed along the means of egress path.',
      ),
    ).toBe('supports');
  });

  it('marks a contradicting passage', () => {
    expect(
      classifyEntailment(
        'Emergency lighting must be installed along the egress path',
        'Emergency lighting shall not be installed along the egress path.',
      ),
    ).toBe('contradicts');
  });

  it('marks an unrelated passage as context, never as support', () => {
    expect(
      classifyEntailment(
        'Emergency lighting must be installed along the egress path',
        'Invoices are payable within thirty days of receipt.',
      ),
    ).toBe('context');
  });
});

describe('selectExcerpt', () => {
  it('quotes the sentence that answers the question', () => {
    const passage =
      'This section applies to assembly occupancies. Emergency illumination shall provide not less than 10 lux. Records shall be retained.';
    const excerpt = selectExcerpt(passage, 'illuminance requirement lux');
    expect(excerpt).toContain('10 lux');
  });

  it('prefers obligation language', () => {
    const passage = 'Lighting is discussed below. Emergency lighting shall operate for 90 minutes.';
    expect(selectExcerpt(passage, 'lighting')).toContain('shall operate');
  });

  it('returns verbatim text present in the source', () => {
    const passage = 'Emergency illumination shall cover every point along the means of egress.';
    const excerpt = selectExcerpt(passage, 'egress');
    // The whole no-hallucination guarantee rests on this.
    expect(passage).toContain(excerpt.replace(/\.\.\.$/, ''));
  });
});

describe('computeEvidenceCoverage', () => {
  const claims: Claim[] = [
    { claimId: 'a', text: 'x', citationIds: ['c1'], supported: true, fromGeneralModel: false },
    { claimId: 'b', text: 'y', citationIds: ['c2'], supported: true, fromGeneralModel: false },
  ];

  it('counts a claim as supported only when a citation actually verified', () => {
    const coverage = computeEvidenceCoverage({
      claims,
      citations: [
        citation({ citationId: 'c1' }),
        citation({ citationId: 'c2', verified: false, verificationMethod: 'failed' }),
      ],
      regulationSourceIds: ['s1'],
      projectSourceIds: [],
    });
    expect(coverage.claimsTotal).toBe(2);
    expect(coverage.claimsSupported).toBe(1);
    expect(coverage.score).toBe(0.5);
    expect(coverage.unverifiedCitations).toBe(1);
  });

  it('measures coverage over requirements when findings are present', () => {
    const findings: Finding[] = [
      {
        findingId: 'f1',
        requirementId: 'r1',
        requirementReference: '6.4.2',
        requirementTitle: 'Emergency illumination',
        result: 'non_compliant',
        risk: 'high',
        finding: 'Fails',
        projectEvidenceCitationIds: ['c1'],
        governingCitationIds: [],
        missingEvidence: [],
        conflicts: [],
        recommendedAction: null,
        confidence: 0.8,
      },
      {
        findingId: 'f2',
        requirementId: 'r2',
        requirementReference: '6.5.1',
        requirementTitle: 'Exit width',
        result: 'not_assessed',
        risk: 'none',
        finding: 'Not reached',
        projectEvidenceCitationIds: [],
        governingCitationIds: [],
        missingEvidence: [],
        conflicts: [],
        recommendedAction: null,
        confidence: 0.2,
      },
    ];

    const coverage = computeEvidenceCoverage({
      claims,
      citations: [citation({ citationId: 'c1' })],
      findings,
      regulationSourceIds: ['s1'],
      projectSourceIds: ['s2'],
    });

    expect(coverage.claimsTotal).toBe(2);
    expect(coverage.claimsSupported).toBe(1);
  });
});

describe('computeConfidence', () => {
  const base = {
    citations: [citation()],
    retrievalScores: [0.9],
    sourceAuthorityScores: [0.9],
    effectiveDates: [new Date()],
    conflictCount: 0,
  };

  const coverage = (score: number) => ({
    score,
    citedPassages: 1,
    regulationsUsed: 1,
    projectDocumentsUsed: 1,
    verifiedCitations: 1,
    unverifiedCitations: 0,
    conflictingCitations: 0,
    claimsTotal: 1,
    claimsSupported: score >= 1 ? 1 : 0,
  });

  it('is deterministic for identical inputs', () => {
    const a = computeConfidence({ ...base, coverage: coverage(1) });
    const b = computeConfidence({ ...base, coverage: coverage(1) });
    expect(a.overall).toBe(b.overall);
  });

  it('drops when citations fail verification', () => {
    const verified = computeConfidence({ ...base, coverage: coverage(1) });
    const unverified = computeConfidence({
      ...base,
      coverage: coverage(1),
      citations: [citation({ verified: false, verificationMethod: 'failed' })],
    });
    expect(unverified.citationVerification).toBe(0);
    expect(unverified.overall).toBeLessThan(verified.overall);
  });

  it('drops sharply when sources contradict each other', () => {
    const clean = computeConfidence({ ...base, coverage: coverage(1) });
    const conflicted = computeConfidence({ ...base, coverage: coverage(1), conflictCount: 3 });
    expect(conflicted.overall).toBeLessThan(clean.overall * 0.8);
  });

  it('decays with the age of the governing source', () => {
    const fresh = computeConfidence({ ...base, coverage: coverage(1) });
    const old = computeConfidence({
      ...base,
      coverage: coverage(1),
      effectiveDates: [new Date(Date.now() - 20 * 365 * 86_400_000)],
    });
    expect(old.recency).toBe(0);
    expect(old.overall).toBeLessThan(fresh.overall);
  });

  it('stays within 0..1', () => {
    const result = computeConfidence({ ...base, coverage: coverage(1) });
    for (const value of Object.values(result)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe('sourceAuthorityScore', () => {
  it('ranks a regulation above a project document', () => {
    const regulation = sourceAuthorityScore({
      role: 'governing',
      hasEffectiveDate: true,
      promoted: true,
      tags: ['regulation'],
      superseded: false,
    });
    const project = sourceAuthorityScore({
      role: 'project',
      hasEffectiveDate: false,
      promoted: false,
      tags: [],
      superseded: false,
    });
    expect(regulation).toBeGreaterThan(project);
  });

  it('collapses the authority of a superseded source', () => {
    expect(
      sourceAuthorityScore({
        role: 'governing',
        hasEffectiveDate: true,
        promoted: true,
        tags: ['regulation'],
        superseded: true,
      }),
    ).toBeLessThan(0.2);
  });
});

describe('shouldAbstain', () => {
  const confidence = computeConfidence({
    coverage: {
      score: 1,
      citedPassages: 1,
      regulationsUsed: 1,
      projectDocumentsUsed: 1,
      verifiedCitations: 1,
      unverifiedCitations: 0,
      conflictingCitations: 0,
      claimsTotal: 1,
      claimsSupported: 1,
    },
    citations: [citation()],
    retrievalScores: [0.9],
    sourceAuthorityScores: [0.9],
    effectiveDates: [new Date()],
    conflictCount: 0,
  });

  it('abstains when nothing verified', () => {
    const result = shouldAbstain({
      coverage: {
        score: 0,
        citedPassages: 0,
        regulationsUsed: 0,
        projectDocumentsUsed: 0,
        verifiedCitations: 0,
        unverifiedCitations: 2,
        conflictingCitations: 0,
        claimsTotal: 2,
        claimsSupported: 0,
      },
      confidence,
      minimumEvidenceThreshold: 0.3,
      askWhenUncertain: true,
      verifiedCitations: 0,
    });
    expect(result.abstain).toBe(true);
    expect(result.reason).toContain('No passage');
  });

  it('abstains below the workspace evidence threshold, and names the number', () => {
    const result = shouldAbstain({
      coverage: {
        score: 0.2,
        citedPassages: 1,
        regulationsUsed: 1,
        projectDocumentsUsed: 0,
        verifiedCitations: 1,
        unverifiedCitations: 0,
        conflictingCitations: 0,
        claimsTotal: 5,
        claimsSupported: 1,
      },
      confidence,
      minimumEvidenceThreshold: 0.5,
      askWhenUncertain: true,
      verifiedCitations: 1,
    });
    expect(result.abstain).toBe(true);
    expect(result.reason).toContain('20%');
    expect(result.reason).toContain('50%');
  });

  it('answers when evidence is sufficient', () => {
    const result = shouldAbstain({
      coverage: {
        score: 1,
        citedPassages: 3,
        regulationsUsed: 1,
        projectDocumentsUsed: 1,
        verifiedCitations: 3,
        unverifiedCitations: 0,
        conflictingCitations: 0,
        claimsTotal: 3,
        claimsSupported: 3,
      },
      confidence,
      minimumEvidenceThreshold: 0.3,
      askWhenUncertain: true,
      verifiedCitations: 3,
    });
    expect(result.abstain).toBe(false);
  });
});

describe('computeKnowledgeHealth', () => {
  it('is 100 for an empty knowledge base', () => {
    expect(
      computeKnowledgeHealth({
        total: 0,
        ready: 0,
        failed: 0,
        processing: 0,
        needsReview: 0,
        outdated: 0,
        missingMetadata: 0,
        unlinkedContent: 0,
        duplicates: 0,
        permissionIssues: 0,
      }),
    ).toBe(100);
  });

  it('is 100 when everything is healthy', () => {
    expect(
      computeKnowledgeHealth({
        total: 10,
        ready: 10,
        failed: 0,
        processing: 0,
        needsReview: 0,
        outdated: 0,
        missingMetadata: 0,
        unlinkedContent: 0,
        duplicates: 0,
        permissionIssues: 0,
      }),
    ).toBe(100);
  });

  it('penalises failures most heavily', () => {
    const failed = computeKnowledgeHealth({
      total: 10,
      ready: 5,
      failed: 5,
      processing: 0,
      needsReview: 0,
      outdated: 0,
      missingMetadata: 0,
      unlinkedContent: 0,
      duplicates: 0,
      permissionIssues: 0,
    });
    const stale = computeKnowledgeHealth({
      total: 10,
      ready: 10,
      failed: 0,
      processing: 0,
      needsReview: 0,
      outdated: 5,
      missingMetadata: 0,
      unlinkedContent: 0,
      duplicates: 0,
      permissionIssues: 0,
    });
    expect(failed).toBeLessThan(stale);
  });

  it('stays within 0..100', () => {
    const worst = computeKnowledgeHealth({
      total: 10,
      ready: 0,
      failed: 10,
      processing: 0,
      needsReview: 10,
      outdated: 10,
      missingMetadata: 10,
      unlinkedContent: 10,
      duplicates: 10,
      permissionIssues: 10,
    });
    expect(worst).toBeGreaterThanOrEqual(0);
    expect(worst).toBeLessThanOrEqual(100);
  });
});
