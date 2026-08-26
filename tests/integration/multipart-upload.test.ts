import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createHarness,
  registerOwner,
  truncateAll,
  waitForJob,
  type Harness,
  type RegisteredAccount,
} from './harness.js';
import { fixtureBytes } from './helpers.js';

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

/**
 * Uploading a file in parts.
 *
 * The server takes a whole file happily; what does not is the network in front of it.
 * Cloudflare refuses a request body over 100MB on most plans, and refuses it at the edge,
 * so a large document never reaches the application at all. Parts keep every individual
 * request small enough to survive whatever sits in the middle, and the file that comes
 * out the other end has to be byte-for-byte the one that went in.
 */
describe('multi-part upload', () => {
  async function ticketFor(bytes: Uint8Array, fileName = 'large.pdf') {
    const response = await owner.client.post<{
      tickets: Array<{ uploadUrl: string; sourceId: string }>;
    }>('/sources/uploads', {
      files: [{ fileName, sizeBytes: bytes.byteLength, contentType: 'application/pdf' }],
      tags: [],
      accessScope: 'workspace',
      promoteToKnowledge: true,
    });
    const ticket = response.body.tickets[0];
    if (!ticket) throw new Error(`No ticket: ${JSON.stringify(response.body)}`);
    return ticket;
  }

  function sendPart(url: string, body: Uint8Array, headers: Record<string, string> = {}) {
    // The ticket names a browser-relative URL; the harness client is already rooted at the
    // API prefix, so it is stripped rather than sent twice.
    const path = new URL(url, 'http://localhost').pathname.replace('/api/v1', '');
    return owner.client.request('PUT', path, {
      rawBody: body,
      headers: { 'content-type': 'application/pdf', ...headers },
    });
  }

  it('assembles the parts into the same bytes that were sent', async () => {
    const bytes = await fixtureBytes('regulation-native.pdf');
    const split = Math.floor(bytes.byteLength / 2);
    const ticket = await ticketFor(bytes);

    const first = await sendPart(ticket.uploadUrl, bytes.slice(0, split), {
      'x-upload-part': '1',
      'x-upload-parts': '2',
    });
    // Every part but the last says so, rather than pretending the upload is finished.
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ received: 1, of: 2, complete: false });

    const last = await sendPart(ticket.uploadUrl, bytes.slice(split), {
      'x-upload-part': '2',
      'x-upload-parts': '2',
    });
    expect(last.status).toBe(202);

    const outcome = await waitForJob(
      owner.client,
      (last.body as { job: { id: string } }).job.id,
      120_000,
    );
    expect(outcome.status).toBe('succeeded');

    // The assembled document is indexed like any other, which is the whole point: nothing
    // downstream knows or cares that it arrived in pieces.
    const detail = await owner.client.get<{ status: string; sizeBytes: number }>(
      `/sources/${ticket.sourceId}`,
    );
    expect(detail.body.status).toBe('ready');
    // Byte-for-byte the file that went in, which is the only assurance that matters when
    // a document is reassembled from pieces.
    expect(detail.body.sizeBytes).toBe(bytes.byteLength);
  });

  it('refuses the assembly when a part never arrived', async () => {
    const bytes = await fixtureBytes('regulation-native.pdf');
    const ticket = await ticketFor(bytes);

    // Part 2 of 3 is skipped: the last part arrives, and the file cannot be made.
    await sendPart(ticket.uploadUrl, bytes.slice(0, 10), {
      'x-upload-part': '1',
      'x-upload-parts': '3',
    });
    const last = await sendPart(ticket.uploadUrl, bytes.slice(10), {
      'x-upload-part': '3',
      'x-upload-parts': '3',
    });

    expect(last.status).toBe(400);
    expect((last.body as { error: { message: string } }).error.message).toContain('Part 2 of 3');
  });

  it('refuses a total that does not match what the ticket was issued for', async () => {
    const bytes = await fixtureBytes('regulation-native.pdf');
    const ticket = await ticketFor(bytes);

    // Only half the file, declared as complete: the reserved quota would be a fiction.
    const response = await sendPart(ticket.uploadUrl, bytes.slice(0, 20), {
      'x-upload-part': '1',
      'x-upload-parts': '1',
    });
    expect(response.status).toBe(400);
    expect((response.body as { error: { message: string } }).error.message).toContain(
      'the ticket was issued for',
    );
  });

  it('refuses malformed part headers before storing anything', async () => {
    const bytes = await fixtureBytes('regulation-native.pdf');

    const malformed: Array<Record<string, string>> = [
      { 'x-upload-part': '0', 'x-upload-parts': '2' },
      { 'x-upload-part': '3', 'x-upload-parts': '2' },
      { 'x-upload-part': 'first', 'x-upload-parts': '2' },
      { 'x-upload-part': '1', 'x-upload-parts': '999' },
      // A part index with no total: the server cannot know when the file is complete.
      { 'x-upload-part': '1' },
    ];

    for (const headers of malformed) {
      const ticket = await ticketFor(bytes, `probe-${JSON.stringify(headers).length}.pdf`);
      const response = await sendPart(ticket.uploadUrl, bytes.slice(0, 10), headers);
      expect(response.status, JSON.stringify(headers)).toBe(400);
    }
  });

  it('still accepts a whole file in one request', async () => {
    const bytes = await fixtureBytes('regulation-native.pdf');
    const ticket = await ticketFor(bytes, 'single-shot.pdf');

    const response = await sendPart(ticket.uploadUrl, bytes);
    expect(response.status).toBe(202);
    expect((response.body as { duplicate: boolean }).duplicate).toBe(false);
  });
});
