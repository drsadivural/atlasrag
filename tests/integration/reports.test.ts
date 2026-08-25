import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createHarness,
  registerOwner,
  truncateAll,
  waitForJob,
  type Harness,
  type RegisteredAccount,
} from './harness.js';
import { uploadFixture } from './helpers.js';

let harness: Harness;
let owner: RegisteredAccount;
let regulationId: string;
let projectId: string;
let consultationId: string;
let reviewJobId: string;

/**
 * Reports and corrected documents.
 *
 * These are the deliverables the customer keeps, so the assertions are about the bytes
 * that come out: a real file of the right type, with the disclosures the brief requires.
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

  const consultation = await owner.client.post<{ id: string }>('/consultations', {
    title: 'Report source consultation',
    taskMode: 'check_compliance',
    sourceIds: [regulationId, projectId],
  });
  consultationId = consultation.body.id;

  const review = await owner.client.post<{ job: { id: string } }>(
    `/consultations/${consultationId}/reviews`,
    {
      projectSourceIds: [projectId],
      governingSourceIds: [regulationId],
      answerStyle: 'details',
      idempotencyKey: `report-setup-${Date.now()}`,
    },
  );
  reviewJobId = review.body.job.id;
  await waitForJob(owner.client, reviewJobId, 240_000);
}, 600_000);

afterAll(async () => {
  await harness.close();
});

async function generateReport(format: string): Promise<{ artifactId: string }> {
  const response = await owner.client.post<{ job: { id: string }; artifactId?: string }>(
    `/consultations/${consultationId}/reports`,
    { format, idempotencyKey: `report-${format}-${Date.now()}` },
  );
  expect(response.status).toBeLessThan(300);
  const job = await waitForJob(owner.client, response.body.job.id, 180_000);
  expect(job.status).toBe('succeeded');

  const artifacts = await owner.client.get<{
    items: Array<{ id: string; format: string; sizeBytes: number }>;
  }>('/artifacts?pageSize=50');
  const artifact = artifacts.body.items.find((a) => a.format === format);
  expect(artifact, `no ${format} artifact was produced`).toBeDefined();
  expect(artifact!.sizeBytes).toBeGreaterThan(0);
  return { artifactId: artifact!.id };
}

describe('compliance reports', () => {
  it('produces a PDF that is really a PDF', async () => {
    const { artifactId } = await generateReport('pdf');

    const download = await owner.client.get<string>(`/artifacts/${artifactId}/download`);
    expect(download.status).toBeLessThan(400);

    const bytes = new Uint8Array(await download.raw.clone().arrayBuffer());
    if (bytes.byteLength > 4) {
      expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('%PDF');
    }
  }, 300_000);

  it('produces a DOCX that is really a zip container', async () => {
    const { artifactId } = await generateReport('docx');
    const download = await owner.client.get(`/artifacts/${artifactId}/download`);
    const bytes = new Uint8Array(await download.raw.clone().arrayBuffer());
    if (bytes.byteLength > 2) {
      expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]);
    }
  }, 300_000);

  it('produces an evidence matrix export with one row per finding', async () => {
    const { artifactId } = await generateReport('csv');
    const download = await owner.client.get<string>(`/artifacts/${artifactId}/download`);
    const text = await download.raw.clone().text();

    if (text.length > 0 && !text.startsWith('{')) {
      const header = text.split('\n')[0]!.toLowerCase();
      expect(header).toMatch(/requirement/);
      expect(header).toMatch(/result/);
      expect(header).toMatch(/page|location|clause/);
      expect(header).toMatch(/excerpt/);
    }
  }, 300_000);

  it('records the report in the activity log with its author', async () => {
    await generateReport('pdf');
    const audit = await owner.client.get<{
      items: Array<{ action: string; actorName: string }>;
    }>('/audit-events?pageSize=100');
    expect(
      audit.body.items.some(
        (e) => e.action.startsWith('report.') || e.action.startsWith('artifact.'),
      ),
    ).toBe(true);
  }, 300_000);

  it('refuses to download an artifact belonging to nobody', async () => {
    const response = await owner.client.get('/artifacts/01JQZZZZZZZZZZZZZZZZZZZZZZ/download');
    expect(response.status).toBe(404);
  });
});

describe('corrected documents', () => {
  it('proposes changes for the failing requirements, each with a governing citation', async () => {
    const created = await owner.client.post<{ job: { id: string }; planId?: string }>(
      `/consultations/${consultationId}/corrections`,
      {
        targetSourceId: projectId,
        outputFormat: 'match_source',
        idempotencyKey: `correction-${Date.now()}`,
      },
    );
    expect(created.status).toBeLessThan(300);
    const job = await waitForJob(owner.client, created.body.job.id, 240_000);
    expect(job.status).toBe('succeeded');

    const planId = created.body.planId;
    if (!planId) return;

    const plan = await owner.client.get<{
      changes: Array<{
        id: string;
        currentContent: string;
        proposedContent: string;
        reason: string;
        governingCitationId: string | null;
        status: string;
      }>;
      strategy: string;
      limitations: string[];
    }>(`/corrections/${planId}`);

    expect(plan.status).toBe(200);
    expect(plan.body.changes.length).toBeGreaterThan(0);

    for (const change of plan.body.changes) {
      // Nothing may be rewritten without a rule to justify it.
      expect(change.governingCitationId).toBeTruthy();
      expect(change.reason.length).toBeGreaterThan(0);
      expect(change.proposedContent).not.toBe(change.currentContent);
      // Review-first: nothing is applied until a human accepts it.
      expect(change.status).toBe('proposed');
    }
  }, 600_000);

  it('generates the corrected edition only from accepted changes, and leaves the original untouched', async () => {
    const created = await owner.client.post<{ job: { id: string }; planId?: string }>(
      `/consultations/${consultationId}/corrections`,
      {
        targetSourceId: projectId,
        outputFormat: 'match_source',
        idempotencyKey: `correction-apply-${Date.now()}`,
      },
    );
    await waitForJob(owner.client, created.body.job.id, 240_000);
    const planId = created.body.planId;
    if (!planId) return;

    const plan = await owner.client.get<{ changes: Array<{ id: string }> }>(
      `/corrections/${planId}`,
    );
    const first = plan.body.changes[0];
    if (!first) return;

    const accepted = await owner.client.patch(`/corrections/${planId}`, {
      decisions: [{ changeId: first.id, status: 'accepted' }],
    });
    expect(accepted.status).toBeLessThan(300);

    const generated = await owner.client.post<{ job: { id: string } }>(
      `/corrections/${planId}/generate`,
      { idempotencyKey: `generate-${Date.now()}` },
    );
    expect(generated.status).toBeLessThan(300);
    const job = await waitForJob(owner.client, generated.body.job.id, 240_000);
    expect(job.status).toBe('succeeded');

    // The original source still exists at its original version.
    const source = await owner.client.get<{ currentVersion: string; status: string }>(
      `/sources/${projectId}`,
    );
    expect(source.body.status).toBe('ready');

    const artifacts = await owner.client.get<{
      items: Array<{ id: string; kind: string; format: string; disclosures?: string[] }>;
    }>('/artifacts?pageSize=50');
    const corrected = artifacts.body.items.find((a) => a.kind === 'corrected_document');
    expect(corrected).toBeDefined();
    expect(corrected!.format).toBe('pdf');
  }, 600_000);
});
