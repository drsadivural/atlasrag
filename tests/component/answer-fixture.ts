import type { Citation, StructuredAnswer } from '@uxe/contracts';

/**
 * One realistic verified answer, shared by the component tests.
 *
 * It is deliberately the hardest real case: partial compliance, one requirement with no
 * evidence at all, one unverified citation and one conflict — the combination that the
 * three answer styles must all describe consistently.
 */

export function makeCitation(overrides: Partial<Citation> = {}): Citation {
  return {
    citationId: 'cit-governing-1',
    tenantId: 'org-1',
    sourceId: 'src-code',
    sourceVersionId: 'ver-code-3',
    sourceSha256: 'a'.repeat(64),
    documentTitle: 'UAE Fire and Life Safety Code',
    documentType: 'pdf',
    pageNumber: 214,
    sheetName: null,
    cellRange: null,
    slideNumber: null,
    shapeName: null,
    chapter: '6',
    section: '6.4',
    clause: '6.4.2',
    headingPath: ['Chapter 6', '6.4 Emergency lighting'],
    paragraphIndex: 2,
    charStart: 120,
    charEnd: 240,
    urlFragment: '#page=214',
    boundingBoxes: [{ page: 214, x: 0.1, y: 0.2, width: 0.8, height: 0.04 }],
    supportingExcerpt:
      'Emergency illumination shall provide an average illuminance of not less than 10 lux measured at the floor.',
    retrievalScore: 0.91,
    rerankScore: 0.88,
    entailment: 'supports',
    verified: true,
    verificationMethod: 'exact',
    effectiveDate: '2024-01-01T00:00:00.000Z',
    supersededBy: null,
    createdAt: '2026-08-01T09:00:00.000Z',
    ...overrides,
  };
}

export const CITATIONS: Citation[] = [
  makeCitation(),
  makeCitation({
    citationId: 'cit-project-1',
    sourceId: 'src-plan',
    sourceVersionId: 'ver-plan-1',
    documentTitle: 'Marina Tower Evacuation Plan',
    clause: null,
    section: null,
    chapter: null,
    pageNumber: 12,
    headingPath: ['Lighting design'],
    supportingExcerpt: 'The design illuminance at floor level along the egress route is 6 lux.',
    urlFragment: '#page=12',
  }),
  makeCitation({
    citationId: 'cit-governing-2',
    clause: '6.6.1',
    section: '6.6',
    pageNumber: 220,
    supportingExcerpt: 'Travel distance to an exit shall not exceed 45 m in sprinklered buildings.',
    urlFragment: '#page=220',
  }),
  makeCitation({
    citationId: 'cit-unverified',
    sourceId: 'src-plan',
    documentTitle: 'Marina Tower Evacuation Plan',
    pageNumber: 31,
    clause: null,
    supportingExcerpt: 'Signage is provided throughout the egress route.',
    verified: false,
    verificationMethod: 'failed',
    entailment: 'context',
    urlFragment: '#page=31',
  }),
];

