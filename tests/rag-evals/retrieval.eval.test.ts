import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantContext } from '@uxe/db';
import { retrieve, type SourceScope } from '@uxe/rag';
import {
  createHarness,
  registerOwner,
  truncateAll,
  type Harness,
  type RegisteredAccount,
} from '../integration/harness.js';
import { ask, uploadFixture } from '../integration/helpers.js';

/**
 * Retrieval and grounding evaluation.
 *
 * The gold set is small and hand-labelled against the two fixture documents, which is what
 * makes the expected passages checkable by a human reading this file. Every threshold is
 * asserted, so a regression fails the build rather than quietly degrading answers.
 */

interface GoldCase {
  question: string;
  /** A phrase that must appear in at least one retrieved passage. */
  expected: string;
  /** Where the answer lives, for the locator assertions. */
  clause: string | null;
}

const GOLD: GoldCase[] = [
  {
    question: 'What average illuminance must emergency lighting provide?',
    expected: '10 lux',
    clause: '6.4.2',
  },
  {
    question: 'What is the minimum clear width of an exit?',
    expected: '1.2 m',
    clause: '6.5.1',
  },
  {
    question: 'What is the maximum travel distance to an exit in a sprinklered building?',
    expected: '45 m',
    clause: '6.6.1',
  },
  {
    question: 'How long must emergency lighting stay on after power fails?',
    expected: 'minutes',
    clause: null,
  },
  {
    question: 'Which occupancies does the emergency lighting section apply to?',
    expected: 'assembly',
    clause: '6.4.1',
  },
];

const K = 5;

let harness: Harness;
let owner: RegisteredAccount;
const scope: SourceScope[] = [];
let tenant: TenantContext;

const latencies: number[] = [];

beforeAll(async () => {
  harness = await createHarness();
  await truncateAll(harness.db);
  harness.resetRateLimits();
  owner = await registerOwner(harness);

  const regulation = await uploadFixture(harness, owner.client, 'regulation-native.pdf', {
    title: 'UAE Fire and Life Safety Code',
  });
  const project = await uploadFixture(harness, owner.client, 'project-plan.pdf', {
    title: 'Marina Tower Evacuation Plan',
  });

  tenant = {
    organizationId: owner.organizationId,
    workspaceId: owner.workspaceId,
    userId: owner.userId,
    role: 'owner' as const,
    groupIds: [],
    traceId: 'rag-eval',
  };

  for (const [id, role] of [
    [regulation.sourceId, 'governing'],
    [project.sourceId, 'project'],
  ] as const) {
    const detail = await owner.client.get<{
      currentVersionId: string;
      title: string;
      currentVersion: string;
      pages: number | null;
      tags: string[];
      effectiveDate: string | null;
    }>(`/sources/${id}`);

    scope.push({
      sourceId: id,
      sourceVersionId: detail.body.currentVersionId,
      role,
      title: detail.body.title,
      version: detail.body.currentVersion,
      pages: detail.body.pages,
      effectiveDate: detail.body.effectiveDate ? new Date(detail.body.effectiveDate) : null,
      tags: detail.body.tags,
      promoted: true,
      superseded: false,
    });
  }
}, 600_000);

afterAll(async () => {
  await harness.close();
});

