import { describe, expect, it } from 'vitest';
import type { Citation, Claim } from '@uxe/contracts';
import { assembleAnswer } from '../../packages/rag/src/answer.js';

/**
 * What an answer is allowed to say about work that was not done.
 *
 * Asking a compliance question inside a conversation runs the answering path rather than
 * the full review, so it reaches assembly with no findings at all. Everything here is
 * about that case, because it is the one where a helpful-sounding sentence becomes a
 * false statement about somebody's building.
 */

let counter = 0;
const idFactory = () => `id-${(counter += 1)}`;

function citation(overrides: Partial<Citation> = {}): Citation {
  return {
    citationId: idFactory(),
    sourceId: 'src-code',
    sourceVersionId: 'ver-1',
    documentTitle: 'UAE Fire and Life Safety Code',
    chapter: 'Ch. 3',
    section: null,
    clause: null,
    pageNumber: 748,
    charStart: 0,
    charEnd: 40,
    supportingExcerpt: 'The capacity of the fire pump set shall be sufficient.',
    entailment: 'supports',
    verified: true,
    boundingBoxes: [],
    ...overrides,
  } as Citation;
}

function claim(text: string, citationIds: string[]): Claim {
  return { claimId: idFactory(), text, citationIds, supported: true, fromGeneralModel: false };
}

const BASE = {
  answerId: 'ans-1',
  question: 'Does this submittal satisfy the fire pump capacity requirements?',
  coverage: { regulationCoverage: 1, projectCoverage: 1, overall: 1 },
  confidence: { overall: 0.9, retrieval: 0.9, agreement: 0.9, recency: 0.9, authority: 0.9 },
  documentsReviewed: [],
  modelDescriptor: 'test:test + test:test',
} as unknown as Parameters<typeof assembleAnswer>[0];

describe('a compliance answer with nothing reviewed', () => {
  it('does not announce that every requirement is met', () => {
    /*
     * Zero of zero is not a pass. The headline used to end at "All reviewed requirements
     * are met" whenever no requirement failed — including when none had been tested, which
     * is exactly the state an in-conversation compliance question arrives in.
     */
    const c = citation();
    const answer = assembleAnswer({
      ...BASE,
      task: 'check_compliance',
      citations: [c],
      claims: [claim('The code sets a minimum pump capacity.', [c.citationId])],
      decision: 'no',
    });

    expect(answer.headline).not.toMatch(/all .*requirements are met/i);
    expect(answer.headline.length).toBeGreaterThan(0);
  });

  it('heads a decided question with the question, not a clause of the code', () => {
    /*
     * The verdict is shown above the headline, so the headline says what was decided.
     * Falling back to the first supported claim put a sentence of the regulation where the
     * answer belonged — which is what somebody asking "does this comply?" was reading.
     */
    const c = citation();
    const answer = assembleAnswer({
      ...BASE,
      task: 'check_compliance',
      citations: [c],
      claims: [claim('The capacity of the fire pump set shall be sufficient.', [c.citationId])],
      decision: 'no',
    });

    expect(answer.headline).toBe(
      'Does this submittal satisfy the fire pump capacity requirements?',
    );
  });

  it('still says what the evidence was, rather than nothing at all', () => {
    const c = citation();
    const answer = assembleAnswer({
      ...BASE,
      task: 'check_compliance',
      citations: [c],
      claims: [claim('The code sets a minimum pump capacity.', [c.citationId])],
      decision: 'no',
    });

    // A verdict with a blank reason is a verdict the reader cannot check.
    expect(answer.decisiveReason).toBeTruthy();
    expect(answer.decisiveReason).toContain('UAE Fire and Life Safety Code');
  });

  it('names the reader’s own document as well as the regulation', () => {
    const rule = citation();
    const submittal = citation({
      sourceId: 'src-project',
      documentTitle: 'Pump submittal',
      supportingExcerpt: 'Pump set rated at 4.2 bar at the most remote landing valve.',
      pageNumber: 3,
    });

    const answer = assembleAnswer({
      ...BASE,
      task: 'check_compliance',
      citations: [rule, submittal],
      claims: [claim('The submittal states a rated pressure.', [rule.citationId])],
      decision: 'no',
    });

    // Quoting only the regulation answers half the question that was asked.
    expect(answer.decisiveReason).toContain('UAE Fire and Life Safety Code');
    expect(answer.decisiveReason).toContain('Pump submittal');
  });
});

describe('a compliance answer with requirements actually tested', () => {
  it('reports the count it reviewed', () => {
    const c = citation();
    const answer = assembleAnswer({
      ...BASE,
      task: 'check_compliance',
      citations: [c],
      claims: [],
      decision: 'yes',
      findings: [
        {
          findingId: 'f-1',
          requirementId: 'r-1',
          requirementReference: 'Ch. 3 §1',
          result: 'compliant',
          finding: 'Rated pressure exceeds the minimum.',
          citationIds: [c.citationId],
          severity: 'none',
          recommendedAction: null,
        },
      ] as never,
    });

    expect(answer.headline).toBe('All 1 reviewed requirements are met');
  });
});
