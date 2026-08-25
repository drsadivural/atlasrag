import type { ChatProvider, ComposeInput, ComposeResult, ProviderHealth } from './types.js';
import { normalizeWhitespace, splitSentences, contentTokens, lightStem } from '../text.js';

/**
 * The default answer composer: fully local and strictly extractive.
 *
 * It never writes a sentence that asserts something the sources do not say. Every
 * statement it returns is a verbatim sentence lifted from a retrieved excerpt, so the
 * citation attached to it is correct by construction and then re-verified downstream.
 * Only the connective framing (the headline and the one-line lead of the summary) is
 * composed, and that framing is limited to counting and naming what was found.
 *
 * This is why the product works end to end with no credentials configured, and why the
 * test suite can assert on exact answer content.
 */
export class DeterministicChatProvider implements ChatProvider {
  readonly id = 'deterministic' as const;
  readonly model = 'uxe-extractive-v1';
  readonly extractiveOnly = true;

  async compose(input: ComposeInput): Promise<ComposeResult> {
    const queryTerms = new Set(contentTokens(input.question).map(lightStem));

    const statements: Array<{ text: string; citationIds: string[] }> = [];
    const seen = new Set<string>();

    // Contradicting evidence is surfaced first: it is what changes a verdict.
    const ordered = [...input.evidence].sort((a, b) => {
      const order = { contradicts: 0, supports: 1, context: 2 } as const;
      return order[a.entailment] - order[b.entailment];
    });

    for (const item of ordered) {
      const best = splitSentences(item.excerpt)
        .map((sentence) => {
          const terms = contentTokens(sentence).map(lightStem);
          const hits = terms.filter((t) => queryTerms.has(t)).length;
          const density = terms.length === 0 ? 0 : hits / Math.sqrt(terms.length);
          const obligation = /\b(shall|must|shall not|must not|required|prohibited)\b/i.test(sentence)
            ? 0.3
            : 0;
          return { sentence: normalizeWhitespace(sentence), score: density + obligation };
        })
        .filter((s) => s.sentence.length >= 30)
        // Require some relation to the question. Quoting an unrelated but well-formed
        // sentence would pad the answer with text that does not address what was asked.
        .filter((s) => s.score > 0.05)
        .sort((a, b) => b.score - a.score)[0];

      // A heading fragment is not an assertion. Skip anything too short to stand alone
      // rather than presenting "Emergency lighting" as if it answered the question.
      const text = best?.sentence ?? normalizeWhitespace(item.excerpt);
      if (text.length < 30) continue;

      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      statements.push({ text, citationIds: [item.citationId] });
      if (statements.length >= 8) break;
    }

    const governing = new Set(
      input.evidence.filter((e) => e.role === 'governing').map((e) => e.documentTitle),
    );
    const project = new Set(
      input.evidence.filter((e) => e.role === 'project').map((e) => e.documentTitle),
    );

    const lead =
      input.evidence.length === 0
        ? 'No passage in the selected sources addresses this question.'
        : `Based on ${describeCount(governing.size, 'regulation', 'regulations')}${
            project.size > 0 ? ` and ${describeCount(project.size, 'project document', 'project documents')}` : ''
          }.`;

    const body = statements
      .slice(0, 5)
      .map((s) => s.text)
      .join(' ');

    return {
      headline: statements[0] ? truncate(statements[0].text, 110) : 'No supporting evidence found',
      summary: normalizeWhitespace(`${lead} ${body}`).slice(0, input.maxWords * 8),
      statements,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  async health(): Promise<ProviderHealth> {
    // Local, dependency-free, and therefore always available.
    return { status: 'healthy', detail: 'Local extractive engine', latencyMs: 0 };
  }
}

function describeCount(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}...`;
}
