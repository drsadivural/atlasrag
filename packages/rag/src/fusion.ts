import type { ChunkCandidate } from '@uxe/db';
import { contentTokens, jaccard, lightStem, normalizeForMatch } from './text.js';

export interface FusedCandidate extends ChunkCandidate {
  /** Reciprocal-rank-fusion score across the lexical and vector channels. */
  fusedScore: number;
  /** Post-rerank score in 0..1. This is what drives evidence selection. */
  rerankScore: number;
  channels: Array<'lexical' | 'vector' | 'locator'>;
  lexicalRank: number | null;
  vectorRank: number | null;
  /** Rank in the clause-number channel, when the query named one. */
  locatorRank: number | null;
}

/**
 * Reciprocal rank fusion.
 *
 * RRF is used rather than a weighted score blend because the two channels produce scores on
 * incomparable scales (`ts_rank_cd` is unbounded and corpus-dependent; cosine similarity is
 * bounded). Fusing on *rank* sidesteps that entirely and is robust when one channel returns
 * nothing at all — which happens routinely, e.g. a pure clause-number lookup has no useful
 * vector neighbours, and a paraphrased question has no lexical hits.
 *
 * `k` damps the influence of the very top ranks so a single confident channel cannot
 * completely dictate the merged order.
 */
export function reciprocalRankFusion(
  lists: Array<{
    channel: 'lexical' | 'vector' | 'locator';
    items: ChunkCandidate[];
    weight?: number;
  }>,
  k = 60,
): FusedCandidate[] {
  const merged = new Map<string, FusedCandidate>();

  for (const list of lists) {
    const weight = list.weight ?? 1;
    list.items.forEach((item, index) => {
      const rank = index + 1;
      const contribution = (weight * 1) / (k + rank);
      const existing = merged.get(item.chunkId);

      if (existing) {
        existing.fusedScore += contribution;
        if (!existing.channels.includes(list.channel)) existing.channels.push(list.channel);
        if (list.channel === 'lexical') existing.lexicalRank = rank;
        else if (list.channel === 'vector') existing.vectorRank = rank;
        else existing.locatorRank = rank;
        // Keep the strongest raw score seen for this chunk, for display and audit.
        existing.score = Math.max(existing.score, item.score);
      } else {
        merged.set(item.chunkId, {
          ...item,
          fusedScore: contribution,
          rerankScore: 0,
          channels: [list.channel],
          lexicalRank: list.channel === 'lexical' ? rank : null,
          vectorRank: list.channel === 'vector' ? rank : null,
          locatorRank: list.channel === 'locator' ? rank : null,
        });
      }
    });
  }

  return [...merged.values()].sort((a, b) => b.fusedScore - a.fusedScore);
}

export interface RerankOptions {
  /** Clause numbers or references pulled out of the query, e.g. ["6.4.2"]. */
  targetLocators?: string[];
  /** Boost chunks that are themselves obligations when the task is a compliance check. */
  preferRequirements?: boolean;
  now?: Date;
}

/**
 * Cross-feature reranking.
 *
 * A dedicated cross-encoder would score query/passage pairs jointly; this computes the same
 * family of signals explicitly so the result is deterministic, auditable and explainable —
 * which is what a compliance product actually needs. Each component is documented because
 * the number ends up in `rerankScore` on a stored citation.
 */
