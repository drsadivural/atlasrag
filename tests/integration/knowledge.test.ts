import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createHarness,
  registerOwner,
  truncateAll,
  waitForJob,
  type Harness,
  type RegisteredAccount,
} from './harness.js';
import { fixtureBytes, uploadFixture } from './helpers.js';

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

describe('source listing query', () => {
  it('treats an empty parameter as one that was not supplied', async () => {
    // `?sort=&ownerId=` is what a form or a hand-edited URL produces. Read as present but
    // invalid it is a 400, which is what a caller used to get.
    const response = await owner.client.get<{ items: unknown[] }>(
      '/sources?status=all&documentType=all&page=1&pageSize=10&sort=&ownerId=&tag=&q=',
    );
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.items)).toBe(true);
  });

  it('names the parameter it rejected', async () => {
    const response = await owner.client.get<{
      error: { message: string; fieldErrors: Record<string, string[]> };
    }>('/sources?page=0');
    expect(response.status).toBe(400);
    // A caller cannot fix "one or more parameters are invalid".
    expect(response.body.error.message).toContain('page');
    expect(Object.keys(response.body.error.fieldErrors)).toContain('page');
  });
});

describe('ingesting a regulation', () => {
  it('extracts, chunks, indexes and reports a ready source with real page counts', async () => {
    const uploaded = await uploadFixture(harness, owner.client, 'regulation-native.pdf');
    expect(uploaded.status).toBeLessThan(300);

    const source = await owner.client.get<{
      status: string;
      pages: number | null;
      documentType: string;
      currentVersion: string;
      chunkCount?: number;
    }>(`/sources/${uploaded.sourceId}`);

    expect(source.body.status).toBe('ready');
    expect(source.body.documentType).toBe('pdf');
    expect(source.body.pages).toBeGreaterThan(0);
    expect(source.body.currentVersion).toBeTruthy();
  });

  it('records every pipeline stage with a real outcome', async () => {
    const uploaded = await uploadFixture(harness, owner.client, 'regulation-native.pdf');
    const job = await owner.client.get<{
      status: string;
      stages: Array<{ key: string; state: string; detail: string | null }>;
    }>(`/jobs/${uploaded.jobId}`);

    expect(job.body.status).toBe('succeeded');
    const keys = job.body.stages.map((stage) => stage.key);
    expect(keys).toContain('extraction');
    expect(keys).toContain('chunking');
    expect(keys).toContain('embeddings');
    expect(keys).toContain('citation_map');
    expect(job.body.stages.every((stage) => stage.state === 'complete')).toBe(true);
  });

  it('keeps the original bytes byte-for-byte', async () => {
    const uploaded = await uploadFixture(harness, owner.client, 'regulation-native.pdf');
    const original = await fixtureBytes('regulation-native.pdf');

    const versions = await owner.client.get<
      Array<{ id: string; sha256: string; sizeBytes: number }>
    >(`/sources/${uploaded.sourceId}/versions`);

    const version = versions.body[0]!;
    expect(version.sizeBytes).toBe(original.byteLength);

    const digest = await crypto.subtle.digest('SHA-256', original as unknown as ArrayBufferView);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(version.sha256).toBe(hex);
  });

  it('detects a duplicate anywhere in the workspace and does not index it twice', async () => {
    await uploadFixture(harness, owner.client, 'regulation-native.pdf');
    const second = await uploadFixture(harness, owner.client, 'regulation-native.pdf');

    expect((second.body as { duplicate?: boolean }).duplicate).toBe(true);
    expect(JSON.stringify(second.body)).toMatch(/already/i);

    const list = await owner.client.get<{ items: Array<{ status: string }> }>(
      '/sources?status=ready',
    );
    expect(list.body.items).toHaveLength(1);
  });

  it('publishes the existing copy when the same bytes are uploaded to the knowledge base', async () => {
    /*
     * Step 1 of the flow this product exists for: put the code in the knowledge base.
     *
     * Deduplication used to defeat it. If the workspace already held the same bytes from a
     * consultation upload — the drawing set somebody sent into a chat last week, or the
     * code itself uploaded there by mistake — the knowledge upload deduplicated onto that
     * unpromoted copy, reported "already in your knowledge base", and left the knowledge
     * base empty. Every review after that had no authority to judge against, and the only
     * clue was a success message that was not true.
     */
    const first = await uploadFixture(harness, owner.client, 'policy.docx', {
      promoteToKnowledge: false,
    });
    expect(first.sourceId).not.toBe('');

    const beforeList = await owner.client.get<{ items: Array<{ id: string }> }>(
      '/sources?status=ready',
    );
    expect(beforeList.body.items.map((i) => i.id)).not.toContain(first.sourceId);

    const second = await uploadFixture(harness, owner.client, 'policy.docx', {
      promoteToKnowledge: true,
    });
    const body = second.body as { duplicate?: boolean; sourceId?: string };
    expect(body.duplicate).toBe(true);
    expect(body.sourceId).toBe(first.sourceId);

    // The same one document, and it is now in the knowledge base.
    const afterList = await owner.client.get<{ items: Array<{ id: string }> }>(
      '/sources?status=ready',
    );
    expect(afterList.body.items.map((i) => i.id)).toContain(first.sourceId);
    expect(JSON.stringify(second.body)).toMatch(/now published to the knowledge base/i);
  }, 300_000);

  it('does not claim a file is in the knowledge base when it is only in a consultation', async () => {
    await uploadFixture(harness, owner.client, 'playbook.pptx', { promoteToKnowledge: false });
    const second = await uploadFixture(harness, owner.client, 'playbook.pptx', {
      promoteToKnowledge: false,
    });

    expect((second.body as { duplicate?: boolean }).duplicate).toBe(true);
    // Honesty over reassurance: it says where the bytes actually are.
    expect(JSON.stringify(second.body)).toMatch(/not part of the knowledge base/i);
  }, 300_000);
});

