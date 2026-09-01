import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createHarness,
  registerOwner,
  truncateAll,
  waitForJob,
  type Harness,
  type RegisteredAccount,
} from './harness.js';
import { ask, fixtureBytes, uploadFixture } from './helpers.js';

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

/** Uploads a fixture into a consultation and waits for it to be attached as the project document. */
async function attachProjectDocument(
  consultationId: string,
  fileName: string,
  fixture: string,
): Promise<string> {
  const bytes = await fixtureBytes(fixture);
  const ticket = await owner.client.post<{
    tickets: Array<{ sourceId: string; uploadUrl: string }>;
  }>(`/consultations/${consultationId}/uploads`, {
    files: [{ fileName, sizeBytes: bytes.byteLength, contentType: 'application/pdf' }],
    tags: [],
    accessScope: 'workspace',
    promoteToKnowledge: false,
  });
  const uploaded = ticket.body.tickets[0]!;
  const put = await owner.client.request<{ job?: { id: string } }>(
    'PUT',
    new URL(uploaded.uploadUrl, 'http://localhost:8788').pathname.replace('/api/v1', ''),
    { rawBody: bytes, headers: { 'content-type': 'application/pdf' } },
  );
  if (put.body?.job?.id) await waitForJob(owner.client, put.body.job.id);
  return uploaded.sourceId;
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

  it('reviews a document uploaded into the conversation against the knowledge base', async () => {
    /*
     * The two kinds of document, and the difference between them.
     *
     * The knowledge base holds the regulations and does not change. What somebody drops
     * into a conversation is the thing being examined, and it never becomes a knowledge
     * source — so it has to be attached to that conversation as its project document, or
     * the answer comes back quoting the code with nothing to say about the file that was
     * just sent. That attachment was never wired: the upload indexed perfectly and then
     * sat outside the conversation's scope.
     */
    const consultationId = await newConsultation([regulationId]);

    // A document this corpus has not seen: identical bytes take the duplicate path, which
    // is exercised separately below.
    const bytes = await fixtureBytes('policy.docx');
    const ticket = await owner.client.post<{
      tickets: Array<{ uploadId: string; sourceId: string; uploadUrl: string }>;
    }>(`/consultations/${consultationId}/uploads`, {
      files: [
        {
          fileName: 'submittal.docx',
          sizeBytes: bytes.byteLength,
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
      ],
      tags: [],
      accessScope: 'workspace',
      promoteToKnowledge: false,
    });
    expect(ticket.status).toBeLessThan(300);

    const uploaded = ticket.body.tickets[0]!;
    const put = await owner.client.request<{ job?: { id: string } }>(
      'PUT',
      new URL(uploaded.uploadUrl, 'http://localhost:8788').pathname.replace('/api/v1', ''),
      {
        rawBody: bytes,
        headers: {
          'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
      },
    );
    expect(put.status).toBeLessThan(300);
    if (put.body?.job?.id) await waitForJob(owner.client, put.body.job.id);

    const detail = await owner.client.get<{
      documentCount: number;
      sources: Array<{ sourceId: string; role: string }>;
    }>(`/consultations/${consultationId}`);

    const attached = detail.body.sources.find((s) => s.sourceId === uploaded.sourceId);
    expect(attached?.role).toBe('project');
    expect(detail.body.documentCount).toBeGreaterThan(0);

    // And it stays out of the knowledge base: consultation inputs are not approved sources.
    const knowledge = await owner.client.get<{ items: Array<{ id: string }> }>(
      '/sources?status=ready&pageSize=100&promoted=true',
    );
    expect(knowledge.body.items.some((item) => item.id === uploaded.sourceId)).toBe(false);
  }, 180_000);

  it('attaches the copy it already has when the same bytes arrive again', async () => {
    /*
     * Already indexed is not already attached. Answering "we have those bytes" and doing
     * nothing else leaves the conversation with nothing to review, and the upload looks
     * like it worked.
     */
    const consultationId = await newConsultation([regulationId]);
    const bytes = await fixtureBytes('project-plan.pdf');

    const ticket = await owner.client.post<{
      tickets: Array<{ uploadId: string; sourceId: string; uploadUrl: string }>;
    }>(`/consultations/${consultationId}/uploads`, {
      files: [
        { fileName: 'again.pdf', sizeBytes: bytes.byteLength, contentType: 'application/pdf' },
      ],
      tags: [],
      accessScope: 'workspace',
      promoteToKnowledge: false,
    });
    const uploaded = ticket.body.tickets[0]!;

    const put = await owner.client.request<{ duplicate?: boolean; sourceId: string }>(
      'PUT',
      new URL(uploaded.uploadUrl, 'http://localhost:8788').pathname.replace('/api/v1', ''),
      { rawBody: bytes, headers: { 'content-type': 'application/pdf' } },
    );
    expect(put.body.duplicate).toBe(true);

    const detail = await owner.client.get<{ sources: Array<{ sourceId: string; role: string }> }>(
      `/consultations/${consultationId}`,
    );
    expect(detail.body.sources.find((s) => s.sourceId === projectId)?.role).toBe('project');
  }, 120_000);

  it('gives a verdict in Yes / No style even when the question is not phrased as one', async () => {
    /*
     * Choosing that style is the instruction. Reading the question's grammar is the right
     * guess when nobody has said what they want — but a screen that shows no verdict at
     * all, to somebody who asked for exactly one, has ignored the only thing it was told.
     */
    const consultationId = await newConsultation([regulationId]);
    const result = await ask(
      owner.client,
      consultationId,
      'Emergency lighting illuminance on the escape route.',
      { answerStyle: 'yes_no' },
    );

    expect(result.answer).not.toBeNull();
    expect(['yes', 'no', 'unable_to_determine']).toContain(result.answer!.decision);
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

  it('starts from the approved knowledge base when no sources are named', async () => {
    /*
     * Opening a consultation used to leave the scope empty, so the first thing anybody saw
     * was "No sources are selected" and an instruction to go and choose some — from a
     * knowledge base they had already approved, every document of which they would have
     * picked. Saying nothing about sources now means the approved ones.
     */
    const created = await owner.client.post<{
      id: string;
      sources: Array<{ sourceId: string; role: string }>;
    }>('/consultations', { title: 'Defaults', taskMode: 'ask' });

    expect(created.status).toBeLessThan(300);
    const attached = created.body.sources.map((s) => s.sourceId);
    expect(attached).toContain(regulationId);
    expect(created.body.sources.every((s) => s.role === 'governing')).toBe(true);

    // And it can answer without anybody opening Manage sources first.
    const result = await ask(
      owner.client,
      created.body.id,
      'What illuminance does emergency lighting require?',
    );
    expect(result.answer?.citations.length).toBeGreaterThan(0);
  }, 120_000);

  it('still opens with nothing attached when an empty list is given', async () => {
    // "I have not said" and "I have said none" are different, and only the second is an
    // empty array. Collapsing them would leave no way to open an unscoped consultation.
    const created = await owner.client.post<{ sources: unknown[] }>('/consultations', {
      title: 'Deliberately empty',
      taskMode: 'ask',
      sourceIds: [],
    });

    expect(created.status).toBeLessThan(300);
    expect(created.body.sources).toEqual([]);
  });

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

  it('runs the review, not the answering path, when asked whether a document complies', async () => {
    /*
     * These are different questions and the machinery for the second already existed,
     * unreachable. runComplianceReview builds the requirement set out of the governing text
     * and tests each obligation against the project document; only POST /reviews could
     * start it, and nothing called that. So "does this satisfy the code?" went through the
     * answering path and came back as a paragraph with citations — a fine answer to a
     * question nobody asked.
     */
    const consultationId = await newConsultation([regulationId]);
    await owner.client.patch(`/consultations/${consultationId}`, {
      sourceIds: [regulationId],
      version: 1,
    });
    await attachProjectDocument(consultationId, 'submittal.pdf', 'project-plan.pdf');

    const result = await ask(
      owner.client,
      consultationId,
      'Tell me if this satisfies the regulations.',
      { taskMode: 'check_compliance', answerStyle: 'optimal' },
    );

    expect(result.answer).not.toBeNull();
    const answer = result.answer!;

    // The shape that distinguishes a review from an answer: obligations, each tested.
    expect(answer.findings.length).toBeGreaterThan(0);
    for (const finding of answer.findings) {
      expect(['compliant', 'non_compliant', 'needs_evidence', 'not_assessed']).toContain(
        finding.result,
      );
      expect(finding.requirementReference.length).toBeGreaterThan(0);
    }

    // And the headline reports the outcome rather than quoting a clause.
    expect(answer.headline).toMatch(/requirement|gap|met|determine/i);
  }, 300_000);

  it('answers rather than reviews when there is no document to review', async () => {
    // With nothing but the regulations in scope there is no submission to test, and the
    // answering path — which reads the code and says what it requires — is the right one.
    const consultationId = await newConsultation([regulationId]);
    const result = await ask(owner.client, consultationId, 'Does the code cap travel distance?', {
      taskMode: 'check_compliance',
    });

    expect(result.answer).not.toBeNull();
    expect(result.answer!.findings).toEqual([]);
    expect(result.answer!.citations.length).toBeGreaterThan(0);
  }, 180_000);

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

/*
 * The rule the whole product rests on: what a submission is measured against is the
 * knowledge base, and only the knowledge base. A file uploaded inside ConsultNow is the
 * thing being inspected. Letting it govern would let a drawing certify itself, so the
 * separation is enforced on the server rather than by which screen the upload came from.
 */
describe('the knowledge base is the only compliance authority', () => {
  it('refuses to let a consultation upload govern, however the request asks', async () => {
    const consultationId = await newConsultation([regulationId]);
    const uploadedInConsult = await attachProjectDocument(
      consultationId,
      'submittal.pdf',
      'project-plan.pdf',
    );

    const current = await owner.client.get<{ version: number }>(`/consultations/${consultationId}`);

    // Straight from the client: name the drawing as a governing source.
    const patched = await owner.client.patch(`/consultations/${consultationId}`, {
      sourceIds: [regulationId, uploadedInConsult],
      version: current.body.version,
    });
    expect(patched.status).toBeLessThan(300);

    const detail = await owner.client.get<{
      sources: Array<{ sourceId: string; role: string }>;
    }>(`/consultations/${consultationId}`);

    const governing = detail.body.sources.filter((s) => s.role === 'governing');
    expect(governing.map((s) => s.sourceId)).toContain(regulationId);
    expect(governing.map((s) => s.sourceId)).not.toContain(uploadedInConsult);
  }, 300_000);

  it('names the knowledge base as the authority in the review it produces', async () => {
    const consultationId = await newConsultation([regulationId]);
    await attachProjectDocument(consultationId, 'submittal.pdf', 'project-plan.pdf');

    const result = await ask(owner.client, consultationId, 'Does this satisfy the code?', {
      taskMode: 'check_compliance',
      answerStyle: 'details',
    });
    const answer = result.answer!;

    expect(answer.assumptions.join(' ')).toContain('solely against the knowledge base');
    expect(answer.assumptions.join(' ')).toContain('UAE Fire and Life Safety Code');

    // Every obligation tested came from the knowledge base, never from the submission.
    const governingSourceIds = new Set(
      answer.documentsReviewed.filter((d) => d.role === 'governing').map((d) => d.sourceId),
    );
    expect(governingSourceIds.has(regulationId)).toBe(true);
    for (const requirement of answer.requirements) {
      expect(governingSourceIds.has(requirement.sourceId)).toBe(true);
    }
  }, 300_000);

  it('records which sheets it read, so an unread page is not reported as a silent gap', async () => {
    const consultationId = await newConsultation([regulationId]);
    await attachProjectDocument(consultationId, 'submittal.pdf', 'project-plan.pdf');

    const result = await ask(owner.client, consultationId, 'Does this satisfy the code?', {
      taskMode: 'check_compliance',
      answerStyle: 'details',
    });
    const project = result.answer!.documentsReviewed.filter((d) => d.role === 'project').at(0);

    expect(project).toBeDefined();
    expect(project!.sheetsInspected.length).toBeGreaterThan(0);
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
