export interface EvidenceForComposition {
  citationId: string;
  documentTitle: string;
  locator: string;
  excerpt: string;
  entailment: 'supports' | 'contradicts' | 'context';
  role: 'governing' | 'project';
}

export interface ComposeInput {
  task: 'ask' | 'summarize' | 'check_compliance' | 'correct_document';
  question: string;
  evidence: EvidenceForComposition[];
  /** Nonce used to fence the untrusted data channel; regenerated per request. */
  nonce: string;
  maxWords: number;
  locale: string;
  consultantName: string;
}

export interface ComposeResult {
  headline: string;
  summary: string;
  /**
   * Sentences the provider asserts, each tagged with the citations it claims support it.
   * The pipeline re-verifies every one; anything unsupported is dropped or labelled, so a
   * provider cannot smuggle an unsupported statement into a persisted answer.
   */
  statements: Array<{ text: string; citationIds: string[] }>;
  usage: { inputTokens: number; outputTokens: number };
}

export interface ProviderHealth {
  status: 'healthy' | 'degraded' | 'unconfigured' | 'circuit_open' | 'unknown';
  detail: string | null;
  latencyMs: number | null;
}

export interface ChatProvider {
  readonly id: 'deterministic' | 'anthropic' | 'openai';
  readonly model: string;
  /** True when this provider can only quote retrieved evidence and never free-writes. */
  readonly extractiveOnly: boolean;
  compose(input: ComposeInput): Promise<ComposeResult>;
  health(): Promise<ProviderHealth>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'unauthorized'
      | 'forbidden'
      | 'rate_limited'
      | 'quota_exhausted'
      | 'unsupported_model'
      | 'unavailable'
      | 'timeout'
      | 'invalid_response',
    readonly retryable: boolean,
    readonly status: number | null = null,
    readonly detail: string | null = null,
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  /** Maps an HTTP status onto an actionable, user-facing provider error. */
  static fromStatus(status: number, body: string): ProviderError {
    if (status === 401) {
      return new ProviderError(
        'The provider rejected the configured credential.',
        'unauthorized',
        false,
        status,
        'Check the API key in Settings > Models; it may have been revoked or rotated.',
      );
    }
    if (status === 403) {
      return new ProviderError(
        'The credential lacks the scopes needed for this model.',
        'forbidden',
        false,
        status,
        'Grant the key access to the selected model, or choose a model the key can use.',
      );
    }
    if (status === 404) {
      return new ProviderError(
        'The configured model does not exist for this account.',
        'unsupported_model',
        false,
        status,
        body.slice(0, 300),
      );
    }
    if (status === 429) {
      const quota = /quota|billing|credit|insufficient_quota/i.test(body);
      return new ProviderError(
        quota
          ? 'The provider account has exhausted its quota.'
          : 'The provider is rate limiting this workspace.',
        quota ? 'quota_exhausted' : 'rate_limited',
        !quota,
        status,
        body.slice(0, 300),
      );
    }
    if (status >= 500) {
      return new ProviderError(
        'The provider is temporarily unavailable.',
        'unavailable',
        true,
        status,
        body.slice(0, 300),
      );
    }
    return new ProviderError(
      `The provider returned an unexpected response (${status}).`,
      'invalid_response',
      false,
      status,
      body.slice(0, 300),
    );
  }
}