export function makeAnswer(overrides: Partial<StructuredAnswer> = {}): StructuredAnswer {
  return {
    answerId: 'ans-1',
    task: 'check_compliance',
    decision: 'no',
    decisionQualifier: 'Partially compliant',
    headline: 'The evacuation plan does not meet two of four emergency egress requirements.',
    decisiveReason:
      'Clause 6.4.2 requires not less than 10 lux at floor level; the plan states 6 lux.',
    summary:
      'Two of the four requirements assessed are met. Emergency illumination falls below the required level, and no evidence addresses the exit sign luminance requirement.',
    scope: 'UAE Fire and Life Safety Code Chapter 6 against the Marina Tower Evacuation Plan v1.',
    documentsReviewed: [
      {
        sourceId: 'src-code',
        sourceVersionId: 'ver-code-3',
        title: 'UAE Fire and Life Safety Code',
        version: '3',
        role: 'governing',
        pages: 812,
      },
      {
        sourceId: 'src-plan',
        sourceVersionId: 'ver-plan-1',
        title: 'Marina Tower Evacuation Plan',
        version: '1',
        role: 'project',
        pages: 44,
      },
    ],
    assumptions: ['The building is fully sprinklered, as stated in the plan.'],
    keyFindings: [
      'Emergency illumination is 6 lux where 10 lux is required.',
      'Travel distance of 38 m is within the 45 m limit.',
    ],
    claims: [
      {
        claimId: 'clm-1',
        text: 'Emergency illumination is below the required level.',
        citationIds: ['cit-governing-1', 'cit-project-1'],
        supported: true,
        fromGeneralModel: false,
      },
      {
        claimId: 'clm-2',
        text: 'Travel distance complies.',
        citationIds: ['cit-governing-2'],
        supported: true,
        fromGeneralModel: false,
      },
    ],
    requirements: [
      {
        requirementId: 'req-1',
        reference: '6.4.2',
        title: 'Emergency illumination',
        obligationText:
          'Emergency illumination shall provide an average illuminance of not less than 10 lux measured at the floor.',
        modality: 'mandatory',
        sourceId: 'src-code',
        sourceVersionId: 'ver-code-3',
        citationId: 'cit-governing-1',
        exceptions: [],
        crossReferences: [],
      },
      {
        requirementId: 'req-2',
        reference: '6.6.1',
        title: 'Maximum travel distance',
        obligationText:
          'Travel distance to an exit shall not exceed 45 m in sprinklered buildings.',
        modality: 'mandatory',
        sourceId: 'src-code',
        sourceVersionId: 'ver-code-3',
        citationId: 'cit-governing-2',
        exceptions: [
          'Notwithstanding 6.6.1, travel distance may extend to 60 m with smoke control.',
        ],
        crossReferences: [],
      },
    ],
    findings: [
      {
        findingId: 'fin-1',
        requirementId: 'req-1',
        requirementReference: '6.4.2',
        requirementTitle: 'Emergency illumination',
        result: 'non_compliant',
        risk: 'high',
        finding:
          'Clause 6.4.2 requires not less than 10 lux; the plan states 6 lux at floor level.',
        projectEvidenceCitationIds: ['cit-project-1'],
        governingCitationIds: ['cit-governing-1'],
        missingEvidence: [],
        conflicts: [],
        recommendedAction:
          'Raise the design illuminance to at least 10 lux and reissue the lighting schedule.',
        confidence: 0.86,
      },
      {
        findingId: 'fin-2',
        requirementId: 'req-2',
        requirementReference: '6.6.1',
        requirementTitle: 'Maximum travel distance',
        result: 'compliant',
        risk: 'none',
        finding: 'The plan states a maximum travel distance of 38 m, within the 45 m limit.',
        projectEvidenceCitationIds: [],
        governingCitationIds: ['cit-governing-2'],
        missingEvidence: [],
        conflicts: [],
        recommendedAction: null,
        confidence: 0.79,
      },
      {
        findingId: 'fin-3',
        requirementId: 'req-3',
        requirementReference: '6.5.3',
        requirementTitle: 'Exit sign luminance',
        result: 'needs_evidence',
        risk: 'medium',
        finding: 'Nothing in the project documents states the luminance of the exit signage.',
        projectEvidenceCitationIds: [],
        governingCitationIds: [],
        missingEvidence: ['Exit sign luminance schedule'],
        conflicts: [],
        recommendedAction: 'Provide the exit sign luminance schedule for clause 6.5.3.',
        confidence: 0.4,
      },
      {
        findingId: 'fin-4',
        requirementId: 'req-4',
        requirementReference: '6.5.1',
        requirementTitle: 'Egress signage provision',
        result: 'needs_evidence',
        risk: 'low',
        finding:
          'The plan mentions signage, but the quoted passage could not be re-located in the stored source text.',
        projectEvidenceCitationIds: ['cit-unverified'],
        governingCitationIds: [],
        missingEvidence: [],
        conflicts: [],
        recommendedAction: 'Re-upload the signage section so the passage can be verified.',
        confidence: 0.31,
      },
    ],
    calculations: [
      {
        label: 'Illuminance shortfall',
        expression: '10 lux − 6 lux',
        value: '4 lux',
        citationIds: ['cit-governing-1', 'cit-project-1'],
      },
    ],
    conflicts: [
      {
        description: 'Section 4 states 10 lux while the lighting schedule states 6 lux.',
        citationIds: ['cit-project-1'],
      },
    ],
    missingEvidence: ['Exit sign luminance schedule'],
    uncertainties: ['The plan does not state whether the corridor is part of the protected route.'],
    followUpQuestion: 'Do you want the corrected lighting schedule generated as a DOCX?',
    recommendedActions: [
      {
        action: 'Raise the design illuminance to at least 10 lux.',
        priority: 'high',
        requirementIds: ['req-1'],
      },
      {
        action: 'Provide the exit sign luminance schedule.',
        priority: 'medium',
        requirementIds: ['req-3'],
      },
    ],
    riskLevel: 'high',
    coverage: {
      score: 0.75,
      citedPassages: 4,
      regulationsUsed: 1,
      projectDocumentsUsed: 1,
      verifiedCitations: 3,
      unverifiedCitations: 1,
      conflictingCitations: 1,
      claimsTotal: 4,
      claimsSupported: 3,
    },
    confidence: {
      evidenceCoverage: 0.75,
      retrievalQuality: 0.82,
      citationVerification: 0.75,
      sourceAuthority: 0.95,
      recency: 0.9,
      contradictionPenalty: 0.1,
      overall: 0.72,
    },
    citations: CITATIONS,
    usedGeneralModel: false,
    injectionWarnings: [],
    generatedAt: '2026-08-25T10:00:00.000Z',
    modelConfigurationId: 'mc-1',
    modelDescriptor: 'UXE deterministic extractive engine v1',
    ...overrides,
  };
}
