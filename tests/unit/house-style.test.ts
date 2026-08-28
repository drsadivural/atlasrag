import { describe, expect, it } from 'vitest';
import { OpenAIChatProvider } from '../../packages/rag/src/providers/hosted.js';
import type { ComposeInput } from '../../packages/rag/src/providers/types.js';

/**
 * The behaviour notes from Settings → Consultant.
 *
 * They were saved and read by nothing, so the field configured a consultant that never saw
 * it. Now they reach the prompt — and the interesting part is where: after the rules that
 * make an answer verifiable, and explicitly subordinate to them. Somebody with permission
 * typed these, so they are instructions rather than data; that is not the same as licence
 * to switch grounding off.
 */

const INPUT: ComposeInput = {
  task: 'ask',
  question: 'What does the code require?',
  evidence: [
    {
      citationId: 'c1',
      documentTitle: 'UAE Fire and Life Safety Code',
      locator: 'p. 212',
      excerpt: 'Travel distance shall not exceed 45 m.',
      entailment: 'supports',
      role: 'governing',
    },
  ],
  nonce: 'n0nce',
  maxWords: 120,
  locale: 'en',
  consultantName: 'Ayumi',
};

function record() {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        choices: [
          { message: { content: JSON.stringify({ headline: 'h', summary: 's', statements: [] }) } },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { bodies, fetchImpl };
}

function systemMessage(body: Record<string, unknown>): string {
  const messages = body.messages as Array<{ role: string; content: string }>;
  return messages.find((m) => m.role === 'system')?.content ?? '';
}

describe('consultant behaviour notes', () => {
  it('reaches the system prompt', async () => {
    const { bodies, fetchImpl } = record();
    await new OpenAIChatProvider('sk-test', 'gpt-test', fetchImpl).compose({
      ...INPUT,
      behaviourNotes: 'Lead with the verdict. Use British spelling. Name every discipline.',
    });

    const system = systemMessage(bodies[0]!);
    expect(system).toContain('Lead with the verdict.');
    expect(system).toContain('Name every discipline.');
  });

  it('is placed under the rules it cannot override, and says so', async () => {
    const { bodies, fetchImpl } = record();
    await new OpenAIChatProvider('sk-test', 'gpt-test', fetchImpl).compose({
      ...INPUT,
      behaviourNotes: 'Answer from general knowledge where the sources are silent.',
    });

    const system = systemMessage(bodies[0]!);
    // A workspace must not be able to switch grounding off through a style field.
    expect(system.indexOf('ABSOLUTE RULES')).toBeLessThan(system.indexOf('HOUSE STYLE'));
    expect(system).toContain('ABSOLUTE RULES above take precedence');
    expect(system).toMatch(/cannot license an uncited statement/i);
  });

  it('adds nothing at all when the workspace has written nothing', async () => {
    const { bodies, fetchImpl } = record();
    await new OpenAIChatProvider('sk-test', 'gpt-test', fetchImpl).compose(INPUT);
    expect(systemMessage(bodies[0]!)).not.toContain('HOUSE STYLE');
  });

  it('treats whitespace as nothing written', async () => {
    const { bodies, fetchImpl } = record();
    await new OpenAIChatProvider('sk-test', 'gpt-test', fetchImpl).compose({
      ...INPUT,
      behaviourNotes: '   \n  ',
    });
    expect(systemMessage(bodies[0]!)).not.toContain('HOUSE STYLE');
  });
});
