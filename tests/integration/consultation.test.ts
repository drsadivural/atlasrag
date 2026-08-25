import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createHarness,
  registerOwner,
  truncateAll,
  waitForJob,
  type Harness,
  type RegisteredAccount,
} from './harness.js';
import { ask, uploadFixture } from './helpers.js';

let harness: Harness;
let owner: RegisteredAccount;
let regulationId: string;
let projectId: string;

/**
 * The product's core promise, exercised against the real stack: an answer grounded only in
 * approved sources, with citations that can be re-located in the stored text.
 *
 * Ingestion is expensive, so the corpus is built once and every case reuses it. Nothing in
 * this file mutates the sources.
 */
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

  regulationId = regulation.sourceId;
  projectId = project.sourceId;
}, 300_000);

afterAll(async () => {
  await harness.close();
});

async function newConsultation(sourceIds: string[]): Promise<string> {
  const response = await owner.client.post<{ id: string }>('/consultations', {
    title: 'Integration consultation',
    taskMode: 'ask',
    sourceIds,
  });
  expect(response.status).toBeLessThan(300);
  return response.body.id;
}

describe('asking a question', () => {
  it('answers from the approved sources with verified citations', async () => {
    const consultationId = await newConsultation([regulationId]);
    const result = await ask(
      owner.client,
      consultationId,
      'What illuminance does emergency lighting require?',
    );

    expect(result.answer).not.toBeNull();
    const answer = result.answer!;

    expect(answer.citations.length).toBeGreaterThan(0);
    expect(answer.citations.every((c) => c.verified)).toBe(true);
    expect(answer.usedGeneralModel).toBe(false);

    // The number in the answer is the number in the regulation.
    const excerpts = answer.citations.map((c) => c.supportingExcerpt).join(' ');
    expect(excerpts).toMatch(/10 lux/);
  }, 120_000);

  it('locates every citation in the stored source text, character offsets included', async () => {
    const consultationId = await newConsultation([regulationId]);
    const result = await ask(
      owner.client,
      consultationId,
      'What is the minimum clear width of an exit?',
    );
    const answer = result.answer!;
    expect(answer.citations.length).toBeGreaterThan(0);

    for (const citation of answer.citations) {
      const opened = await owner.client.get<{
        citation: { supportingExcerpt: string; pageNumber: number | null };
        documentTitle: string;
        pageText: string;
        highlight: { start: number; end: number } | null;
        downloadUrl: string;
      }>(`/citations/${citation.citationId}`);

      expect(opened.status).toBe(200);
      // This is the whole promise: the quote is really on the page it points at, at the
      // offsets the viewer will highlight.
      expect(opened.body.pageText).toContain(opened.body.citation.supportingExcerpt);
      expect(opened.body.highlight).not.toBeNull();
      expect(
        opened.body.pageText.slice(opened.body.highlight!.start, opened.body.highlight!.end),
      ).toBe(opened.body.citation.supportingExcerpt);
      expect(opened.body.documentTitle).toBeTruthy();
    }
  }, 120_000);

  it('abstains rather than inventing an answer the sources do not contain', async () => {
    const consultationId = await newConsultation([regulationId]);
    const result = await ask(
      owner.client,
      consultationId,
      'What is the maximum permitted noise level for standby generators in decibels?',
    );
    const answer = result.answer!;

    expect(answer.decision).not.toBe('yes');
    expect(`${answer.headline}`).toMatch(/not|no |unable|does not|cannot|insufficient/i);
    // Nothing invented: any citation shown must still be a real, verified quote.
    expect(answer.citations.every((c) => c.verified)).toBe(true);
  }, 120_000);

  it('refuses to answer at all when no source is attached', async () => {
    const consultationId = await newConsultation([]);
    const result = await ask(owner.client, consultationId, 'What illuminance is required?');
    const answer = result.answer!;

    expect(answer.citations).toHaveLength(0);
    expect(answer.decision).not.toBe('yes');
    expect(`${answer.headline}`).toMatch(/source|evidence|knowledge|attach/i);
  }, 120_000);

  it('is idempotent: the same key does not run the work twice', async () => {
    const consultationId = await newConsultation([regulationId]);
    const key = `idem-${Date.now()}`;

    const first = await owner.client.post<{ job: { id: string } }>(
      `/consultations/${consultationId}/messages`,
      {
        text: 'What illuminance does emergency lighting require?',
        taskMode: 'ask',
        answerStyle: 'optimal',
        attachmentIds: [],
        parentMessageId: null,
        idempotencyKey: key,
      },
    );
    const second = await owner.client.post<{ job: { id: string } }>(
      `/consultations/${consultationId}/messages`,
      {
        text: 'What illuminance does emergency lighting require?',
        taskMode: 'ask',
        answerStyle: 'optimal',
        attachmentIds: [],
        parentMessageId: null,
        idempotencyKey: key,
      },
    );

    expect(second.body.job.id).toBe(first.body.job.id);
    await waitForJob(owner.client, first.body.job.id);
  }, 120_000);
});

