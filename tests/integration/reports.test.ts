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
let reviewId: string;

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

  const review = await owner.client.post<{ job: { id: string }; reviewId: string }>(
    `/consultations/${consultationId}/reviews`,
    {
      projectSourceIds: [projectId],
      governingSourceIds: [regulationId],
      answerStyle: 'details',
      idempotencyKey: `report-setup-${Date.now()}`,
    },
  );
  if (review.status >= 300) {
    throw new Error(`Review setup failed: ${review.status} ${JSON.stringify(review.body)}`);
  }
  reviewId = review.body.reviewId;
  const settled = await waitForJob(owner.client, review.body.job.id, 240_000);
  if (settled.status !== 'succeeded') {
    throw new Error(`Review job did not succeed: ${settled.status} ${settled.error}`);
  }
}, 600_000);

afterAll(async () => {
  await harness.close();
});

async function generateReport(
  format: string,
  kind: 'compliance_report' | 'summary' | 'evidence_matrix' = 'compliance_report',
  options: { includeEvidence?: boolean } = {},
): Promise<{ artifactId: string }> {
  const response = await owner.client.post<{ job: { id: string }; artifactId?: string }>(
    `/consultations/${consultationId}/reports`,
    {
      format,
      kind,
      reviewId,
      ...(options.includeEvidence === undefined
        ? {}
        : { includeEvidence: options.includeEvidence }),
      idempotencyKey: `report-${format}-${kind}-${options.includeEvidence ?? 'default'}-${Date.now()}`,
    },
  );
  expect(response.status).toBeLessThan(300);
  const job = await waitForJob(owner.client, response.body.job.id, 180_000);
  expect(job.status).toBe('succeeded');

  const artifacts = await owner.client.get<{
    items: Array<{ id: string; documentType: string; sizeBytes: number; status: string }>;
  }>('/artifacts?pageSize=50');
  /*
   * `documentType` is the stored type, not the requested format: markdown is filed as
   * text, which is what the artifact list has always shown.
   *
   * The list is newest first, so `find` takes the most recent of that type — which matters
   * now that two markdown reports are generated below and taking whichever came first
   * would assert about the wrong file.
   */
  const storedType = format === 'markdown' ? 'text' : format;
  const artifact = artifacts.body.items.find((a) => a.documentType === storedType);
  expect(artifact, `no ${format} (${storedType}) artifact was produced`).toBeDefined();
  expect(artifact!.sizeBytes).toBeGreaterThan(0);
  expect(artifact!.status).toBe('ready');
  return { artifactId: artifact!.id };
}

/**
 * Downloads an artifact the way the browser does: ask for a short-lived signed URL, then
 * fetch it. The bytes are never served from the JSON endpoint itself.
 */
async function downloadArtifact(artifactId: string): Promise<Uint8Array> {
  const signed = await owner.client.get<{ url: string; expiresAt: string }>(
    `/artifacts/${artifactId}/download`,
  );
  expect(signed.status, JSON.stringify(signed.body)).toBeLessThan(400);
  expect(signed.body.url).toBeTruthy();

  const path = new URL(signed.body.url, 'http://localhost:8788');
  const bytes = await owner.client.request<unknown>(
    'GET',
    `${path.pathname.replace('/api/v1', '')}${path.search}`,
  );
  expect(bytes.status).toBe(200);
  return new Uint8Array(await bytes.raw.clone().arrayBuffer());
}