export function rerank(
  query: string,
  candidates: FusedCandidate[],
  options: RerankOptions = {},
): FusedCandidate[] {
  const queryTokens = contentTokens(query).map(lightStem);
  const querySet = new Set(queryTokens);
  const normalizedQuery = normalizeForMatch(query);
  const locators = options.targetLocators ?? extractLocators(query);
  const now = options.now ?? new Date();

  // Max fused score is used to normalise the retrieval component into 0..1.
  const maxFused = candidates.reduce((m, c) => Math.max(m, c.fusedScore), 0) || 1;

  const scored = candidates.map((candidate) => {
    const contentTokensList = contentTokens(candidate.content).map(lightStem);
    const contentSet = new Set(contentTokensList);
    const normalizedContent = normalizeForMatch(candidate.content);

    // 1. Lexical overlap between the query and the passage.
    const overlap = jaccard(querySet, contentSet);

    // 2. Coverage: what fraction of the query's content words appear at all. This is the
    //    strongest single signal for "does this passage actually address the question".
    const covered = queryTokens.filter((t) => contentSet.has(t)).length;
    const coverage = queryTokens.length === 0 ? 0 : covered / queryTokens.length;

    // 3. Proximity: query terms appearing close together beats them scattered across a
    //    long passage that happens to mention each once.
    const proximity = computeProximity(contentTokensList, querySet);

    // 4. Exact phrase presence is a very strong signal and cheap to test.
    const phraseBonus =
      normalizedQuery.length > 12 && normalizedContent.includes(normalizedQuery) ? 1 : 0;

    // 5. Locator match: asking about "6.4.2" should surface clause 6.4.2 above all else.
    const locatorMatch = locators.some(
      (loc) =>
        candidate.clause === loc ||
        candidate.section === loc ||
        candidate.chapter === loc ||
        normalizedContent.includes(loc.toLowerCase()),
    )
      ? 1
      : 0;

    // 6. Retrieval agreement: a chunk found by BOTH channels is more trustworthy than one
    //    found by either alone.
    const agreement = candidate.channels.length > 1 ? 1 : 0;

    // 7. Structural fit: clause- and table-kind chunks are better evidence than loose prose.
    const structural =
      candidate.clause !== null
        ? 1
        : candidate.kind === 'table'
          ? 0.8
          : candidate.section !== null
            ? 0.6
            : 0.3;

    // 8. Recency of the governing document, decayed over ten years.
    const recency = candidate.effectiveDate
      ? Math.max(
          0,
          1 - (now.getTime() - candidate.effectiveDate.getTime()) / (10 * 365 * 86_400_000),
        )
      : 0.5;

    // 9. Length sanity: very short chunks rarely stand alone as evidence; very long ones
    //    dilute the quote. Peaks around a paragraph.
    const lengthFit = lengthScore(candidate.content.length);

    const requirementBonus =
      options.preferRequirements && /\b(shall|must|shall not|must not)\b/i.test(candidate.content)
        ? 1
        : 0;

    const retrievalComponent = candidate.fusedScore / maxFused;

    const raw =
      0.24 * retrievalComponent +
      0.18 * coverage +
      0.1 * overlap +
      0.08 * proximity +
      0.09 * phraseBonus +
      0.11 * locatorMatch +
      0.05 * agreement +
      0.06 * structural +
      0.03 * recency +
      0.03 * lengthFit +
      0.03 * requirementBonus;

    return { ...candidate, rerankScore: clamp01(raw) };
  });

  return scored.sort((a, b) => b.rerankScore - a.rerankScore);
}

/** Pulls clause-like references out of a natural-language question. */
export function extractLocators(query: string): string[] {
  const found = locatorsByConfidence(query);
  return [...new Set([...found.named, ...found.bare])];
}

/**
 * Locators split by how sure we are that a number is one.
 *
 * `named` was introduced by a word — "clause 6.4.2", "section 5.2" — and is not in doubt.
 * `bare` is a dotted number standing on its own, which is usually a clause reference in a
 * question and is sometimes a measurement: "2.5" is a clause in "does 2.5 apply?" and a
 * width in "a 2.5 m corridor". Three or more components settle it, because dimensions are
 * not written 6.4.2.
 *
 * The distinction exists because the two are used differently. Reranking may use every
 * candidate locator, since it only reorders passages retrieval already found. Fetching
 * passages *by* locator may not: a measurement read as a clause number pulls in an
 * unrelated clause and pushes a real answer out of the results, which is what a small
 * regression on sentence-shaped queries turned out to be.
 */
export function locatorsByConfidence(query: string): { named: string[]; bare: string[] } {
  const named = new Set<string>();
  for (const m of query.matchAll(
    /\b(?:clause|section|article|chapter|annex|table|part)\s+([0-9A-Z]+(?:\.\d+)*)/gi,
  )) {
    if (m[1]) named.add(m[1]);
  }

  const bare = new Set<string>();
  for (const m of query.matchAll(/\b(\d{1,3}(?:\.\d{1,3}){1,4})\b/g)) {
    if (m[1] && !named.has(m[1])) bare.add(m[1]);
  }
  return { named: [...named], bare: [...bare] };
}

