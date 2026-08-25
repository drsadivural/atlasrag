# Retrieval and grounding evaluation

How the answering quality of UXE Consulting AI is measured, what the thresholds are, and
where the numbers come from.

## Principle

Every metric here is asserted in an automated test. A regression fails the build; it does
not appear as a number in a dashboard that nobody reads.

```bash
pnpm vitest run --project rag-evals
```

## The gold set

`tests/rag-evals/retrieval.eval.test.ts` holds a hand-labelled set of questions against two
fixture documents:

- **UAE Fire and Life Safety Code (extract)** — the governing regulation, with numbered
  clauses 6.4.1 through 6.6.1.
- **Marina Tower Evacuation Plan** — the project document under review, containing both
  compliant and non-compliant values.

Each case names the phrase that must appear in a retrieved passage, so a human reading the
file can check the label without running anything.

The set is deliberately small and readable rather than large and opaque. Its purpose is
regression detection on the behaviours the product depends on, not a leaderboard score.

## Metrics and thresholds

| Metric                        | Threshold       | Why that number                                                                                          |
| ----------------------------- | --------------- | -------------------------------------------------------------------------------------------------------- |
| Recall@5                      | ≥ 80%           | Below this, the answer engine is working from the wrong passages and no amount of downstream care helps. |
| nDCG@5                        | ≥ 0.70          | Rewards putting the right passage first; the top passage is what the Yes/No view quotes.                 |
| Quoted-text verification rate | **100%**        | A single unverifiable quotation breaks the product's central promise.                                    |
| Locator accuracy              | **100%**        | A quote pointing at the wrong page is worse than no citation.                                            |
| Cross-tenant leakage          | **0**           | Not a rate. One leaked passage is a release blocker.                                                     |
| Requirement coverage          | 100%            | Every extracted mandatory requirement is either assessed or explicitly recorded as needing evidence.     |
| False compliance              | 0               | A `compliant` verdict without a verified citation behind it fails the suite.                             |
| Correct abstention            | Asserted        | A question the corpus cannot answer must not receive a confident answer.                                 |
| Retrieval latency p50 / p95   | < 1.5 s / < 4 s | The interactive budget from section 21 of the brief.                                                     |

The two 100% thresholds are not aspirational. They are enforceable because verification is
mechanical: an excerpt is either present in the stored page text or it is not.

## Measured results

From a real run against the fixture corpus (`pnpm test:rag-evals`, 2026-08-25):

| Metric                      | Threshold       | Measured                   |
| --------------------------- | --------------- | -------------------------- |
| Recall@5                    | ≥ 80%           | **100%** (5/5)             |
| nDCG@5                      | ≥ 0.70          | **0.926**                  |
| Quoted-text verification    | 100%            | **100%** over 30 citations |
| Locator accuracy            | 100%            | **100%** over 30 citations |
| Requirement coverage        | 100%            | **100%** (4/4)             |
| Retrieval latency p50 / p95 | < 1.5 s / < 4 s | **5 ms / 8 ms**            |

The latency figures are against a local PostgreSQL on the same host; Hyperdrive and a
managed database change the constant, not the shape. They are reported because a
five-millisecond p50 says something useful: retrieval is not the bottleneck, so a slow
answer is an extraction or generation problem, not an index problem.

## How each is computed

**Recall@K** — the fraction of gold questions for which the expected phrase appears in any
of the top K retrieved passages.

**nDCG@K** — binary relevance, `DCG = 1 / log2(rank + 2)` for the first relevant passage,
ideal `1`. Averaged over the gold set.

**Quoted-text verification** — for every citation the engine produced, the stored page text
is fetched through the real `/citations/:id` endpoint and asserted to contain the excerpt.

**Locator accuracy** — the same response's `highlight` offsets are sliced out of the page
text and compared to the excerpt character for character.

**Requirement coverage** — `assessed / extracted` over a real compliance review, where
`assessed` is the number of distinct requirement identifiers appearing in the findings.

**Cross-tenant leakage** — a second tenant asks a question whose answer exists only in the
first tenant's documents, and every returned citation is checked against the first tenant's
source identifiers. Also asserted textually, so a passage cannot leak under a different
identifier.

## The answering engine

The default engine is deterministic and extractive: it selects sentences from retrieved
passages rather than generating prose. Two consequences:

1. It cannot hallucinate, because it never writes a sentence that was not already in a
   document or in the fixed schema.
2. Its output is reproducible — the same corpus and the same question produce the same
   answer, which is what makes these thresholds meaningful as regression tests.

Hosted providers (Anthropic, OpenAI) implement the same `ChatProvider` interface and are
subject to the identical verification gate. Enabling one does not relax any threshold; a
fabricated quotation from a frontier model is discarded on exactly the same code path.

## Cost

The deterministic engine's marginal cost per answer is one embedding pass over the question
plus the database work — no external API call, and therefore no per-token cost. When a
hosted provider is configured, token usage is recorded per message and surfaced in the
activity log, so cost per consultation is measurable rather than estimated.

## Known limitations

- The gold set covers fire-safety egress requirements. A customer in another domain should
  extend it; the file is structured so adding a case is three lines.
- nDCG uses binary relevance. Graded relevance would be more informative but requires
  labelling effort that would go stale as the corpus changes.
- Latency is measured against a local PostgreSQL. Hyperdrive changes the constant, not the
  shape.
- OCR quality is measured (confidence is recorded per version) but not thresholded: a
  genuinely poor scan should still be ingestible, with its confidence shown, rather than
  refused.

## Adding a case

```ts
const GOLD: GoldCase[] = [
  // ...
  {
    question: 'What is the minimum width of an escape stair?',
    expected: '1.1 m',
    clause: '6.7.2',
  },
];
```

If the new case fails, the retrieval configuration needs work — not the threshold.
