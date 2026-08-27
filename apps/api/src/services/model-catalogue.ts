/**
 * Which models a provider will actually serve for a given key.
 *
 * Asked rather than assumed. A hardcoded list goes stale the week after it is written, and
 * guessing an identifier produces a configuration that fails at the first request with an
 * error nobody can act on. The provider knows what it offers; this asks it.
 */

export type ModelProvider = 'openai' | 'anthropic';

export interface AvailableModel {
  id: string;
  /** What the provider calls it, when it says. Falls back to the identifier. */
  label: string;
  /** Present only when the provider reports one. */
  createdAt: string | null;
}

export class ModelCatalogueError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ModelCatalogueError';
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const ENDPOINTS: Record<ModelProvider, string> = {
  openai: 'https://api.openai.com/v1/models',
  anthropic: 'https://api.anthropic.com/v1/models',
};

export async function listAvailableModels(
  provider: ModelProvider,
  apiKey: string,
  fetchImpl: FetchLike = fetch,
): Promise<AvailableModel[]> {
  const response = await fetchImpl(ENDPOINTS[provider], {
    headers:
      provider === 'openai'
        ? { authorization: `Bearer ${apiKey}`, accept: 'application/json' }
        : {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            accept: 'application/json',
          },
  });

  if (!response.ok) {
    // The provider's own message can name an organisation or a key. It is not carried
    // through; what the caller needs is whether to fix the key or to try again later.
    throw new ModelCatalogueError(
      response.status === 401 || response.status === 403
        ? 'That API key was not accepted by the provider.'
        : 'The provider could not be reached. Try again shortly.',
      response.status,
      response.status >= 500 || response.status === 429,
    );
  }

  const payload = (await response.json()) as {
    data?: Array<{ id?: string; display_name?: string; created?: number; created_at?: string }>;
  };

  const models = (payload.data ?? [])
    .map((entry) => {
      if (!entry.id) return null;
      return {
        id: entry.id,
        label: entry.display_name ?? entry.id,
        createdAt:
          entry.created_at ??
          (typeof entry.created === 'number' ? new Date(entry.created * 1000).toISOString() : null),
      } satisfies AvailableModel;
    })
    .filter((entry): entry is AvailableModel => entry !== null);

  // Newest first where the provider dates them, then alphabetically, so the list opens on
  // what somebody is most likely looking for rather than on the oldest thing on offer.
  return models.sort((a, b) => {
    if (a.createdAt && b.createdAt && a.createdAt !== b.createdAt) {
      return a.createdAt < b.createdAt ? 1 : -1;
    }
    return a.id.localeCompare(b.id);
  });
}

/**
 * Models this application can actually use for a capability.
 *
 * A provider serves far more than chat models — embeddings, audio, moderation, images —
 * and offering all of them for "chat" would invite a configuration that cannot work. The
 * filter is by what the identifier says it is, and it is deliberately generous: an
 * unfamiliar model is shown rather than hidden, because this list has to keep working when
 * the provider ships something this code has never heard of.
 */
export function forCapability(models: AvailableModel[], capability: string): AvailableModel[] {
  const isEmbedding = (id: string) => /embed/i.test(id);
  const isNonText = (id: string) =>
    /whisper|tts|audio|realtime|image|dall-?e|moderation|transcribe|speech|video/i.test(id);

  if (capability === 'embedding') return models.filter((m) => isEmbedding(m.id));
  return models.filter((m) => !isEmbedding(m.id) && !isNonText(m.id));
}
