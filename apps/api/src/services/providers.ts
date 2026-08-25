import {
  AnthropicChatProvider,
  DeterministicChatProvider,
  DeterministicEmbeddingProvider,
  OpenAIChatProvider,
  OpenAIEmbeddingProvider,
  type ChatProvider,
  type EmbeddingProvider,
  type ProviderHealth,
} from '@uxe/rag';
import { decryptSecret } from '@uxe/auth';
import type { AppEnv } from '../env.js';
import type { AppDeps } from '../context.js';

/**
 * Builds the providers the process starts with.
 *
 * The deterministic pair is always constructible, so the application boots and every
 * endpoint works with no credentials at all. A hosted provider is only selected when its
 * key is present, which is what makes an unconfigured deployment degrade to "grounded,
 * extractive answers" rather than to a broken product.
 */
export function buildProviders(env: AppEnv): { chat: ChatProvider; embeddings: EmbeddingProvider } {
  const chat: ChatProvider =
    env.MODEL_PROVIDER === 'anthropic' && env.ANTHROPIC_API_KEY
      ? new AnthropicChatProvider(env.ANTHROPIC_API_KEY, env.ANTHROPIC_CHAT_MODEL)
      : env.MODEL_PROVIDER === 'openai' && env.OPENAI_API_KEY
        ? new OpenAIChatProvider(env.OPENAI_API_KEY, env.OPENAI_CHAT_MODEL)
        : new DeterministicChatProvider();

  const embeddings: EmbeddingProvider =
    env.EMBEDDING_PROVIDER === 'openai' && env.OPENAI_API_KEY
      ? new OpenAIEmbeddingProvider(env.OPENAI_API_KEY, env.OPENAI_EMBEDDING_MODEL)
      : new DeterministicEmbeddingProvider();

  return { chat, embeddings };
}

/**
 * Verifies a stored provider configuration.
 *
 * Runs the provider's own health check with the decrypted credential and never returns
 * any part of that credential — only a status and an actionable message.
 */
export async function probeProvider(
  deps: AppDeps,
  config: {
    provider: string;
    model: string;
    capability: string;
    credentialEncrypted: string | null;
  },
): Promise<ProviderHealth> {
  if (config.provider === 'deterministic') {
    return {
      status: 'healthy',
      detail: 'Local extractive engine; no credential required.',
      latencyMs: 0,
    };
  }

  if (!config.credentialEncrypted) {
    return {
      status: 'unconfigured',
      detail: 'No API key has been saved for this provider.',
      latencyMs: null,
    };
  }

  let apiKey: string;
  try {
    apiKey = await decryptSecret(config.credentialEncrypted, deps.env.ENCRYPTION_KEY);
  } catch {
    // Almost always means ENCRYPTION_KEY was rotated without re-entering the credential.
    return {
      status: 'unconfigured',
      detail: 'The stored credential could not be decrypted. Re-enter the API key.',
      latencyMs: null,
    };
  }

  if (config.capability === 'embedding' && config.provider === 'openai') {
    const provider = new OpenAIEmbeddingProvider(apiKey, config.model);
    const started = Date.now();
    try {
      await provider.embed(['health check']);
      return { status: 'healthy', detail: null, latencyMs: Date.now() - started };
    } catch (error) {
      return {
        status: 'degraded',
        detail: error instanceof Error ? error.message : 'Unknown error',
        latencyMs: Date.now() - started,
      };
    }
  }

  const provider =
    config.provider === 'anthropic'
      ? new AnthropicChatProvider(apiKey, config.model)
      : new OpenAIChatProvider(apiKey, config.model);

  return provider.health();
}

/**
 * Resolves the provider a workspace has configured, falling back through: workspace
 * primary -> workspace fallback -> process default. A circuit-broken primary is skipped by
 * the repository, so a failing provider does not stall every request while it recovers.
 */
export async function providersForWorkspace(
  deps: AppDeps,
  tenant: {
    workspaceId: string;
    organizationId: string;
    userId: string;
    role: string;
    groupIds: readonly string[];
    traceId: string;
  },
): Promise<{ chat: ChatProvider; embeddings: EmbeddingProvider; chatConfigId: string | null }> {
  const ctx = tenant as never;

  const chatConfig = await deps.repos.settings.primaryFor(ctx, 'chat').catch(() => null);
  let chat = deps.services.chat;
  let chatConfigId: string | null = null;

  if (chatConfig && chatConfig.provider !== 'deterministic' && chatConfig.credentialEncrypted) {
    try {
      const apiKey = await decryptSecret(chatConfig.credentialEncrypted, deps.env.ENCRYPTION_KEY);
      chat =
        chatConfig.provider === 'anthropic'
          ? new AnthropicChatProvider(apiKey, chatConfig.model)
          : new OpenAIChatProvider(apiKey, chatConfig.model);
      chatConfigId = chatConfig.id;
    } catch {
      // An undecryptable credential must not take the workspace offline; the deterministic
      // engine still produces grounded answers.
      deps.logger.warn('provider.credential_unreadable', { configId: chatConfig.id });
    }
  }

  const embeddingConfig = await deps.repos.settings.primaryFor(ctx, 'embedding').catch(() => null);
  let embeddings = deps.services.embeddings;

  if (
    embeddingConfig &&
    embeddingConfig.provider === 'openai' &&
    embeddingConfig.credentialEncrypted
  ) {
    try {
      const apiKey = await decryptSecret(
        embeddingConfig.credentialEncrypted,
        deps.env.ENCRYPTION_KEY,
      );
      embeddings = new OpenAIEmbeddingProvider(apiKey, embeddingConfig.model);
    } catch {
      deps.logger.warn('provider.embedding_credential_unreadable', {
        configId: embeddingConfig.id,
      });
    }
  }

  return { chat, embeddings, chatConfigId };
}