describe(`retrieval quality at K=${K}`, () => {
  it('achieves at least 80% Recall@5 on the gold set', async () => {
    let hits = 0;
    for (const item of GOLD) {
      const started = Date.now();
      const outcome = await retrieve(
        tenant,
        harness.deps.repos.retrieval,
        harness.deps.services.embeddings,
        item.question,
        scope,
        { finalLimit: K },
      );
      latencies.push(Date.now() - started);

      const found = outcome.candidates.some((c) =>
        c.content.toLowerCase().includes(item.expected.toLowerCase()),
      );
      if (found) hits += 1;
    }

    const recall = hits / GOLD.length;
    console.log(`Recall@${K}: ${(recall * 100).toFixed(1)}% (${hits}/${GOLD.length})`);
    expect(recall).toBeGreaterThanOrEqual(0.8);
  }, 120_000);

  it('ranks the right passage first often enough to be useful (nDCG@5 ≥ 0.7)', async () => {
    let total = 0;
    for (const item of GOLD) {
      const outcome = await retrieve(
        tenant,
        harness.deps.repos.retrieval,
        harness.deps.services.embeddings,
        item.question,
        scope,
        { finalLimit: K },
      );

      const rank = outcome.candidates.findIndex((c) =>
        c.content.toLowerCase().includes(item.expected.toLowerCase()),
      );
      // Binary relevance: DCG is 1/log2(rank+2), and the ideal is 1.
      total += rank === -1 ? 0 : 1 / Math.log2(rank + 2);
    }

    const ndcg = total / GOLD.length;
    console.log(`nDCG@${K}: ${ndcg.toFixed(3)}`);
    expect(ndcg).toBeGreaterThanOrEqual(0.7);
  }, 120_000);

  it('returns nothing at all for an empty scope, rather than falling back to everything', async () => {
    const outcome = await retrieve(
      tenant,
      harness.deps.repos.retrieval,
      harness.deps.services.embeddings,
      'What illuminance is required?',
      [],
      { finalLimit: K },
    );
    expect(outcome.candidates).toHaveLength(0);
  });

  it('keeps retrieval latency within the interactive budget', () => {
    const sorted = [...latencies].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    console.log(`Retrieval latency p50 ${p50}ms, p95 ${p95}ms over ${sorted.length} queries`);
    expect(p50).toBeLessThan(1500);
    expect(p95).toBeLessThan(4000);
  });
});

/*
 * Looking a clause up by its number.
 *
 * This is the most literal thing anybody does with a code, and it was the pipeline's worst
 * failure. Structure detection lifts "6.4.2" out of the heading into its own column and the
 * body below does not repeat it, so both text channels were searching for a string that was
 * not in the index: measured over the real 1,348-page corpus, a clause-number lookup found
 * its own clause 0% of the time at rank 1 and 14% anywhere in the top ten.
 *
 * Asserted at rank 1, because there is no partial credit here. Somebody who types a clause
 * number has told the system exactly what they want.
 */
describe('clause lookup', () => {
  const CLAUSES = ['6.4.2', '6.5.1', '6.6.1'];

  it('returns the clause asked for, first', async () => {
    for (const clause of CLAUSES) {
      const outcome = await retrieve(
        tenant,
        harness.deps.repos.retrieval,
        harness.deps.services.embeddings,
        `clause ${clause}`,
        scope,
        { finalLimit: K, maxPerSource: K },
      );

      expect(outcome.candidates.length, `no candidates for clause ${clause}`).toBeGreaterThan(0);
      expect(outcome.candidates[0]?.clause, `clause ${clause} was not ranked first`).toBe(clause);
    }
  }, 120_000);

  it('reaches the clause through the structured column, not the prose', async () => {
    const outcome = await retrieve(
      tenant,
      harness.deps.repos.retrieval,
      harness.deps.services.embeddings,
      'clause 6.4.2',
      scope,
      { finalLimit: K, maxPerSource: K },
    );

    // The channel exists and fired. Without it the lookup depends on the number happening
    // to survive into the body text, which across a real code it does not.
    expect(outcome.telemetry.locatorCandidates).toBeGreaterThan(0);
    expect(outcome.candidates[0]?.channels).toContain('locator');
  }, 120_000);

  it('costs nothing when the question names no clause', async () => {
    const outcome = await retrieve(
      tenant,
      harness.deps.repos.retrieval,
      harness.deps.services.embeddings,
      'What average illuminance must emergency lighting provide?',
      scope,
      { finalLimit: K },
    );
    expect(outcome.telemetry.locatorCandidates).toBe(0);
  }, 120_000);
});