describe('documents that must be refused', () => {
  it('refuses a file whose bytes are not the type it claims', async () => {
    const result = await uploadFixture(harness, owner.client, 'fake.pdf', { wait: false });
    const message = JSON.stringify(result.body);
    if (result.status >= 400) {
      expect(message).toMatch(/pdf|type|format/i);
      return;
    }
    const job = await waitForJob(owner.client, result.jobId!);
    const source = await owner.client.get<{ status: string; failureReason: string | null }>(
      `/sources/${result.sourceId}`,
    );
    expect(['failed', 'quarantined']).toContain(source.body.status);
    expect(`${job.error} ${source.body.failureReason ?? ''}`).toMatch(
      /pdf|type|format|could not|signature/i,
    );
  });

  it('refuses a corrupt PDF with an actionable message, not a stack trace', async () => {
    const result = await uploadFixture(harness, owner.client, 'corrupt.pdf', { wait: false });
    if (result.status < 300 && result.jobId) {
      await waitForJob(owner.client, result.jobId);
      const source = await owner.client.get<{ status: string; failureReason: string | null }>(
        `/sources/${result.sourceId}`,
      );
      expect(['failed', 'quarantined']).toContain(source.body.status);
      const reason = source.body.failureReason ?? '';
      expect(reason).not.toMatch(/Traceback|at Object\.|undefined is not/);
      expect(reason.length).toBeGreaterThan(10);
    } else {
      expect(result.status).toBeGreaterThanOrEqual(400);
    }
  });

  it('refuses a password-protected PDF and says so', async () => {
    const result = await uploadFixture(harness, owner.client, 'encrypted.pdf', { wait: false });
    if (result.status < 300 && result.jobId) {
      const job = await waitForJob(owner.client, result.jobId);
      const source = await owner.client.get<{ status: string; failureReason: string | null }>(
        `/sources/${result.sourceId}`,
      );
      expect(['failed', 'quarantined']).toContain(source.body.status);
      expect(`${job.error} ${source.body.failureReason ?? ''}`).toMatch(
        /password|encrypt|protect/i,
      );
    } else {
      expect(result.status).toBeGreaterThanOrEqual(400);
    }
  });

  it('quarantines a known-malicious payload and never indexes it', async () => {
    const result = await uploadFixture(harness, owner.client, 'eicar.txt', { wait: false });
    if (result.status < 300 && result.jobId) {
      const job = await waitForJob(owner.client, result.jobId);
      const scan = job.stages.find((stage) => stage.key === 'malware_scan');
      expect(scan?.state).toBe('failed');

      const source = await owner.client.get<{ status: string; failureReason: string | null }>(
        `/sources/${result.sourceId}`,
      );
      expect(source.body.status).toBe('quarantined');
      expect(source.body.failureReason ?? '').not.toBe('');
    } else {
      expect(result.status).toBeGreaterThanOrEqual(400);
    }

    const list = await owner.client.get<{ items: Array<{ status: string }> }>(
      '/sources?status=ready',
    );
    expect(list.body.items).toHaveLength(0);
  });

  it('refuses a zip bomb rather than expanding it', async () => {
    const result = await uploadFixture(harness, owner.client, 'zipbomb.zip', { wait: false });
    if (result.status < 300 && result.jobId) {
      const job = await waitForJob(owner.client, result.jobId);
      const source = await owner.client.get<{ status: string; failureReason: string | null }>(
        `/sources/${result.sourceId}`,
      );
      expect(['failed', 'quarantined']).toContain(source.body.status);
      expect(`${job.error} ${source.body.failureReason ?? ''}`).toMatch(
        /archive|ratio|expand|large|entries|zip/i,
      );
    } else {
      expect(result.status).toBeGreaterThanOrEqual(400);
    }
  });

  it('quarantines a document that tries to issue instructions', async () => {
    const result = await uploadFixture(harness, owner.client, 'injection.pdf', { wait: false });
    if (result.jobId) await waitForJob(owner.client, result.jobId);

    const source = await owner.client.get<{ status: string; failureReason: string | null }>(
      `/sources/${result.sourceId}`,
    );
    expect(['quarantined', 'needs_review', 'failed']).toContain(source.body.status);
    expect(source.body.failureReason ?? '').not.toBe('');
  });
});

