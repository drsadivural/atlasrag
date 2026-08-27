import { describe, expect, it } from 'vitest';
import { OpenAIChatProvider } from '../../packages/rag/src/providers/hosted.js';
import { ProviderError } from '../../packages/rag/src/providers/types.js';
import type { ComposeInput } from '../../packages/rag/src/providers/types.js';

/**
 * How hard the model is asked to think, and what happens when it will not be asked.
 *
 * The levels here are the provider's own, read from its API rather than assumed — it
 * rejects anything else by name. The interesting part is the two failure modes that
 * follow: a model with no reasoning mode refuses `temperature`, which is nobody's
 * instruction and can be dropped; and a model that refuses the effort itself is refusing
 * somebody's setting, which cannot be.
 */

const INPUT: ComposeInput = {
  task: 'ask',
  question: 'What travel distance does the code allow?',
  evidence: [
    {
      citationId: 'c1',
      documentTitle: 'UAE Fire and Life Safety Code',
      locator: 'p. 212',
      excerpt: 'Travel distance to an exit shall not exceed 45 m.',
      entailment: 'supports',
      role: 'governing',
    },
  ],
  nonce: 'n0nce',
  maxWords: 120,
  locale: 'en',
  consultantName: 'Ayumi',
};

const ANSWER = JSON.stringify({
  headline: 'Forty-five metres.',
  summary: 'The code caps travel distance at 45 m.',
  statements: [{ text: 'Travel distance shall not exceed 45 m.', citationIds: ['c1'] }],
});

function ok(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: ANSWER } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function refuses(param: string, code = 'unsupported_parameter'): Response {
  return new Response(
    JSON.stringify({ error: { message: `Unsupported parameter: '${param}'.`, param, code } }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  );
}

function record() {
  const bodies: Array<Record<string, unknown>> = [];
  const respond: Array<() => Response> = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return (respond.shift() ?? ok)();
  }) as unknown as typeof fetch;
  return { bodies, respond, fetchImpl };
}

describe('OpenAIChatProvider reasoning effort', () => {
  it('sends nothing at all when no effort is configured', async () => {
    const { bodies, fetchImpl } = record();
    await new OpenAIChatProvider('sk-test', 'gpt-5.6-sol', fetchImpl).compose(INPUT);

    // Absent, not 'none'. A model with no reasoning mode rejects the parameter outright,
    // so an unset setting must not become a value.
    expect(bodies[0]).not.toHaveProperty('reasoning_effort');
  });

  it('passes the configured level through verbatim', async () => {
    const { bodies, fetchImpl } = record();
    await new OpenAIChatProvider(
      'sk-test',
      'gpt-5.6-sol',
      fetchImpl,
      undefined,
      undefined,
      'xhigh',
    ).compose(INPUT);

    expect(bodies[0]?.reasoning_effort).toBe('xhigh');
  });

  it('drops temperature and retries when the model refuses it', async () => {
    const { bodies, respond, fetchImpl } = record();
    respond.push(() => refuses('temperature'), ok);

    const result = await new OpenAIChatProvider(
      'sk-test',
      'gpt-5.6-sol',
      fetchImpl,
      undefined,
      undefined,
      'high',
    ).compose(INPUT);

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toHaveProperty('temperature', 0);
    expect(bodies[1]).not.toHaveProperty('temperature');
    // The setting that came from a person survives the retry; only the one this code
    // invented is given up.
    expect(bodies[1]?.reasoning_effort).toBe('high');
    expect(result.headline).toBe('Forty-five metres.');
  });

  it('retries at most once, and reports the second failure', async () => {
    const { bodies, respond, fetchImpl } = record();
    respond.push(
      () => refuses('temperature'),
      () => refuses('temperature'),
    );

    await expect(
      new OpenAIChatProvider('sk-test', 'gpt-5.6-sol', fetchImpl).compose(INPUT),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(bodies).toHaveLength(2);
  });

  it('surfaces a refused effort rather than quietly answering at another depth', async () => {
    const { bodies, respond, fetchImpl } = record();
    respond.push(() => refuses('reasoning_effort', 'unsupported_value'));

    await expect(
      new OpenAIChatProvider(
        'sk-test',
        'gpt-4.1',
        fetchImpl,
        undefined,
        undefined,
        'xhigh',
      ).compose(INPUT),
    ).rejects.toBeInstanceOf(ProviderError);

    // No second attempt: answering at a depth nobody chose would be worse than failing.
    expect(bodies).toHaveLength(1);
  });
});
