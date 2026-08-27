import { describe, expect, it } from 'vitest';
import {
  forCapability,
  listAvailableModels,
  ModelCatalogueError,
  type FetchLike,
} from '../../apps/api/src/services/model-catalogue.js';

/**
 * Asking a provider what it will serve.
 *
 * The point of this call is to stop anybody — including this codebase — from guessing a
 * model identifier. What is checked here is the asking: the right endpoint, the right
 * authentication for each provider, the shapes both of them return, and that a rejected
 * key is told apart from a provider having a bad minute.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stub(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, ...(init ? { init } : {}) });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

describe('reading a provider catalogue', () => {
  it('authenticates the way each provider expects', async () => {
    const openai = stub(() => json({ data: [] }));
    await listAvailableModels('openai', 'sk-test', openai.fetchImpl);
    expect(openai.calls[0]?.url).toBe('https://api.openai.com/v1/models');
    expect((openai.calls[0]?.init?.headers as Record<string, string>).authorization).toBe(
      'Bearer sk-test',
    );

    const anthropic = stub(() => json({ data: [] }));
    await listAvailableModels('anthropic', 'sk-ant', anthropic.fetchImpl);
    const headers = anthropic.calls[0]?.init?.headers as Record<string, string>;
    // Anthropic takes a header of its own and requires a version; a bearer token is refused.
    expect(headers['x-api-key']).toBe('sk-ant');
    expect(headers['anthropic-version']).toBeTruthy();
  });

  it('reads both response shapes and puts the newest first', async () => {
    const { fetchImpl } = stub(() =>
      json({
        data: [
          { id: 'old-model', created: 1_600_000_000 },
          { id: 'new-model', created: 1_800_000_000 },
          { id: 'named-model', display_name: 'Named Model', created_at: '2026-07-01T00:00:00Z' },
        ],
      }),
    );

    const models = await listAvailableModels('openai', 'sk', fetchImpl);
    // Sorted by date whichever field carried it: epoch seconds and an ISO string are the
    // same instant to this comparison.
    expect(models.map((m) => m.id)).toEqual(['new-model', 'named-model', 'old-model']);
    // A provider that names its models has that name used; one that does not falls back
    // to the identifier rather than rendering an empty label.
    expect(models[0]?.label).toBe('new-model');
    expect(models[1]?.label).toBe('Named Model');
  });

  it('tells a rejected key apart from a provider having a bad minute', async () => {
    for (const [status, retryable] of [
      [401, false],
      [403, false],
      [429, true],
      [503, true],
    ] as const) {
      const { fetchImpl } = stub(() =>
        json({ error: { message: 'org-abc is not allowed' } }, status),
      );
      await expect(listAvailableModels('openai', 'sk', fetchImpl)).rejects.toMatchObject({
        retryable,
      });
    }
  });

  it("does not carry the provider's own message back", async () => {
    const { fetchImpl } = stub(() =>
      json({ error: { message: 'key sk-live-abc for org-acme is revoked' } }, 401),
    );
    await expect(listAvailableModels('openai', 'sk', fetchImpl)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ModelCatalogueError && !/sk-live|org-acme/.test((error as Error).message),
    );
  });

  it('skips entries with no identifier rather than inventing one', async () => {
    const { fetchImpl } = stub(() => json({ data: [{ created: 1 }, { id: 'real' }] }));
    expect((await listAvailableModels('openai', 'sk', fetchImpl)).map((m) => m.id)).toEqual([
      'real',
    ]);
  });
});

describe('which models suit a capability', () => {
  const models = [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'text-embedding-3-large',
    'whisper-1',
    'dall-e-3',
    'omni-moderation-latest',
    'something-nobody-has-heard-of',
  ].map((id) => ({ id, label: id, createdAt: null }));

  it('offers only embedding models for embeddings', () => {
    expect(forCapability(models, 'embedding').map((m) => m.id)).toEqual(['text-embedding-3-large']);
  });

  it('keeps audio, image and moderation models out of chat', () => {
    const chat = forCapability(models, 'chat').map((m) => m.id);
    expect(chat).toContain('gpt-5.6-sol');
    expect(chat).not.toContain('whisper-1');
    expect(chat).not.toContain('dall-e-3');
    expect(chat).not.toContain('omni-moderation-latest');
    expect(chat).not.toContain('text-embedding-3-large');
  });

  it('shows an unfamiliar model rather than hiding it', () => {
    // The filter has to keep working when the provider ships something this code has
    // never heard of, which it will.
    expect(forCapability(models, 'chat').map((m) => m.id)).toContain(
      'something-nobody-has-heard-of',
    );
  });
});