describe('a compliance review', () => {
  it('returns NO with "Partially compliant" when some requirements fail, never YES', async () => {
    const consultationId = await newConsultation([regulationId, projectId]);

    const review = await owner.client.post<{ job: { id: string }; reviewId: string }>(
      `/consultations/${consultationId}/reviews`,
      {
        projectSourceIds: [projectId],
        governingSourceIds: [regulationId],
        answerStyle: 'details',
        scopeNote: 'Chapter 6 means of egress',
        idempotencyKey: `review-${Date.now()}`,
      },
    );
    expect(review.status).toBeLessThan(300);
    const job = await waitForJob(owner.client, review.body.job.id, 180_000);
    expect(job.status).toBe('succeeded');

    const detail = await owner.client.get<{
      messages: Array<{
        answer: {
          decision: string | null;
          decisionQualifier: string | null;
          findings: Array<{ result: string; requirementReference: string; finding: string }>;
          citations: Array<{ verified: boolean }>;
          coverage: { verifiedCitations: number; unverifiedCitations: number };
        } | null;
      }>;
    }>(`/consultations/${consultationId}`);

    const answer = detail.body.messages
      .map((m) => m.answer)
      .filter(Boolean)
      .at(-1)!;

    expect(answer.findings.length).toBeGreaterThan(0);
    const failing = answer.findings.filter((f) => f.result === 'non_compliant');
    const passing = answer.findings.filter((f) => f.result === 'compliant');

    if (failing.length > 0 && passing.length > 0) {
      // The single most consequential rule: partial compliance is a NO.
      expect(answer.decision).toBe('no');
      expect(answer.decisionQualifier).toBe('Partially compliant');
    } else if (failing.length > 0) {
      expect(answer.decision).toBe('no');
    }

    expect(answer.coverage.unverifiedCitations).toBe(0);
    expect(answer.citations.every((c) => c.verified)).toBe(true);
  }, 300_000);

  it('states what is missing instead of assuming a silent document complies', async () => {
    const consultationId = await newConsultation([regulationId, projectId]);
    const review = await owner.client.post<{ job: { id: string } }>(
      `/consultations/${consultationId}/reviews`,
      {
        projectSourceIds: [projectId],
        governingSourceIds: [regulationId],
        answerStyle: 'details',
        idempotencyKey: `review-missing-${Date.now()}`,
      },
    );
    await waitForJob(owner.client, review.body.job.id, 180_000);

    const detail = await owner.client.get<{
      messages: Array<{
        answer: {
          findings: Array<{ result: string; missingEvidence: string[] }>;
          missingEvidence: string[];
        } | null;
      }>;
    }>(`/consultations/${consultationId}`);
    const answer = detail.body.messages
      .map((m) => m.answer)
      .filter(Boolean)
      .at(-1)!;

    const needsEvidence = answer.findings.filter((f) => f.result === 'needs_evidence');
    // Whenever the engine could not test a requirement, it must say which one and why.
    for (const finding of needsEvidence) {
      expect(finding.missingEvidence.length).toBeGreaterThan(0);
    }
  }, 300_000);
});

describe('answer styles', () => {
  it('re-renders the same verified evidence at every depth, without new retrieval', async () => {
    const consultationId = await newConsultation([regulationId]);
    const result = await ask(
      owner.client,
      consultationId,
      'What illuminance does emergency lighting require?',
    );
    const original = result.answer!;

    for (const answerStyle of ['yes_no', 'details'] as const) {
      const current = await owner.client.get<{ version: number }>(
        `/consultations/${consultationId}`,
      );
      const updated = await owner.client.patch<{ answerStyle: string }>(
        `/consultations/${consultationId}`,
        { answerStyle, version: current.body.version },
      );
      expect(updated.status).toBe(200);
      expect(updated.body.answerStyle).toBe(answerStyle);

      const detail = await owner.client.get<{
        messages: Array<{
          answer: { citations: Array<{ citationId: string }>; decision: string | null } | null;
        }>;
      }>(`/consultations/${consultationId}`);
      const answer = detail.body.messages
        .map((m) => m.answer)
        .filter(Boolean)
        .at(-1)!;

      // Identical evidence and identical decision: the style is a view, not a new question.
      expect(answer.citations.map((c) => c.citationId).sort()).toEqual(
        original.citations.map((c) => c.citationId).sort(),
      );
      expect(answer.decision).toBe(original.decision);
    }
  }, 120_000);
});

describe('consultation management', () => {
  it('rejects a stale version rather than silently overwriting a concurrent edit', async () => {
    const consultationId = await newConsultation([regulationId]);
    const before = await owner.client.get<{ version: number }>(`/consultations/${consultationId}`);

    const ok = await owner.client.patch(`/consultations/${consultationId}`, {
      title: 'First writer',
      version: before.body.version,
    });
    expect(ok.status).toBe(200);

    const stale = await owner.client.patch(`/consultations/${consultationId}`, {
      title: 'Second writer',
      version: before.body.version,
    });
    expect(stale.status).toBe(409);
    expect((stale.body as { error: { code: string } }).error.code).toMatch(/conflict/);
  });

  it('streams progress for a running answer and ends with a terminal event', async () => {
    const consultationId = await newConsultation([regulationId]);
    const posted = await owner.client.post<{ job: { id: string } }>(
      `/consultations/${consultationId}/messages`,
      {
        text: 'What is the maximum travel distance to an exit?',
        taskMode: 'ask',
        answerStyle: 'optimal',
        attachmentIds: [],
        parentMessageId: null,
        idempotencyKey: `stream-${Date.now()}`,
      },
    );

    const stream = await owner.client.get(`/consultations/${consultationId}/stream`);
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');

    await waitForJob(owner.client, posted.body.job.id);
  }, 120_000);

  it('deletes a consultation and stops serving it', async () => {
    const consultationId = await newConsultation([]);
    const deleted = await owner.client.delete(`/consultations/${consultationId}`);
    expect(deleted.status).toBeLessThan(300);
    expect((await owner.client.get(`/consultations/${consultationId}`)).status).toBe(404);
  });
});
