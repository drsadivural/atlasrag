import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Client, Harness } from './harness.js';
import { waitForJob } from './harness.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/documents/', import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  txt: 'text/plain',
};

export async function fixtureBytes(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(`${FIXTURES}${name}`));
}

export interface UploadedSource {
  sourceId: string;
  jobId: string | null;
  status: number;
  body: unknown;
}

/**
 * Uploads a fixture the way the browser does: request a ticket, PUT the bytes to the URL
 * the ticket names, then wait for the ingestion job the server enqueued.
 */
export async function uploadFixture(
  harness: Harness,
  client: Client,
  name: string,
  options: { title?: string; promoteToKnowledge?: boolean; wait?: boolean; tags?: string[] } = {},
): Promise<UploadedSource> {
  const bytes = await fixtureBytes(name);
  const extension = name.split('.').pop() ?? 'bin';

  const ticketResponse = await client.post<{
    tickets: Array<{ uploadId: string; sourceId: string; uploadUrl: string }>;
  }>('/sources/uploads', {
    files: [
      {
        fileName: name,
        sizeBytes: bytes.byteLength,
        contentType: CONTENT_TYPES[extension] ?? 'application/octet-stream',
      },
    ],
    tags: options.tags ?? [],
    accessScope: 'workspace',
    promoteToKnowledge: options.promoteToKnowledge ?? true,
  });

  if (ticketResponse.status >= 400) {
    return { sourceId: '', jobId: null, status: ticketResponse.status, body: ticketResponse.body };
  }

  const ticket = ticketResponse.body.tickets[0]!;
  // The ticket URL is relative so the browser stays on its own origin; the harness client
  // already prefixes /api/v1.
  const path = new URL(ticket.uploadUrl, 'http://localhost:8788').pathname.replace('/api/v1', '');

  const put = await client.request<{
    sourceId: string;
    job?: { id: string };
    duplicate?: boolean;
    message?: string;
  }>('PUT', path, {
    rawBody: bytes,
    headers: { 'content-type': CONTENT_TYPES[extension] ?? 'application/octet-stream' },
  });

  const jobId = put.body?.job?.id ?? null;
  if (jobId && options.wait !== false) {
    await waitForJob(client, jobId);
  }

  if (options.title) {
    // The row version travels with the request; without it the rename is refused and the
    // fixture would quietly keep its file name as its title.
    const current = await client.get<{ version: number }>(`/sources/${ticket.sourceId}`);
    const renamed = await client.patch(`/sources/${ticket.sourceId}`, {
      title: options.title,
      version: current.body.version,
    });
    if (renamed.status >= 400) {
      throw new Error(
        `Renaming the fixture failed: ${renamed.status} ${JSON.stringify(renamed.body)}`,
      );
    }
  }

  return { sourceId: ticket.sourceId, jobId, status: put.status, body: put.body };
}

export interface AskResult {
  messageId: string;
  jobId: string;
  answer: {
    decision: string | null;
    decisionQualifier: string | null;
    headline: string;
    citations: Array<{
      citationId: string;
      verified: boolean;
      supportingExcerpt: string;
      documentTitle: string;
      pageNumber: number | null;
      clause: string | null;
    }>;
    findings: Array<{ result: string; requirementReference: string }>;
    coverage: { verifiedCitations: number; unverifiedCitations: number };
    confidence: { overall: number };
    usedGeneralModel: boolean;
  } | null;
}

/** Posts a question and waits for the answer the worker actually persisted. */
export async function ask(
  client: Client,
  consultationId: string,
  text: string,
  options: { taskMode?: string; answerStyle?: string; idempotencyKey?: string } = {},
): Promise<AskResult> {
  const posted = await client.post<{ message: { id: string }; job: { id: string } }>(
    `/consultations/${consultationId}/messages`,
    {
      text,
      taskMode: options.taskMode ?? 'ask',
      answerStyle: options.answerStyle ?? 'optimal',
      attachmentIds: [],
      parentMessageId: null,
      idempotencyKey:
        options.idempotencyKey ?? `ask-${Math.random().toString(36).slice(2)}-${Date.now()}`,
    },
  );

  if (posted.status >= 400) {
    throw new Error(`Ask failed: ${posted.status} ${JSON.stringify(posted.body)}`);
  }

  await waitForJob(client, posted.body.job.id);

  const detail = await client.get<{
    messages: Array<{ id: string; answer: AskResult['answer'] }>;
  }>(`/consultations/${consultationId}`);

  const message = detail.body.messages.find((m) => m.id === posted.body.message.id);
  return {
    messageId: posted.body.message.id,
    jobId: posted.body.job.id,
    answer: message?.answer ?? null,
  };
}