describe('citation quality', () => {
  it('verifies every quoted excerpt against the stored page text', async () => {
    const consultation = await owner.client.post<{ id: string }>('/consultations', {
      title: 'Citation precision',
      taskMode: 'ask',
      sourceIds: scope.map((s) => s.sourceId),
    });

    let quoted = 0;
    let verified = 0;
    let locatorCorrect = 0;

    for (const item of GOLD.slice(0, 3)) {
      const result = await ask(owner.client, consultation.body.id, item.question);
      const answer = result.answer;
      if (!answer) continue;

      for (const citation of answer.citations) {
        quoted += 1;
        if (citation.verified) verified += 1;

        const opened = await owner.client.get<{
          citation: { supportingExcerpt: string };
          pageText: string;
          highlight: { start: number; end: number } | null;
        }>(`/citations/${citation.citationId}`);

        // The locator is correct only when the highlight offsets slice out exactly the
        // quotation the answer displayed.
        if (
          opened.status === 200 &&
          opened.body.highlight !== null &&
          opened.body.pageText.slice(opened.body.highlight.start, opened.body.highlight.end) ===
            opened.body.citation.supportingExcerpt
        ) {
          locatorCorrect += 1;
        }
      }
    }

    expect(quoted).toBeGreaterThan(0);
    const verificationRate = verified / quoted;
    const locatorAccuracy = locatorCorrect / quoted;
    console.log(
      `Quoted-text verification ${(verificationRate * 100).toFixed(1)}%, locator accuracy ${(locatorAccuracy * 100).toFixed(1)}% over ${quoted} citations`,
    );

    // Nothing unverified may ever be shown, so both are all-or-nothing.
    expect(verificationRate).toBe(1);
    expect(locatorAccuracy).toBe(1);
  }, 300_000);

  it('never states a compliant verdict without evidence behind it', async () => {
    const consultation = await owner.client.post<{ id: string }>('/consultations', {
      title: 'False compliance probe',
      taskMode: 'check_compliance',
      sourceIds: scope.map((s) => s.sourceId),
    });

    const result = await ask(
      owner.client,
      consultation.body.id,
      'Does the plan meet the requirement for exit sign luminance in candelas?',
      { taskMode: 'check_compliance' },
    );
    const answer = result.answer!;

    if (answer.decision === 'yes') {
      // A YES is only legitimate when a verified citation supports it.
      expect(answer.citations.filter((c) => c.verified).length).toBeGreaterThan(0);
    }
    expect(answer.citations.every((c) => c.verified)).toBe(true);
  }, 180_000);

  it('abstains on a question the corpus cannot answer', async () => {
    const consultation = await owner.client.post<{ id: string }>('/consultations', {
      title: 'Abstention probe',
      taskMode: 'ask',
      sourceIds: scope.map((s) => s.sourceId),
    });

    const result = await ask(
      owner.client,
      consultation.body.id,
      'What is the required compressive strength of the basement raft slab in MPa?',
    );
    const answer = result.answer!;

    expect(answer.decision).not.toBe('yes');
    expect(answer.headline.toLowerCase()).toMatch(/not|no |unable|cannot|does not|insufficient/);
  }, 180_000);
});

describe('requirement coverage', () => {
  it('assesses every mandatory requirement it extracted, or says why it could not', async () => {
    const consultation = await owner.client.post<{ id: string }>('/consultations', {
      title: 'Coverage review',
      taskMode: 'check_compliance',
      sourceIds: scope.map((s) => s.sourceId),
    });

    const review = await owner.client.post<{ job: { id: string } }>(
      `/consultations/${consultation.body.id}/reviews`,
      {
        projectSourceIds: scope.filter((s) => s.role === 'project').map((s) => s.sourceId),
        governingSourceIds: scope.filter((s) => s.role === 'governing').map((s) => s.sourceId),
        answerStyle: 'details',
        idempotencyKey: `coverage-${Date.now()}`,
      },
    );

    const deadline = Date.now() + 240_000;
    let status = 'queued';
    while (Date.now() < deadline && !['succeeded', 'failed'].includes(status)) {
      const job = await owner.client.get<{ status: string }>(`/jobs/${review.body.job.id}`);
      status = job.body.status;
      if (['succeeded', 'failed'].includes(status)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(status).toBe('succeeded');

    const detail = await owner.client.get<{
      messages: Array<{
        answer: {
          requirements: Array<{ requirementId: string }>;
          findings: Array<{ requirementId: string; result: string; missingEvidence: string[] }>;
        } | null;
      }>;
    }>(`/consultations/${consultation.body.id}`);
    const answer = detail.body.messages
      .map((m) => m.answer)
      .filter(Boolean)
      .at(-1)!;

    const assessed = new Set(answer.findings.map((f) => f.requirementId));
    const coverage =
      answer.requirements.length === 0 ? 1 : assessed.size / answer.requirements.length;
    console.log(
      `Requirement coverage ${(coverage * 100).toFixed(1)}% (${assessed.size}/${answer.requirements.length})`,
    );
    expect(coverage).toBe(1);

    // Anything not tested must name what is missing.
    for (const finding of answer.findings.filter((f) => f.result === 'needs_evidence')) {
      expect(finding.missingEvidence.length).toBeGreaterThan(0);
    }
  }, 600_000);
});