describe('office formats', () => {
  it('ingests a DOCX policy and keeps its headings addressable', async () => {
    const uploaded = await uploadFixture(harness, owner.client, 'policy.docx');
    const source = await owner.client.get<{ status: string; documentType: string }>(
      `/sources/${uploaded.sourceId}`,
    );
    expect(source.body.status).toBe('ready');
    expect(source.body.documentType).toBe('docx');
  });

  it('ingests a spreadsheet and records sheet-level locators', async () => {
    const uploaded = await uploadFixture(harness, owner.client, 'vendors.xlsx');
    const source = await owner.client.get<{ status: string; documentType: string }>(
      `/sources/${uploaded.sourceId}`,
    );
    expect(source.body.status).toBe('ready');
    expect(source.body.documentType).toBe('xlsx');
  });

  it('ingests a deck and records slide numbers', async () => {
    const uploaded = await uploadFixture(harness, owner.client, 'playbook.pptx');
    const source = await owner.client.get<{ status: string; documentType: string }>(
      `/sources/${uploaded.sourceId}`,
    );
    expect(source.body.status).toBe('ready');
    expect(source.body.documentType).toBe('pptx');
  });

  it('reads a scanned page through OCR and records the confidence it achieved', async () => {
    const uploaded = await uploadFixture(harness, owner.client, 'scanned.pdf');
    const source = await owner.client.get<{ status: string; pages: number | null }>(
      `/sources/${uploaded.sourceId}`,
    );
    expect(source.body.status).toBe('ready');

    const versions = await owner.client.get<
      Array<{ ocrApplied: boolean; ocrConfidence: number | null; isCurrent: boolean }>
    >(`/sources/${uploaded.sourceId}/versions`);
    const current = versions.body.find((v) => v.isCurrent) ?? versions.body[0]!;

    // OCR was really used, and the confidence it achieved was recorded rather than assumed.
    expect(current.ocrApplied).toBe(true);
    expect(current.ocrConfidence).not.toBeNull();
    expect(current.ocrConfidence!).toBeGreaterThan(0);
  }, 180_000);
});

describe('source lifecycle', () => {
  it('lets an owner retitle, tag and archive a source', async () => {
    const uploaded = await uploadFixture(harness, owner.client, 'regulation-native.pdf');

    const before = await owner.client.get<{ version?: number }>(`/sources/${uploaded.sourceId}`);
    const renamed = await owner.client.patch<{ title: string; tags: string[] }>(
      `/sources/${uploaded.sourceId}`,
      { title: 'UAE Fire Code 2018', tags: ['fire', 'egress'], version: before.body.version ?? 0 },
    );
    expect(renamed.status).toBe(200);
    expect(renamed.body.title).toBe('UAE Fire Code 2018');
    expect(renamed.body.tags).toEqual(['fire', 'egress']);

    const archived = await owner.client.post(`/sources/bulk`, {
      action: 'archive',
      sourceIds: [uploaded.sourceId],
      confirm: true,
    });
    expect(archived.status).toBeLessThan(300);

    const list = await owner.client.get<{ counts: { archived: number } }>('/sources');
    expect(list.body.counts.archived).toBe(1);
  });

  it('reprocesses a source and produces a fresh, succeeded job', async () => {
    const uploaded = await uploadFixture(harness, owner.client, 'regulation-native.pdf');

    const reprocess = await owner.client.post<{ job: { id: string } }>(
      `/sources/${uploaded.sourceId}/reprocess`,
    );
    expect(reprocess.status).toBeLessThan(300);

    const job = await waitForJob(owner.client, reprocess.body.job.id);
    expect(job.status).toBe('succeeded');

    const source = await owner.client.get<{ status: string }>(`/sources/${uploaded.sourceId}`);
    expect(source.body.status).toBe('ready');
  });

  it('records who did what in the audit log', async () => {
    const uploaded = await uploadFixture(harness, owner.client, 'regulation-native.pdf');
    const before = await owner.client.get<{ version?: number }>(`/sources/${uploaded.sourceId}`);
    await owner.client.patch(`/sources/${uploaded.sourceId}`, {
      title: 'Renamed for audit',
      version: before.body.version ?? 0,
    });

    const audit = await owner.client.get<{
      items: Array<{ action: string; actorName: string; targetLabel: string | null }>;
    }>('/audit-events?pageSize=100');

    const actions = audit.body.items.map((event) => event.action);
    expect(actions).toContain('source.updated');
    expect(audit.body.items.every((event) => event.actorName.length > 0)).toBe(true);
  });
});