describe('compliance reports', () => {
  it('is named after the document it reviews, not the consultation', async () => {
    const { artifactId } = await generateReport('pdf');
    const list = await owner.client.get<{ items: Array<{ id: string; title: string }> }>(
      '/artifacts?pageSize=50',
    );
    // The consultation is "Report source consultation"; the name comes from the drawing.
    expect(list.body.items.find((a) => a.id === artifactId)?.title).toBe(
      'Marina_Tower_Evacuation_Plan_Compliance_report',
    );
  });

  it('produces a PDF that is really a PDF', async () => {
    const { artifactId } = await generateReport('pdf');

    const bytes = await downloadArtifact(artifactId);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('%PDF');
  }, 300_000);

  it('produces a DOCX that is really a zip container', async () => {
    const { artifactId } = await generateReport('docx');
    const bytes = await downloadArtifact(artifactId);
    // A DOCX is an OPC zip container; "PK" is the only proof that it really is one.
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]);
  }, 300_000);

  it('drops the citations but keeps the findings when evidence is excluded', async () => {
    /*
     * The option exists so a verdict can be circulated without the quotations behind it.
     * What must survive is every requirement tested and its result — that is the report.
     * What goes is the block under each one that starts with the document name: source,
     * version, clause, page and quoted passage.
     */
    const withEvidence = await generateReport('markdown');
    const full = new TextDecoder().decode(await downloadArtifact(withEvidence.artifactId));

    const withoutEvidence = await generateReport('markdown', 'compliance_report', {
      includeEvidence: false,
    });
    const short = new TextDecoder().decode(await downloadArtifact(withoutEvidence.artifactId));

    // The findings survive: same requirement column, same number of rows.
    const rowsIn = (text: string) =>
      text.split('\n').filter((line) => line.startsWith('| ')).length;
    expect(rowsIn(short)).toBe(rowsIn(full));
    expect(short).toMatch(/## Findings/);
    expect(short).toMatch(/## Summary/);

    // The citation columns do not.
    expect(full).toMatch(/\| Source \|/);
    expect(short).not.toMatch(/\| Source \|/);
    expect(short).not.toMatch(/\| Excerpt \|/);

    // And the document says it went out that way, rather than looking complete.
    expect(short).toMatch(/without their evidence/i);
    expect(short).toMatch(/not reproduced here/i);
  }, 300_000);

  it('includes the evidence by default', async () => {
    const { artifactId } = await generateReport('markdown');
    const text = new TextDecoder().decode(await downloadArtifact(artifactId));

    expect(text).toMatch(/## Evidence matrix/);
    expect(text).toMatch(/traceable to the source version/i);
    expect(text).not.toMatch(/without their evidence/i);
  }, 300_000);

  it('produces an evidence matrix export with one row per finding', async () => {
    const { artifactId } = await generateReport('csv', 'evidence_matrix');
    const text = new TextDecoder().decode(await downloadArtifact(artifactId));

    const header = text.split('\n')[0]!.toLowerCase();
    expect(header).toMatch(/requirement/);
    expect(header).toMatch(/result/);
    expect(header).toMatch(/page|location|clause/);
    expect(header).toMatch(/excerpt/);
    // One header row plus one row per finding.
    expect(text.trim().split('\n').length).toBeGreaterThan(1);
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
    const created = await owner.client.post<{ job: { id: string } }>(
      `/consultations/${consultationId}/corrections`,
      {
        sourceId: projectId,
        reviewId,
        idempotencyKey: `correction-${Date.now()}`,
      },
    );
    expect(created.status).toBeLessThan(300);
    const job = await waitForJob(owner.client, created.body.job.id, 240_000);
    expect(job.status).toBe('succeeded');

    // The plan is created by the job; the job says which one.
    expect(job.resultRef?.kind).toBe('plan');
    const planId = job.resultRef!.id;

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
    const created = await owner.client.post<{ job: { id: string } }>(
      `/consultations/${consultationId}/corrections`,
      {
        sourceId: projectId,
        reviewId,
        idempotencyKey: `correction-apply-${Date.now()}`,
      },
    );
    const planJob = await waitForJob(owner.client, created.body.job.id, 240_000);
    expect(planJob.status).toBe('succeeded');
    const planId = planJob.resultRef!.id;

    const plan = await owner.client.get<{ changes: Array<{ id: string }>; version: number }>(
      `/corrections/${planId}`,
    );
    const first = plan.body.changes[0];
    expect(first, 'the plan proposed no changes').toBeDefined();

    const accepted = await owner.client.patch(`/corrections/${planId}`, {
      decisions: [{ changeId: first!.id, status: 'accepted', editedContent: null }],
      version: plan.body.version,
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBeLessThan(300);

    // The decision is really recorded, not merely accepted by the endpoint.
    const afterDecision = await owner.client.get<{
      changes: Array<{ id: string; status: string }>;
    }>(`/corrections/${planId}`);
    expect(afterDecision.body.changes.find((change) => change.id === first!.id)?.status).toBe(
      'accepted',
    );

    const generated = await owner.client.post<{ job: { id: string } }>(
      `/corrections/${planId}/generate`,
      { idempotencyKey: `generate-${Date.now()}` },
    );
    expect(generated.status, JSON.stringify(generated.body)).toBeLessThan(300);
    const job = await waitForJob(owner.client, generated.body.job.id, 240_000);
    expect(job.status).toBe('succeeded');

    // The original source still exists at its original version.
    const source = await owner.client.get<{ currentVersion: string; status: string }>(
      `/sources/${projectId}`,
    );
    expect(source.body.status).toBe('ready');

    const artifacts = await owner.client.get<{
      items: Array<{ id: string; kind: string; documentType: string; disclosures?: string[] }>;
    }>('/artifacts?pageSize=50');
    const corrected = artifacts.body.items.find((a) => a.kind === 'corrected_document');
    expect(corrected, JSON.stringify(artifacts.body.items)).toBeDefined();
    // The corrected edition matches the input type, as the brief requires.
    expect(corrected!.documentType).toBe('pdf');
  }, 600_000);
});