/** Locators confident enough to fetch passages by, rather than merely to rank with. */
export function retrievableLocators(query: string): string[] {
  const { named, bare } = locatorsByConfidence(query);
  const deep = bare.filter((locator) => locator.split('.').length >= 3);
  return [...new Set([...named, ...deep])];
}

function computeProximity(tokens: string[], querySet: Set<string>): number {
  const positions: number[] = [];
  tokens.forEach((t, i) => {
    if (querySet.has(t)) positions.push(i);
  });
  if (positions.length < 2) return positions.length === 1 ? 0.5 : 0;

  const span = (positions.at(-1) ?? 0) - (positions[0] ?? 0);
  if (span === 0) return 1;
  // Density of matches within their own span, normalised to 0..1.
  return clamp01(positions.length / (span + 1));
}

function lengthScore(chars: number): number {
  const ideal = 700;
  if (chars <= 0) return 0;
  const ratio = chars / ideal;
  return clamp01(ratio <= 1 ? ratio : 1 / ratio);
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Removes near-duplicate passages that would otherwise fill the evidence panel with the
 * same sentence quoted from three overlapping chunks. Keeps the highest-ranked instance.
 */
export function dedupeCandidates(candidates: FusedCandidate[], threshold = 0.82): FusedCandidate[] {
  const kept: Array<{ candidate: FusedCandidate; tokens: Set<string> }> = [];

  for (const candidate of candidates) {
    const tokens = new Set(contentTokens(candidate.content).map(lightStem));
    const duplicate = kept.some(
      (k) =>
        // Same clause in the same document version is definitionally the same evidence.
        (k.candidate.sourceVersionId === candidate.sourceVersionId &&
          k.candidate.clause !== null &&
          k.candidate.clause === candidate.clause) ||
        jaccard(k.tokens, tokens) >= threshold,
    );
    if (!duplicate) kept.push({ candidate, tokens });
  }

  return kept.map((k) => k.candidate);
}

/**
 * Ensures the evidence set is not monopolised by one document.
 *
 * Without this, a 1,300-page regulation with strong lexical overlap can crowd out the
 * customer's own project document entirely, and the review would then report "no project
 * evidence" purely as an artefact of ranking.
 */
export function diversify(
  candidates: FusedCandidate[],
  limit: number,
  maxPerSource = 4,
  /**
   * Ceiling on passages taken from a single page.
   *
   * A drawing set is one source with a dozen sheets, so a per-source cap alone lets the
   * whole evidence budget land on the sheet that ranked best and leaves the other eleven
   * unexamined — which reads in the report as "the drawing does not show it" when the
   * drawing shows it two sheets over. Capping per page forces the evidence to spread
   * across the sheets that matched at all.
   */
  maxPerPage = Number.POSITIVE_INFINITY,
): FusedCandidate[] {
  const perSource = new Map<string, number>();
  const perPage = new Map<string, number>();
  const picked: FusedCandidate[] = [];
  const overflow: FusedCandidate[] = [];

  for (const candidate of candidates) {
    const pageKey = `${candidate.sourceId}:${candidate.pageNumber ?? '-'}`;
    const usedBySource = perSource.get(candidate.sourceId) ?? 0;
    const usedByPage = perPage.get(pageKey) ?? 0;
    if (usedBySource < maxPerSource && usedByPage < maxPerPage) {
      picked.push(candidate);
      perSource.set(candidate.sourceId, usedBySource + 1);
      perPage.set(pageKey, usedByPage + 1);
      if (picked.length >= limit) return picked;
    } else {
      overflow.push(candidate);
    }
  }

  // Backfill from the overflow only once every source and page has had its fair share.
  for (const candidate of overflow) {
    if (picked.length >= limit) break;
    picked.push(candidate);
  }

  return picked;
}
