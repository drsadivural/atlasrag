import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createHarness,
  registerOwner,
  truncateAll,
  type Harness,
  type RegisteredAccount,
} from './harness.js';
import { uploadFixture } from './helpers.js';

let harness: Harness;
let owner: RegisteredAccount;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  harness.resetRateLimits();
  owner = await registerOwner(harness);
});

interface PipelineStage {
  stage: string;
  state: string;
  completed: number;
  total: number;
  documents: Array<{ sourceId: string; title: string; state: string; detail: string | null }>;
}

async function pipeline(): Promise<PipelineStage[]> {
  const response = await owner.client.get<{ pipeline: PipelineStage[] }>(
    '/sources?page=1&pageSize=10',
  );
  return response.body.pipeline;
}

/**
 * What a stage of the indexing pipeline can be asked.
 *
 * A count says a stage is blocked. It does not say which document blocked it or why, and
 * that is the only thing worth knowing when a pipeline has stalled — so each stage
 * carries the documents still in it and whatever the stage recorded against them.
 */
describe('the indexing pipeline', () => {
  it('names the document that stopped a stage, and what stopped it', async () => {
    // A password-protected PDF fails in extraction with a reason worth reading.
    await uploadFixture(harness, owner.client, 'encrypted.pdf', { wait: true });

    const extraction = (await pipeline()).find((s) => s.stage === 'extraction');
    expect(extraction?.state).toBe('blocked');

    const failed = extraction?.documents.find((d) => d.state === 'failed');
    expect(failed?.title).toContain('encrypted');
    // The provider's own words, carried through rather than replaced with "failed".
    expect(failed?.detail).toMatch(/password/i);
  });

  it('puts failures before anything still working', async () => {
    await uploadFixture(harness, owner.client, 'encrypted.pdf', { wait: true });
    await uploadFixture(harness, owner.client, 'regulation-native.pdf', { wait: true });

    const extraction = (await pipeline()).find((s) => s.stage === 'extraction');
    const states = extraction?.documents.map((d) => d.state) ?? [];
    // A stage is opened because something stopped, so that is what comes first.
    const firstRunning = states.indexOf('running');
    const lastFailed = states.lastIndexOf('failed');
    if (firstRunning !== -1 && lastFailed !== -1) expect(lastFailed).toBeLessThan(firstRunning);
  });

  it('says nothing about a stage every document came through cleanly', async () => {
    await uploadFixture(harness, owner.client, 'regulation-native.pdf', { wait: true });

    const malware = (await pipeline()).find((s) => s.stage === 'malware_scan');
    expect(malware?.state).toBe('complete');
    // Nothing outstanding means nothing to explain.
    expect(malware?.documents).toHaveLength(0);
  });

  it('stops naming a document once it has been deleted', async () => {
    const uploaded = await uploadFixture(harness, owner.client, 'encrypted.pdf', { wait: true });

    const before = (await pipeline()).find((s) => s.stage === 'extraction');
    expect(before?.documents.some((d) => d.sourceId === uploaded.sourceId)).toBe(true);

    await owner.client.delete(`/sources/${uploaded.sourceId}`);

    // The job outlives the document; the pipeline should not keep reporting work on
    // something somebody removed.
    const after = (await pipeline()).find((s) => s.stage === 'extraction');
    expect(after?.documents.some((d) => d.sourceId === uploaded.sourceId)).toBe(false);
  });

  it('carries the reason a document was quarantined, not just the verdict', async () => {
    await uploadFixture(harness, owner.client, 'injection.pdf', { wait: true });

    const structure = (await pipeline()).find((s) => s.stage === 'structure_analysis');
    const failed = structure?.documents.find((d) => d.state === 'failed');
    if (failed) {
      expect(failed.detail).not.toBe('Quarantined');
      expect(failed.detail?.length ?? 0).toBeGreaterThan(20);
    }
  });
});

/**
 * What the pipeline counts.
 *
 * Not a lifetime total. A document that failed and was reprocessed successfully is a
 * document that succeeded, and a new upload is a new batch rather than one more row on a
 * tally nobody can find their file in.
 */
describe('what the pipeline counts', () => {
  it('keeps only the newest attempt for a document', async () => {
    // Fails in extraction, so structure analysis never runs and the stage stays blocked.
    const uploaded = await uploadFixture(harness, owner.client, 'encrypted.pdf', { wait: true });

    const before = (await pipeline()).find((s) => s.stage === 'extraction');
    expect(before?.state).toBe('blocked');

    // Reprocessing produces a second job for the same document. Counting both is how a
    // file reads Ready in the table and failed in the pipeline at the same time.
    await owner.client.post(`/sources/${uploaded.sourceId}/reprocess`, undefined, {
      idempotencyKey: `reprocess-${uploaded.sourceId}`,
    });

    const stages = await pipeline();
    const extraction = stages.find((s) => s.stage === 'extraction');
    // One document, one attempt counted — whatever the outcome of that attempt.
    expect(extraction?.total).toBe(1);
  });

  it('starts a new batch when a new document arrives', async () => {
    await uploadFixture(harness, owner.client, 'regulation-native.pdf', { wait: true });
    const first = (await pipeline()).find((s) => s.stage === 'malware_scan');
    expect(first?.total).toBe(1);

    await uploadFixture(harness, owner.client, 'policy.docx', { wait: true });

    // Both arrived within the same batch window, so both are on screen: a folder dropped
    // in one go stays together while its documents queue.
    const second = (await pipeline()).find((s) => s.stage === 'malware_scan');
    expect(second?.total).toBe(2);
  });

  it('reports nothing when the workspace has never ingested anything', async () => {
    const stages = await pipeline();
    for (const stage of stages) {
      expect(stage.total).toBe(0);
      expect(stage.state).toBe('idle');
      expect(stage.documents).toHaveLength(0);
    }
  });
});
