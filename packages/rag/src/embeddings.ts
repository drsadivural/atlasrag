import { charNgrams, contentTokens, fnv1a, lightStem } from './text.js';

export const EMBEDDING_DIMENSIONS = 768;

export interface EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * A deterministic, dependency-free embedding.
 *
 * It is a signed random projection of a weighted bag of stemmed tokens, token bigrams and
 * character n-grams. Each feature is hashed to a bucket and a sign, then accumulated and
 * L2-normalised, so cosine similarity behaves the way pgvector expects.
 *
 * Why this exists rather than a stub: retrieval must actually work in every environment,
 * including CI with no credentials and no network. Character n-grams give it robustness to
 * OCR noise and morphology, and token bigrams give it a little word-order sensitivity —
 * enough that "exit width" and "width of exit" land near each other while "exit" alone does
 * not dominate. A hosted embedding model is strictly better at paraphrase, which is why the
 * OpenAI adapter below exists and is used whenever a key is configured; the lexical half of
 * hybrid retrieval carries exact clause and term matching regardless of which is active.
 */
export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'deterministic';
  readonly model = 'uxe-hashed-ngram-v1';
  readonly dimensions = EMBEDDING_DIMENSIONS;

  constructor(private readonly dims: number = EMBEDDING_DIMENSIONS) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  embedOne(text: string): number[] {
    const vector = new Float64Array(this.dims);
    const tokens = contentTokens(text).map(lightStem);
    if (tokens.length === 0) return Array.from(vector);

    // Sublinear term frequency damping, the same idea as the `1 + log(tf)` in TF-IDF:
    // a word repeated 50 times should not swamp the vector.
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);

    const addFeature = (feature: string, weight: number) => {
      const h = fnv1a(feature);
      const bucket = h % this.dims;
      // The low bit of a second hash gives an unbiased sign, so unrelated features
      // cancel rather than accumulate.
      const sign = (fnv1a(`s:${feature}`) & 1) === 0 ? 1 : -1;
      vector[bucket] = (vector[bucket] ?? 0) + sign * weight;
    };

    for (const [token, count] of counts) {
      const tf = 1 + Math.log(count);
      addFeature(`t:${token}`, tf * 1.0);
      // Character n-grams: weaker individually, but they make the vector degrade
      // gracefully when OCR mangles a character.
      for (const gram of charNgrams(token)) addFeature(`g:${gram}`, tf * 0.22);
    }

    for (let i = 0; i + 1 < tokens.length; i += 1) {
      addFeature(`b:${tokens[i]}_${tokens[i + 1]}`, 0.6);
    }

    let norm = 0;
    for (let i = 0; i < this.dims; i += 1) norm += (vector[i] ?? 0) ** 2;
    norm = Math.sqrt(norm);
    if (norm === 0) return Array.from(vector);

    const out = new Array<number>(this.dims);
    for (let i = 0; i < this.dims; i += 1) out[i] = (vector[i] ?? 0) / norm;
    return out;
  }
}

/** OpenAI embeddings, projected down to the column width when the model is wider. */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'openai';
  readonly dimensions = EMBEDDING_DIMENSIONS;

  constructor(
    private readonly apiKey: string,
    readonly model = 'text-embedding-3-small',
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = 'https://api.openai.com/v1',
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        // Requesting the exact width avoids a lossy client-side projection.
        dimensions: EMBEDDING_DIMENSIONS,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new EmbeddingProviderError(
        `OpenAI embeddings failed: ${response.status}`,
        response.status,
        body.slice(0, 400),
      );
    }

    const json = (await response.json()) as { data: Array<{ embedding: number[]; index: number }> };
    const ordered = [...json.data].sort((a, b) => a.index - b.index);
    return ordered.map((d) => normalizeVector(d.embedding, EMBEDDING_DIMENSIONS));
  }
}

export class EmbeddingProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(message);
    this.name = 'EmbeddingProviderError';
  }
}

/** Retryable when the provider is rate limited or temporarily unavailable. */
export function isRetryableProviderStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function normalizeVector(vector: number[], dims: number): number[] {
  const out = new Array<number>(dims).fill(0);
  // Fold rather than truncate, so no dimension of the source vector is thrown away.
  for (let i = 0; i < vector.length; i += 1) {
    const target = i % dims;
    out[target] = (out[target] ?? 0) + (vector[i] ?? 0);
  }
  let norm = 0;
  for (const v of out) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return out;
  return out.map((v) => v / norm);
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
