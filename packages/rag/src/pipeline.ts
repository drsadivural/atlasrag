import type {
  AnswerStyle,
  Citation,
  Claim,
  Finding,
  Requirement,
  StructuredAnswer,
  TaskMode,
} from '@uxe/contracts';
import { formatLocator } from '@uxe/contracts';
import type { ChunkCandidate, RetrievalRepository, TenantContext } from '@uxe/db';
import type { EmbeddingProvider } from './embeddings.js';
import type { ChatProvider, EvidenceForComposition } from './providers/types.js';
import {
  dedupeCandidates,
  diversify,
  extractLocators,
  retrievableLocators,
  reciprocalRankFusion,
  rerank,
  type FusedCandidate,
} from './fusion.js';
import {
  draftCitation,
  extractQuantities,
  finalizeCitation,
  verifyExcerpt,
  type PageRecord,
} from './citations.js';
import {
  computeConfidence,
  computeEvidenceCoverage,
  shouldAbstain,
  sourceAuthorityScore,
} from './confidence.js';
import {
  aggregateRisk,
  buildRequirementSet,
  exemptiveClauses,
  decideOverall,
  evaluateRequirement,
  quantitySatisfies,
  scoreRequirementEvidence,
  type RequirementDraft,
} from './compliance.js';
import {
  assembleAnswer,
  buildExtractiveClaims,
  extractiveSummary,
  type DocumentReviewed,
} from './answer.js';
import { detectInjection, shouldQuarantine } from './injection.js';
import {
  appliesAtHeight,
  bandLabel,
  deriveBuildingAttributes,
  type BuildingAttributes,
  heightCondition,
  type HeightCondition,
} from './derive.js';
import {
  clauseDiscipline,
  describeDisciplines,
  disciplineLabel,
  isInScope,
  profileDisciplines,
  profileText,
  type Discipline,
} from './discipline.js';
import { contentTokens, lightStem, normalizeForMatch, normalizeWhitespace } from './text.js';

export interface SourceScope {
  sourceId: string;
  sourceVersionId: string;
  role: 'governing' | 'project';
  title: string;
  version: string;
  pages: number | null;
  effectiveDate: Date | null;
  tags: string[];
  promoted: boolean;
  superseded: boolean;
}

export interface RetrieveOptions {
  /** Candidates pulled from each channel before fusion. */
  channelLimit?: number;
  /** Evidence passages kept after reranking and diversification. */
  finalLimit?: number;
  maxPerSource?: number;
  /** Ceiling on passages taken from any one page, so evidence spans a drawing's sheets. */
  maxPerPage?: number;
  preferRequirements?: boolean;
  /** Restrict retrieval to a subset of the scope, e.g. only the project documents. */
  roles?: Array<'governing' | 'project'>;
}

export interface RetrievalTelemetry {
  lexicalCandidates: number;
  vectorCandidates: number;
  /** Chunks matched by clause number. Zero unless the query named one. */
  locatorCandidates: number;
  /**
   * True when the vector channel returned nothing and the corpus is embedded under a
   * different model — the signature of an embedding provider changed without re-indexing.
   */
  vectorIndexMismatch: boolean;
  fusedCandidates: number;
  afterDedupe: number;
  finalCandidates: number;
  durationMs: number;
  embeddingModel: string;
  expandedQuery: string;
}

export interface RetrievalOutcome {
  candidates: FusedCandidate[];
  telemetry: RetrievalTelemetry;
}

/**
 * Hybrid retrieval.
 *
 * Order matters and is fixed by section 13 of the brief:
 *   1. permissions are already resolved by the caller (the scope it passes is the ACL
 *      result, so this function can never widen access);
 *   2. the query is expanded with locators and source vocabulary;
 *   3. lexical and vector search run against the same permitted version set;
 *   4. results are fused, reranked, deduplicated and diversified.
 */
export async function retrieve(
  ctx: TenantContext,
  repo: RetrievalRepository,
  embedder: EmbeddingProvider,
  query: string,
  scope: SourceScope[],
  options: RetrieveOptions = {},
): Promise<RetrievalOutcome> {
  const started = Date.now();
  const channelLimit = options.channelLimit ?? 40;
  const finalLimit = options.finalLimit ?? 12;

  const inScope = options.roles ? scope.filter((s) => options.roles?.includes(s.role)) : scope;
  const versionIds = inScope.map((s) => s.sourceVersionId);

  if (versionIds.length === 0) {
    return {
      candidates: [],
      telemetry: {
        lexicalCandidates: 0,
        vectorCandidates: 0,
        locatorCandidates: 0,
        vectorIndexMismatch: false,
        fusedCandidates: 0,
        afterDedupe: 0,
        finalCandidates: 0,
        durationMs: Date.now() - started,
        embeddingModel: embedder.model,
        expandedQuery: query,
      },
    };
  }

  const expandedQuery = expandQuery(query, inScope);
  const locators = extractLocators(query);
  // Ranking may use every candidate locator; fetching by one may not. See the note there.
  const fetchable = retrievableLocators(query);

  const [lexical, embedding, locatorHits] = await Promise.all([
    repo.lexicalSearch(ctx, { sourceVersionIds: versionIds }, expandedQuery, channelLimit),
    embedder.embed([expandedQuery]).then((v) => v[0] ?? []),
    /*
     * A third channel, and only when the query names a clause.
     *
     * It reads the clause column rather than searching text, which is the only way this
     * lookup can be reliable: the indexer lifts "6.4.2" out of the heading into its own
     * column and the body does not repeat it, so on a real code the number is absent from
     * the indexed text of all but a handful of the chunks that carry one. Both text
     * channels were searching for a string that is not there.
     */
    repo.locatorSearch(ctx, { sourceVersionIds: versionIds }, fetchable, channelLimit),
  ]);

  const vector = await repo.vectorSearch(
    ctx,
    { sourceVersionIds: versionIds },
    embedding,
    embedder.model,
    channelLimit,
  );

  /*
   * Half the retrieval going missing should not be silent.
   *
   * Embeddings are stored per model and searched per model, so changing the embedding
   * provider without re-embedding the corpus returns zero vector rows for every query
   * forever. Answers keep coming — the lexical half still works — and nothing says that
   * paraphrase matching has stopped. Only asked when the channel came back empty, so the
   * usual path costs nothing.
   */
  const vectorIndexMismatch =
    vector.length === 0
      ? await repo.embeddedUnderOtherModel(ctx, { sourceVersionIds: versionIds }, embedder.model)
      : false;

  const fused = reciprocalRankFusion([
    { channel: 'lexical', items: lexical, weight: 1 },
    { channel: 'vector', items: vector, weight: 1 },
    /*
     * Weighted above the text channels because it is not a guess. An exact match on a
     * parsed identifier is the strongest evidence available that this is the clause asked
     * for, and it is the difference between a clause lookup landing first and not landing
     * at all. It contributes nothing when the query names no clause.
     */
    { channel: 'locator', items: locatorHits, weight: 2 },
  ]);

  const ranked = rerank(query, fused, {
    targetLocators: locators,
    preferRequirements: options.preferRequirements ?? false,
  });

  const deduped = dedupeCandidates(ranked);
  const finalCandidates = diversify(
    deduped,
    finalLimit,
    options.maxPerSource ?? 4,
    options.maxPerPage,
  );

  return {
    candidates: finalCandidates,
    telemetry: {
      lexicalCandidates: lexical.length,
      vectorCandidates: vector.length,
      locatorCandidates: locatorHits.length,
      vectorIndexMismatch,
      fusedCandidates: fused.length,
      afterDedupe: deduped.length,
      finalCandidates: finalCandidates.length,
      durationMs: Date.now() - started,
      embeddingModel: embedder.model,
      expandedQuery,
    },
  };
}

/**
 * Expands the query with defined terms and locators.
 *
 * Adding the governing document titles helps the lexical channel when a user asks
 * "does this comply?" with no domain words at all, which would otherwise retrieve nothing.
 */
export function expandQuery(query: string, scope: SourceScope[]): string {
  const parts = [query];
  const locators = extractLocators(query);
  for (const locator of locators) parts.push(`clause ${locator}`, `section ${locator}`);

  const normalized = normalizeForMatch(query);
  const contentWords = normalized.split(' ').filter((w) => w.length > 3);
  if (contentWords.length <= 2) {
    // A very short query gets the scope's own vocabulary so retrieval has something to match.
    for (const source of scope.slice(0, 4)) parts.push(source.title);
  }

  return normalizeWhitespace(parts.join(' ')).slice(0, 1200);
}

/* -------------------------------------------------------------------------- */
/* Citation building and verification                                         */
/* -------------------------------------------------------------------------- */

export interface BuildCitationsResult {
  citations: Citation[];
  citationIdByChunk: Map<string, string>;
  /** Citations whose excerpt could not be found in the stored source text. */
  failures: Array<{ citationId: string; reason: string }>;
}

/**
 * Turns retrieved passages into verified citation records.
 *
 * Verification is not optional and not sampled: every citation's excerpt is re-checked
 * against the stored page text for the exact page it claims. A failure downgrades that
 * citation to unverified with a stated reason; it never silently becomes a green check.
 */
export async function buildAndVerifyCitations(
  ctx: TenantContext,
  repo: RetrievalRepository,
  candidates: FusedCandidate[],
  query: string,
  idFactory: () => string,
  claimByChunk?: Map<string, string>,
): Promise<BuildCitationsResult> {
  const citations: Citation[] = [];
  const citationIdByChunk = new Map<string, string>();
  const failures: Array<{ citationId: string; reason: string }> = [];

  // Page loads are memoised: a 1,300-page regulation will typically supply several
  // passages from a handful of pages.
  const pageCache = new Map<string, PageRecord | null>();

  for (const candidate of candidates) {
    const citationId = idFactory();
    const draft = draftCitation(candidate, query, citationId, claimByChunk?.get(candidate.chunkId));

    let page: PageRecord | null = null;
    if (draft.pageNumber !== null) {
      const key = `${candidate.sourceVersionId}:${draft.pageNumber}`;
      if (pageCache.has(key)) {
        page = pageCache.get(key) ?? null;
      } else {
        const row = await repo.getPage(ctx, candidate.sourceVersionId, draft.pageNumber);
        page = row
          ? {
              pageNumber: row.pageNumber,
              text: row.text,
              width: row.width,
              height: row.height,
              wordBoxes: row.wordBoxes,
            }
          : null;
        pageCache.set(key, page);
      }
    }

    const verification = verifyExcerpt(draft.supportingExcerpt, page);
    const citation = finalizeCitation(draft, verification, ctx.organizationId);

    if (!verification.verified && verification.reason) {
      failures.push({ citationId, reason: verification.reason });
    }

    citations.push(citation);
    citationIdByChunk.set(candidate.chunkId, citationId);
  }

  return { citations, citationIdByChunk, failures };
}

/* -------------------------------------------------------------------------- */
/* Answering                                                                  */
/* -------------------------------------------------------------------------- */

export interface AnswerOptions {
  task: TaskMode;
  answerStyle: AnswerStyle;
  knowledgeOnly: boolean;
  askWhenUncertain: boolean;
  generalModelFallback: boolean;
  minimumEvidenceThreshold: number;
  consultantName: string;
  /** House style from Settings → Consultant. Subordinate to the grounding rules. */
  behaviourNotes?: string | null;
  locale: string;
  idFactory: () => string;
  nonce: string;
}

export interface AnswerResult {
  answer: StructuredAnswer;
  telemetry: RetrievalTelemetry & {
    verifiedCitations: number;
    unverifiedCitations: number;
    providerTokens: number;
  };
}

/**
 * Answers a question against the permitted sources.
 *
 * The provider's prose is treated as a *draft*: every statement it returns must map to a
 * citation that survived verification, or it is discarded. That is what allows a hosted
 * model to be used without weakening the evidence guarantee.
 */
export async function answerQuestion(
  ctx: TenantContext,
  deps: { repo: RetrievalRepository; embedder: EmbeddingProvider; chat: ChatProvider },
  question: string,
  scope: SourceScope[],
  options: AnswerOptions,
): Promise<AnswerResult> {
  const finalLimit = options.answerStyle === 'details' ? 16 : 10;

  /*
   * Both sides of the comparison, retrieved separately.
   *
   * A consultation that has a document under review is asking a comparative question:
   * what do the regulations require, and what does this document say about it. Ranking
   * both corpora together answers only the first half — a thousand-page code has hundreds
   * of passages about any given topic and a three-page submittal has one, so the code
   * takes every slot and the answer comes back quoting the regulation with nothing at all
   * to say about the file the reader just uploaded.
   *
   * Each role therefore gets its own retrieval and its own guaranteed share. The project
   * side is given a third of the slots rather than half: it is the smaller corpus, and the
   * obligation still has to be quoted in full for the finding to mean anything.
   */
  const hasProject = scope.some((s) => s.role === 'project');
  const hasGoverning = scope.some((s) => s.role === 'governing');

  const retrieval =
    hasProject && hasGoverning
      ? mergeRetrievals(
          await retrieve(ctx, deps.repo, deps.embedder, question, scope, {
            roles: ['governing'],
            finalLimit: finalLimit - Math.max(2, Math.round(finalLimit / 3)),
          }),
          await retrieve(ctx, deps.repo, deps.embedder, question, scope, {
            roles: ['project'],
            finalLimit: Math.max(2, Math.round(finalLimit / 3)),
          }),
        )
      : await retrieve(ctx, deps.repo, deps.embedder, question, scope, { finalLimit });

  // Classify every passage against the question itself, so `entailment` reflects whether
  // the passage supports or contradicts what was asked rather than defaulting to context.
  const claimByChunk = new Map(retrieval.candidates.map((c) => [c.chunkId, question]));

  const { citations, citationIdByChunk, failures } = await buildAndVerifyCitations(
    ctx,
    deps.repo,
    retrieval.candidates,
    question,
    options.idFactory,
    claimByChunk,
  );

  const verified = citations.filter((c) => c.verified);
  const verifiedIds = new Set(verified.map((c) => c.citationId));
  const scopeById = new Map(scope.map((s) => [s.sourceId, s]));

  const evidence: EvidenceForComposition[] = retrieval.candidates
    .map((candidate) => {
      const citationId = citationIdByChunk.get(candidate.chunkId);
      const citation = citations.find((c) => c.citationId === citationId);
      if (!citation || !citation.verified) return null;
      return {
        citationId: citation.citationId,
        documentTitle: citation.documentTitle,
        locator: formatLocator(citation),
        excerpt: citation.supportingExcerpt,
        entailment: citation.entailment,
        role: scopeById.get(candidate.sourceId)?.role ?? 'governing',
      } satisfies EvidenceForComposition;
    })
    .filter((e): e is EvidenceForComposition => e !== null);

  let composed = {
    headline: '',
    summary: '',
    statements: [] as Array<{ text: string; citationIds: string[] }>,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  if (evidence.length > 0) {
    composed = await deps.chat.compose({
      task: options.task === 'correct_document' ? 'ask' : options.task,
      question,
      evidence,
      nonce: options.nonce,
      maxWords:
        options.answerStyle === 'yes_no' ? 60 : options.answerStyle === 'optimal' ? 300 : 800,
      locale: options.locale,
      consultantName: options.consultantName,
      behaviourNotes: options.behaviourNotes,
    });
  }

  // Every statement must resolve to at least one VERIFIED citation. This is where an
  // unsupported sentence from a hosted model is caught and dropped.
  const claims: Claim[] = composed.statements
    .map((statement) => {
      const supportedIds = statement.citationIds.filter((id) => verifiedIds.has(id));
      return {
        claimId: options.idFactory(),
        text: statement.text,
        citationIds: supportedIds,
        supported: supportedIds.length > 0,
        fromGeneralModel: false,
      } satisfies Claim;
    })
    .filter((claim) => claim.supported || options.generalModelFallback);

  // If the provider produced nothing usable, fall back to selecting sentences directly
  // from the verified passages so the user still gets a grounded answer.
  const finalClaims =
    claims.filter((c) => c.supported).length > 0
      ? claims
      : buildExtractiveClaims({
          question,
          candidates: retrieval.candidates.filter((c) => {
            const id = citationIdByChunk.get(c.chunkId);
            return id !== undefined && verifiedIds.has(id);
          }),
          citationIdByChunk,
          idFactory: options.idFactory,
        });

  const governingIds = scope.filter((s) => s.role === 'governing').map((s) => s.sourceId);
  const projectIds = scope.filter((s) => s.role === 'project').map((s) => s.sourceId);

  const coverage = computeEvidenceCoverage({
    claims: finalClaims,
    citations,
    regulationSourceIds: governingIds,
    projectSourceIds: projectIds,
  });

  const confidence = computeConfidence({
    coverage,
    citations,
    retrievalScores: retrieval.candidates.map((c) => c.rerankScore),
    sourceAuthorityScores: scope.map((s) =>
      sourceAuthorityScore({
        role: s.role,
        hasEffectiveDate: s.effectiveDate !== null,
        promoted: s.promoted,
        tags: s.tags,
        superseded: s.superseded,
      }),
    ),
    effectiveDates: scope.map((s) => s.effectiveDate),
    conflictCount: citations.filter((c) => c.entailment === 'contradicts').length,
  });

  const abstain = shouldAbstain({
    coverage,
    confidence,
    minimumEvidenceThreshold: options.minimumEvidenceThreshold,
    askWhenUncertain: options.askWhenUncertain,
    verifiedCitations: verified.length,
  });

  const answer = assembleAnswer({
    answerId: options.idFactory(),
    task: options.task,
    question,
    citations,
    claims: finalClaims,
    coverage,
    confidence,
    documentsReviewed: toDocumentsReviewed(scope),
    decision: abstain.abstain
      ? 'unable_to_determine'
      : deriveAskDecision(
          question,
          finalClaims,
          citations,
          scope,
          options.answerStyle === 'yes_no',
        ),
    riskLevel: 'none',
    missingEvidence: abstain.abstain ? [] : failures.map((f) => f.reason),
    uncertainties: failures.map((f) => f.reason),
    followUpQuestion: abstain.abstain ? buildFollowUp(scope) : null,
    abstainReason: abstain.reason,
    headlineOverride: !abstain.abstain ? usableHeadline(composed.headline, verified) : null,
    summaryOverride: !abstain.abstain && composed.summary ? composed.summary : null,
    modelDescriptor: `${deps.chat.id}:${deps.chat.model} + ${deps.embedder.id}:${deps.embedder.model}`,
    scope: `Question answered against ${scope.length} selected source version(s).`,
  });

  return {
    answer,
    telemetry: {
      ...retrieval.telemetry,
      verifiedCitations: verified.length,
      unverifiedCitations: citations.length - verified.length,
      providerTokens: composed.usage.inputTokens + composed.usage.outputTokens,
    },
  };
}

/**
 * The provider's headline, unless it is just a piece of the evidence.
 *
 * A headline is supposed to say what the answer is. Asked for one, a model will sometimes
 * return the most relevant sentence it was given instead — and a reader who opened a
 * consultation to find out whether their submittal complies gets a clause of the fire code
 * back, mid-sentence, hyphenation and all. That is not an answer to anything.
 *
 * Detected by containment rather than by length or punctuation: if the words are already
 * sitting inside a verified excerpt, the model quoted rather than concluded, and the
 * computed headline — which states the finding — is used instead.
 */
function usableHeadline(headline: string, verified: Citation[]): string | null {
  const candidate = normalizeForMatch(headline);
  if (candidate.length === 0) return null;
  const quoted = verified.some((citation) =>
    normalizeForMatch(citation.supportingExcerpt).includes(candidate.slice(0, 80)),
  );
  return quoted ? null : headline;
}

/**
 * The words the submitted documents actually use.
 *
 * One pass over the project chunks rather than a retrieval per requirement: with thousands
 * of obligations to rank, the difference is a second against an hour, and the ranking only
 * needs to know whether an obligation is about the same subject matter — not where in the
 * document the answer is, which is what the per-requirement retrieval below is for.
 */
async function projectVocabulary(
  ctx: TenantContext,
  repo: RetrievalRepository,
  project: SourceScope[],
): Promise<{ words: Map<string, number>; text: string }> {
  const words = new Map<string, number>();
  const parts: string[] = [];
  for (const source of project) {
    const chunks = await repo.chunksForVersion(ctx, source.sourceVersionId);
    for (const chunk of chunks) {
      const text = `${chunk.headingText} ${chunk.content}`;
      parts.push(text);
      for (const term of contentTokens(text)) {
        const stem = lightStem(term);
        words.set(stem, (words.get(stem) ?? 0) + 1);
      }
    }
  }
  /*
   * One pass, three answers: which words the submission uses, what trade it belongs to,
   * and how tall the building is. Reading every chunk again for each would be three passes
   * over a document that can run to thousands of them.
   */
  return { words, text: profileText(parts) };
}

/**
 * How much of a clause's own vocabulary the submission has to use before that clause is
 * treated as being about the submission at all.
 */
const RELEVANCE_FLOOR = 0.4;

/**
 * How many out-of-scope clauses a report names before it just gives the count.
 *
 * A fire code holds hundreds a single-trade drawing cannot answer. Listing them all would
 * bury the findings that matter under the ones that never applied.
 */
const OUT_OF_SCOPE_SHOWN = 5;

/**
 * Occurrences at which a word counts as something the submission is about.
 *
 * Presence alone is too weak a test on a real drawing set: 1300 chunks of title blocks,
 * legends and general notes mention nearly every word in the trade at least once, so an
 * LPG-tank clause scored as relevant to a smoke-control package on the strength of "lpg"
 * appearing six times in boilerplate. "damper" appears on every sheet; "lpg" does not.
 */
const SUBJECT_OCCURRENCES = 25;

/**
 * The obligations this submission is actually about, in document order.
 *
 * Scored by how much of each obligation's own vocabulary the submission uses, weighted so
 * that the words which name the subject count and the words half the code shares do not.
 * An obligation whose vocabulary is absent is not evidence that the submission fails it —
 * it is evidence that the clause is about something else — and spending the budget on those
 * is what produced a fire-alarm review full of findings about civil definitions.
 *
 * The floor comes before the budget, so the checklist is as long as the submission
 * warrants rather than always exactly the budget. When nothing clears the floor, the head
 * of the document is used unchanged: that is the honest fallback, and the review says
 * separately how much it did not look at.
 */
function selectRelevantRequirements(
  drafts: RequirementDraft[],
  vocabulary: Map<string, number>,
  budget: number,
): RequirementDraft[] {
  /*
   * How much a word says about what a clause is for.
   *
   * Weighting every key term equally is what let an LPG clause pass as relevant to a
   * smoke-control drawing: "building", "distance", "located", "property" and "separation"
   * all appear on the drawing, and they outvoted the two words that actually name the
   * subject. They outvote it because they are in half the code — which is exactly what
   * makes them uninformative, and exactly what document frequency measures. Counted over
   * the obligations already in memory, so it costs one pass and no extra query.
   */
  const documentFrequency = new Map<string, number>();
  for (const draft of drafts) {
    for (const term of new Set(draft.keyTerms.map((t) => lightStem(t)))) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const total = Math.max(1, drafts.length);
  const informativeness = (term: string): number =>
    Math.log(total / (1 + (documentFrequency.get(term) ?? 0))) / Math.log(total);

  /** How much of the submission's attention a word has. */
  const presence = (term: string): number => {
    const count = vocabulary.get(term) ?? 0;
    if (count === 0) return 0;
    return Math.min(1, Math.log1p(count) / Math.log1p(SUBJECT_OCCURRENCES));
  };

  const scored = drafts.map((draft, index) => {
    const terms = [...new Set(draft.keyTerms.map((term) => lightStem(term)))];
    let weighted = 0;
    let weight = 0;
    for (const term of terms) {
      const informative = Math.max(0, informativeness(term));
      weight += informative;
      weighted += informative * presence(term);
    }
    return { draft, index, score: weight === 0 ? 0 : weighted / weight };
  });

  /*
   * Ranking alone still fills the budget, whatever is at the bottom of the list. On a
   * twelve-sheet smoke-control package that was clauses about LPG tanks and fire-station
   * administrative areas, reported as "cannot be verified from the drawing" — true, and
   * useless. The drawing is not about LPG tanks. A clause the submission does not engage
   * with is not a gap in the submission, and listing it buries the gaps that are real.
   */
  const relevant = scored.filter((entry) => entry.score >= RELEVANCE_FLOOR);

  // Nothing cleared the floor — a submission in a vocabulary the code does not share, or no
  // project document at all. Fall back to document order so the review still says something.
  if (relevant.length === 0) return drafts.slice(0, budget);

  return relevant
    .sort((a, b) => (b.score === a.score ? a.index - b.index : b.score - a.score))
    .slice(0, budget)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.draft);
}

/**
 * Two retrievals into one, keeping every candidate and the first telemetry.
 *
 * Candidates from different roles never collide — a chunk belongs to one source — so this
 * is a concatenation rather than a merge. The order is governing first because that is the
 * order the obligation and the evidence for it are read in.
 */
function mergeRetrievals(
  governing: Awaited<ReturnType<typeof retrieve>>,
  project: Awaited<ReturnType<typeof retrieve>>,
): Awaited<ReturnType<typeof retrieve>> {
  return {
    ...governing,
    candidates: [...governing.candidates, ...project.candidates],
  };
}

/**
 * A yes/no question deserves a yes/no answer; an open question does not.
 * Detecting the question form here keeps `decision` null for "what does X say?" rather
 * than forcing a binary onto something that was never binary.
 */
function deriveAskDecision(
  question: string,
  claims: Claim[],
  citations: Citation[],
  scope: SourceScope[],
  /**
   * The reader asked for a verdict, whatever shape the question took.
   *
   * The polar-form test below is a guess at intent from the wording, and it is the right
   * guess when nobody has said otherwise — forcing YES or NO onto "what does the code say
   * about X" would be answering a question that was not asked. Choosing the Yes / No
   * answer style says otherwise explicitly, and a screen that then shows no verdict at all
   * has ignored the only instruction it was given.
   */
  requireVerdict = false,
): 'yes' | 'no' | 'unable_to_determine' | null {
  const isPolar =
    /^\s*(does|do|is|are|can|may|must|shall|should|will|has|have|did|was|were)\b/i.test(
      question.trim(),
    );
  if (!isPolar && !requireVerdict) return null;

  const supported = claims.filter((c) => c.supported);
  if (supported.length === 0) return 'unable_to_determine';

  // A demonstrable numeric failure outranks any textual signal: if a governing passage
  // states a limit and a project passage states a value that breaches it, that is a NO
  // with an arithmetic reason, not a judgement call.
  const numeric = crossCheckQuantities(citations, scope);
  if (numeric === 'violated') return 'no';

  const contradicting = citations.filter(
    (c) => c.verified && c.entailment === 'contradicts',
  ).length;
  const supporting = citations.filter((c) => c.verified && c.entailment === 'supports').length;

  if (contradicting > supporting) return 'no';
  if (numeric === 'satisfied' && supporting > 0) return 'yes';
  if (supporting > 0 && contradicting === 0) return 'yes';
  // A genuine tie, or no signal at all, is not a coin toss.
  return 'unable_to_determine';
}

/**
 * Compares quantities stated in governing passages against those stated in project
 * passages, respecting the direction the obligation gives ("at least", "shall not exceed").
 * Returns `null` when the two sides share no comparable unit.
 */
function crossCheckQuantities(
  citations: Citation[],
  scope: SourceScope[],
): 'violated' | 'satisfied' | null {
  const roleBySource = new Map(scope.map((s) => [s.sourceId, s.role]));
  const governing = citations.filter(
    (c) => c.verified && roleBySource.get(c.sourceId) === 'governing',
  );
  const project = citations.filter((c) => c.verified && roleBySource.get(c.sourceId) === 'project');
  if (governing.length === 0 || project.length === 0) return null;

  let compared = false;
  for (const rule of governing) {
    const required = extractQuantities(rule.supportingExcerpt);
    if (required.size === 0) continue;
    for (const evidence of project) {
      const actual = extractQuantities(evidence.supportingExcerpt);
      for (const [unit, requiredValue] of required) {
        const actualValue = actual.get(unit);
        if (actualValue === undefined) continue;
        compared = true;
        if (!quantitySatisfies(rule.supportingExcerpt, requiredValue, actualValue)) {
          return 'violated';
        }
      }
    }
  }

  return compared ? 'satisfied' : null;
}

function buildFollowUp(scope: SourceScope[]): string {
  if (scope.length === 0) {
    return 'Which knowledge-base sources should I use to answer this? None are currently selected.';
  }
  const titles = scope
    .slice(0, 3)
    .map((s) => s.title)
    .join(', ');
  return `I searched ${titles} and found no passage that settles this. Can you point me at the document or clause that covers it, or upload it as a consultation input?`;
}

function toDocumentsReviewed(
  scope: SourceScope[],
  /** Pages actually read, per source id. */
  sheetsBySource: Map<string, Set<number>> = new Map(),
): DocumentReviewed[] {
  return scope.map((s) => ({
    sourceId: s.sourceId,
    sourceVersionId: s.sourceVersionId,
    title: s.title,
    version: s.version,
    role: s.role,
    pages: s.pages,
    sheetsInspected: [...(sheetsBySource.get(s.sourceId) ?? [])].sort((a, b) => a - b),
  }));
}

/* -------------------------------------------------------------------------- */
/* Compliance review                                                          */
/* -------------------------------------------------------------------------- */

export interface ReviewOptions extends AnswerOptions {
  scopeNote?: string | null;
  maxRequirements?: number;
  onProgress?: (done: number, total: number) => void | Promise<void>;
}

export interface ReviewResult {
  answer: StructuredAnswer;
  requirements: Requirement[];
  findings: Finding[];
  citations: Citation[];
  counts: {
    compliant: number;
    nonCompliant: number;
    needsEvidence: number;
    notAssessed: number;
  };
}

/**
 * Runs a requirement-by-requirement compliance review.
 *
 * This is deliberately NOT one free-form prompt over everything. The applicable requirement
 * set is built first from the governing sources, then each requirement is tested
 * independently against evidence retrieved from the project documents. That structure is
 * what produces a real evidence matrix, makes "needs evidence" a first-class outcome, and
 * keeps a single confident-sounding paragraph from hiding twelve unexamined obligations.
 */
export async function runComplianceReview(
  ctx: TenantContext,
  deps: { repo: RetrievalRepository; embedder: EmbeddingProvider; chat: ChatProvider },
  scope: SourceScope[],
  options: ReviewOptions,
): Promise<ReviewResult> {
  const governing = scope.filter((s) => s.role === 'governing');
  const project = scope.filter((s) => s.role === 'project');

  // --- 1. Build the applicable requirement set --------------------------
  // `source_sections.body` holds the section's real wording, so the requirement quotes
  // exactly what the regulation says rather than a reconstruction from derived chunks.
  const sections = await deps.repo.requirementSections(
    ctx,
    governing.map((s) => s.sourceVersionId),
  );

  const sourceByVersion = new Map(governing.map((s) => [s.sourceVersionId, s]));

  const requirementDrafts: RequirementDraft[] = buildRequirementSet(
    sections.map((section) => ({
      id: section.id,
      ordinal: section.ordinal,
      level: section.level,
      kind: section.kind as never,
      // Sections reloaded from the database always came from a detected heading: only
      // heading-derived sections are ever flagged as requirements.
      fromHeading: true,
      chapter: section.chapter,
      section: section.section,
      clause: section.clause,
      title: section.title,
      body: section.body,
      headingPath: section.headingPath,
      pageNumber: section.pageNumber,
      charStart: section.charStart,
      charEnd: section.charEnd,
      modality: section.modality as never,
      isRequirement: section.isRequirement,
      effectiveDate: section.effectiveDate,
      supersededNote: section.supersededNote,
      crossReferences: section.crossReferences,
      exceptions: section.exceptions,
      sourceId: sourceByVersion.get(section.sourceVersionId)?.sourceId ?? '',
      sourceVersionId: section.sourceVersionId,
    })),
    // Every obligation the document contains, not the first N: which ones matter is
    // decided below, against the submission, and cannot be decided before it is read.
    { idFactory: options.idFactory, maxRequirements: Number.MAX_SAFE_INTEGER },
  );

  /*
   * The obligations this submission is actually about.
   *
   * A code of any size holds thousands, and testing every one against every document is
   * not something anybody will wait for — so a limit is unavoidable. Taking the first N in
   * file order is the wrong limit, and visibly so: on a fire code it spends the entire
   * budget on Chapter 1, and the review comes back reporting that a fire-alarm submittal
   * fails to evidence the definitions of "building", "civil" and "floor". Nothing about
   * that is useful and the shape of it looks like an answer.
   *
   * Ranked instead by how much of each obligation's own vocabulary appears in the
   * submitted document, so a package about detection, emergency lighting and sprinkler
   * hydraulics is tested against the clauses governing detection, emergency lighting and
   * sprinkler hydraulics. Ties keep document order, so the result is stable and reads in
   * the order the code is written.
   */
  const budget = options.maxRequirements ?? 60;
  const { words: vocabulary, text: projectText } = await projectVocabulary(ctx, deps.repo, project);

  /*
   * What trade this submission belongs to, and which clauses it could answer.
   *
   * A twelve-sheet smoke-ventilation layout was being tested against clauses on LPG tank
   * installation, fire-station bedrooms, curtainwall perimeter joints and glass baluster
   * design. Each came back "needs evidence" — which reads to a client as a gap in their
   * design, when in truth the clause was never theirs to answer. Out of scope and unmet
   * are different states and were being merged.
   */
  const submissionProfile = profileDisciplines(projectText);

  /*
   * What the building is, read off its own drawings.
   *
   * The height decides which clauses apply at all. A clause that opens "all Super highrise
   * buildings (having height greater than 90 m)" is not a gap in a 23.76 m building's
   * design — it is a clause about a different building. Reporting it as unevidenced is the
   * same mistake as reporting an LPG clause against a smoke layout, one storey up.
   */
  const building = deriveBuildingAttributes(projectText);

  const inScope: RequirementDraft[] = [];
  const outOfScope: Array<{ draft: RequirementDraft; discipline: Discipline }> = [];
  const outOfBand: Array<{ draft: RequirementDraft; condition: HeightCondition }> = [];
  for (const draft of requirementDrafts) {
    const text = `${draft.title} ${draft.obligationText}`;

    const condition = heightCondition(text);
    if (appliesAtHeight(condition, building.heightM) === false && condition !== null) {
      outOfBand.push({ draft, condition });
      continue;
    }

    const discipline = clauseDiscipline(text);
    if (project.length > 0 && !isInScope(discipline, submissionProfile.disciplines)) {
      outOfScope.push({ draft, discipline: discipline as Discipline });
      continue;
    }
    inScope.push(draft);
  }

  const relevant = selectRelevantRequirements(inScope, vocabulary, budget);
  const omitted = inScope.length - relevant.length;

  const usable = relevant.filter((r) => r.obligationText.length > 0);

  const allCitations: Citation[] = [];
  const requirements: Requirement[] = [];
  const findings: Finding[] = [];
  /** Which pages of each document the review actually read. */
  const sheetsBySource = new Map<string, Set<number>>();

  // --- 2. Test each requirement against the project documents -----------
  for (const [index, requirement] of usable.entries()) {
    // Governing citation: the clause that creates the obligation.
    const governingRetrieval = await retrieve(
      ctx,
      deps.repo,
      deps.embedder,
      `${requirement.reference} ${requirement.title} ${requirement.obligationText}`,
      scope,
      { roles: ['governing'], finalLimit: 2, channelLimit: 20, preferRequirements: true },
    );

    /*
     * Project evidence: what the submission itself shows about this obligation.
     *
     * Spread deliberately across sheets. A fire-alarm package is one PDF of a dozen
     * drawings, and taking the five best-scoring passages put all five on the sheet whose
     * title block happened to match — so a clause evidenced on sheet 7 was reported as
     * unevidenced because the search never looked past sheet 2. Two passages per sheet,
     * over a wider budget, means every sheet that matched at all gets read.
     */
    const projectRetrieval =
      project.length > 0
        ? await retrieve(
            ctx,
            deps.repo,
            deps.embedder,
            `${requirement.title} ${requirement.keyTerms.join(' ')}`,
            scope,
            {
              roles: ['project'],
              finalLimit: 12,
              channelLimit: 60,
              maxPerSource: 12,
              maxPerPage: 2,
            },
          )
        : { candidates: [] as FusedCandidate[], telemetry: null };

    const governingCitations = await buildAndVerifyCitations(
      ctx,
      deps.repo,
      governingRetrieval.candidates,
      requirement.obligationText,
      options.idFactory,
    );

    const projectCitations = await buildAndVerifyCitations(
      ctx,
      deps.repo,
      projectRetrieval.candidates,
      requirement.keyTerms.join(' '),
      options.idFactory,
    );

    for (const candidate of [...governingRetrieval.candidates, ...projectRetrieval.candidates]) {
      if (candidate.pageNumber === null) continue;
      const seen = sheetsBySource.get(candidate.sourceId) ?? new Set<number>();
      seen.add(candidate.pageNumber);
      sheetsBySource.set(candidate.sourceId, seen);
    }

    const evidence = projectRetrieval.candidates.map((candidate) =>
      scoreRequirementEvidence(requirement, candidate, requirement.title),
    );

    const verdict = evaluateRequirement(requirement, evidence);

    const supportingProjectIds = verdict.supportingEvidenceIndexes
      .map((i) => {
        const candidate = evidence[i]?.candidate;
        return candidate ? projectCitations.citationIdByChunk.get(candidate.chunkId) : undefined;
      })
      .filter((id): id is string => typeof id === 'string');

    const governingIds = governingCitations.citations
      .filter((c) => c.verified)
      .map((c) => c.citationId);

    allCitations.push(...governingCitations.citations, ...projectCitations.citations);

    requirements.push({ ...toRequirement(requirement), citationId: governingIds[0] ?? null });

    findings.push({
      findingId: options.idFactory(),
      requirementId: requirement.requirementId,
      requirementReference: requirement.reference,
      requirementTitle: requirement.title,
      result: verdict.result,
      risk: verdict.risk,
      finding: verdict.finding,
      // A compliant verdict with no verified evidence would violate the database check
      // constraint; downgrade it here so the reason is explicit rather than a 500.
      projectEvidenceCitationIds: supportingProjectIds,
      governingCitationIds: governingIds,
      missingEvidence: verdict.missingEvidence,
      conflicts: verdict.conflicts.map((c) => ({
        description: c.description,
        citationIds: c.evidenceIndexes
          .map((i) => {
            const candidate = evidence[i]?.candidate;
            return candidate
              ? projectCitations.citationIdByChunk.get(candidate.chunkId)
              : undefined;
          })
          .filter((id): id is string => typeof id === 'string'),
      })),
      recommendedAction: verdict.recommendedAction,
      confidence: verdict.confidence,
    });

    await options.onProgress?.(index + 1, usable.length);
  }

  /*
   * Clauses that were never this document's to answer, said so.
   *
   * Reported rather than dropped: silence would leave a reader unable to tell a review
   * that considered a clause and routed it elsewhere from one that never saw it. They are
   * `not_assessed` — the enum has always had the state and nothing used it — so they
   * cannot count towards the verdict, and they carry no risk.
   *
   * A sample, not the whole set: on a fire code against a single-trade drawing this is
   * hundreds of clauses, and a report listing every one of them is a worse document than
   * one that names a few and says how many there were.
   */
  /*
   * Clauses that apply to a different building, with the arithmetic shown.
   *
   * The derivation is the finding: this building is 23.76 m, the clause is for buildings
   * over 90 m, therefore it does not apply. A reader can check both halves.
   */
  for (const { draft, condition } of outOfBand.slice(0, OUT_OF_SCOPE_SHOWN)) {
    requirements.push(toRequirement(draft));
    findings.push({
      findingId: options.idFactory(),
      requirementId: draft.requirementId,
      requirementReference: draft.reference,
      requirementTitle: draft.title,
      result: 'not_assessed',
      risk: 'none',
      finding: `${draft.reference} applies to buildings ${condition.direction} ${condition.threshold} m. This building is ${building.heightM} m${building.band === null ? '' : ` (${bandLabel(building.band)})`}, so the clause does not apply.`,
      projectEvidenceCitationIds: [],
      governingCitationIds: [],
      missingEvidence: [],
      conflicts: [],
      recommendedAction: null,
      confidence: 0.75,
    });
  }

  for (const { draft, discipline } of outOfScope.slice(0, OUT_OF_SCOPE_SHOWN)) {
    requirements.push(toRequirement(draft));
    findings.push({
      findingId: options.idFactory(),
      requirementId: draft.requirementId,
      requirementReference: draft.reference,
      requirementTitle: draft.title,
      result: 'not_assessed',
      risk: 'none',
      finding: `${draft.reference} is a ${disciplineLabel(discipline)} clause. This submission covers ${describeDisciplines(submissionProfile.disciplines)}, so the clause is outside its scope rather than unmet.`,
      projectEvidenceCitationIds: [],
      governingCitationIds: [],
      missingEvidence: [],
      conflicts: [],
      recommendedAction: null,
      confidence: 0.7,
    });
  }

  // Enforce the invariant the database also enforces: no compliant finding without evidence.
  for (const finding of findings) {
    if (
      finding.result === 'compliant' &&
      finding.projectEvidenceCitationIds.length === 0 &&
      finding.governingCitationIds.length === 0
    ) {
      finding.result = 'needs_evidence';
      finding.finding = `${finding.finding} (Downgraded: no citation survived verification, so compliance cannot be evidenced.)`;
      finding.confidence = Math.min(finding.confidence, 0.4);
    }
  }

  const counts = {
    compliant: findings.filter((f) => f.result === 'compliant').length,
    nonCompliant: findings.filter((f) => f.result === 'non_compliant').length,
    needsEvidence: findings.filter((f) => f.result === 'needs_evidence').length,
    notAssessed: findings.filter((f) => f.result === 'not_assessed').length,
  };

  const { decision, qualifier } = decideOverall(counts);
  const risk = aggregateRisk(findings.map((f) => ({ result: f.result, risk: f.risk })));

  const claims: Claim[] = findings.map((finding) => ({
    claimId: options.idFactory(),
    text: finding.finding,
    citationIds: [...finding.governingCitationIds, ...finding.projectEvidenceCitationIds],
    supported:
      finding.governingCitationIds.length > 0 || finding.projectEvidenceCitationIds.length > 0,
    fromGeneralModel: false,
  }));

  const coverage = computeEvidenceCoverage({
    claims,
    citations: allCitations,
    findings,
    regulationSourceIds: governing.map((s) => s.sourceId),
    projectSourceIds: project.map((s) => s.sourceId),
  });

  const confidence = computeConfidence({
    coverage,
    citations: allCitations,
    retrievalScores: allCitations.map((c) => c.rerankScore),
    sourceAuthorityScores: scope.map((s) =>
      sourceAuthorityScore({
        role: s.role,
        hasEffectiveDate: s.effectiveDate !== null,
        promoted: s.promoted,
        tags: s.tags,
        superseded: s.superseded,
      }),
    ),
    effectiveDates: scope.map((s) => s.effectiveDate),
    conflictCount: findings.reduce((sum, f) => sum + f.conflicts.length, 0),
  });

  const recommendedActions = findings
    .filter((f) => f.recommendedAction !== null)
    .sort((a, b) => riskWeight(b.risk) - riskWeight(a.risk))
    .slice(0, 8)
    .map((f) => ({
      action: f.recommendedAction as string,
      priority:
        f.risk === 'critical'
          ? ('critical' as const)
          : f.risk === 'high'
            ? ('high' as const)
            : f.risk === 'medium'
              ? ('medium' as const)
              : ('low' as const),
      requirementIds: [f.requirementId],
    }));

  const answer = assembleAnswer({
    answerId: options.idFactory(),
    task: 'check_compliance',
    question: options.scopeNote ?? 'Compliance review',
    citations: allCitations,
    claims,
    coverage,
    confidence,
    documentsReviewed: toDocumentsReviewed(scope, sheetsBySource),
    requirements,
    findings,
    decision,
    decisionQualifier: qualifier,
    riskLevel: risk,
    missingEvidence: [...new Set(findings.flatMap((f) => f.missingEvidence))].slice(0, 12),
    conflicts: findings.flatMap((f) => f.conflicts),
    recommendedActions,
    scope:
      options.scopeNote ??
      `${usable.length} mandatory requirement(s) from ${governing.length} governing source(s), tested against ${project.length} project document(s).`,
    assumptions: buildAssumptions(
      governing,
      project,
      usable.length,
      relevant.length,
      omitted,
      sheetsBySource,
      {
        disciplines: submissionProfile.disciplines,
        outOfScope: outOfScope.length,
        exemptive: exemptiveClauses(requirementDrafts),
        outOfBand: outOfBand.length,
        building,
      },
    ),
    followUpQuestion:
      project.length === 0
        ? 'No project documents were attached. Upload the documents you want assessed, and I will test each requirement against them.'
        : null,
    modelDescriptor: `${deps.chat.id}:${deps.chat.model} + ${deps.embedder.id}:${deps.embedder.model}`,
  });

  return { answer, requirements, findings, citations: allCitations, counts };
}

/**
 * The record of a clause the review considered.
 *
 * Written for every clause that produces a finding, including the ones routed away: a
 * finding carries a foreign key to its requirement, so a clause reported as out of scope
 * with no row behind it fails the whole review at the point of saving it — which is how it
 * failed, silently, on the first run of the routing work.
 */
function toRequirement(draft: RequirementDraft): Requirement {
  return {
    requirementId: draft.requirementId,
    reference: draft.reference,
    title: draft.title,
    obligationText: draft.obligationText,
    modality: draft.modality,
    sourceId: draft.sourceId,
    sourceVersionId: draft.sourceVersionId,
    citationId: null,
    exceptions: draft.exceptions,
    crossReferences: draft.crossReferences,
  };
}

function buildAssumptions(
  governing: SourceScope[],
  project: SourceScope[],
  used: number,
  total: number,
  omitted = 0,
  sheetsBySource: Map<string, Set<number>> = new Map(),
  routing: {
    disciplines: Discipline[];
    outOfScope: number;
    exemptive: number;
    outOfBand: number;
    building: BuildingAttributes;
  } = {
    disciplines: [],
    outOfScope: 0,
    exemptive: 0,
    outOfBand: 0,
    building: {
      heightM: null,
      band: null,
      heightEvidence: null,
      sprinklered: null,
      sprinkleredEvidence: null,
      basement: false,
    },
  },
): string[] {
  const out: string[] = [];
  /*
   * Which document set the rules, named before anything else.
   *
   * A reader has to be able to see that the submission was measured against the knowledge
   * base and not against itself. The separation is enforced server-side; this is where the
   * report says so out loud.
   */
  if (governing.length > 0) {
    out.push(
      `Compliance was judged solely against the knowledge base: ${governing.map((g) => g.title).join(', ')}. The submitted document was treated as the subject of the review and never as an authority.`,
    );
  }
  for (const source of project) {
    const sheets = [...(sheetsBySource.get(source.sourceId) ?? [])].sort((a, b) => a - b);
    if (sheets.length === 0) continue;
    const total = source.pages;
    out.push(
      total && total > sheets.length
        ? `${source.title}: ${sheets.length} of ${total} sheets carried text matching a tested clause and were inspected (${formatSheetRanges(sheets)}). The remaining sheets matched nothing and were not read.`
        : `${source.title}: all ${sheets.length} sheet(s) were inspected (${formatSheetRanges(sheets)}).`,
    );
  }
  out.push(
    `Only mandatory and prohibitive provisions were treated as testable requirements; recommendations ("should") were not scored as failures.`,
  );
  if (routing.exemptive > 0) {
    out.push(
      `${routing.exemptive} clause(s) lift a requirement rather than impose one — "shall not be required in..." and similar — and were not treated as things to satisfy.`,
    );
  }
  if (routing.outOfScope > 0 && routing.disciplines.length > 0) {
    out.push(
      `This submission was read as covering ${describeDisciplines(routing.disciplines)}. ${routing.outOfScope} clause(s) belonging to other trades were set aside as outside its scope rather than reported as unmet.`,
    );
  }
  /*
   * The derivation, stated so it can be disagreed with.
   *
   * Everything the height band decides rests on one number read off a drawing. Printing
   * the number and the line it came from is what makes that checkable rather than a
   * verdict from nowhere.
   */
  if (routing.building.heightM !== null && routing.building.band !== null) {
    out.push(
      `The building was read as ${routing.building.heightM} m tall (${bandLabel(routing.building.band)}) from "${routing.building.heightEvidence ?? 'a level annotation'}". ${routing.outOfBand} clause(s) that apply only to other height bands were set aside on that basis. If the height is wrong, so are those exclusions.`,
    );
  } else if (routing.outOfBand === 0 && project.length > 0) {
    out.push(
      'No floor level annotation was found, so the building height could not be derived and no clause was excluded on height. Clauses that apply only above or below a height threshold were tested regardless.',
    );
  }
  if (routing.building.sprinklered !== null) {
    out.push(
      `The building was read as ${routing.building.sprinklered ? 'sprinklered' : 'not sprinklered'} from "${routing.building.sprinkleredEvidence ?? 'the drawing text'}". This was not used to exclude any clause.`,
    );
  }
  /*
   * Said first, and said plainly.
   *
   * A review of sixty obligations from a document holding six hundred is a sample. Reporting
   * "9 not met" without this line reads as a verdict on the whole regulation, and somebody
   * would be entitled to act on it as one.
   */
  if (omitted > 0) {
    out.push(
      `${used} obligation(s) were selected as relevant to this submission, out of ${used + omitted} testable obligations detected in the knowledge base. The other ${omitted} were not examined — either their subject does not appear in the submission, or they fell outside the size of this review — so this is not a verdict on the regulation as a whole.`,
    );
  }
  if (used < total) {
    out.push(
      `${total - used} detected provisions were excluded because their obligation text could not be resolved to a stored passage.`,
    );
  }
  for (const source of governing) {
    if (!source.effectiveDate) {
      out.push(
        `${source.title} carries no recorded effective date, so recency could not be weighted for it.`,
      );
    }
    if (source.superseded) {
      out.push(
        `${source.title} is marked superseded; its provisions were treated as low authority.`,
      );
    }
  }
  if (project.length === 0) {
    out.push(
      'No project documents were supplied, so every requirement is unproven rather than failed.',
    );
  }
  return out;
}

/** "1-3, 7, 9-12" — compact enough to read, exact enough to check. */
function formatSheetRanges(sheets: number[]): string {
  const out: string[] = [];
  let start = sheets[0];
  let previous = sheets[0];
  if (start === undefined || previous === undefined) return '';

  for (const sheet of sheets.slice(1)) {
    if (sheet === previous + 1) {
      previous = sheet;
      continue;
    }
    out.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = sheet;
    previous = sheet;
  }
  out.push(start === previous ? `${start}` : `${start}-${previous}`);
  return `sheet ${out.join(', ')}`;
}

function riskWeight(risk: Finding['risk']): number {
  return { critical: 4, high: 3, medium: 2, low: 1, none: 0 }[risk];
}

/* -------------------------------------------------------------------------- */
/* Summarisation                                                              */
/* -------------------------------------------------------------------------- */

export interface SummarizeOptions extends AnswerOptions {
  format: 'executive' | 'section_by_section' | 'obligations' | 'risks' | 'custom';
  customInstruction?: string;
  pageRange?: { from: number; to: number } | null;
}

/** Produces an evidence-backed summary; every sentence still resolves to a citation. */
export async function summarizeSources(
  ctx: TenantContext,
  deps: { repo: RetrievalRepository; embedder: EmbeddingProvider; chat: ChatProvider },
  scope: SourceScope[],
  options: SummarizeOptions,
): Promise<AnswerResult> {
  const focus =
    options.format === 'obligations'
      ? 'obligations requirements shall must required prohibited'
      : options.format === 'risks'
        ? 'risk hazard liability penalty non-compliance failure exposure'
        : options.format === 'custom' && options.customInstruction
          ? options.customInstruction
          : scope.map((s) => s.title).join(' ');

  const retrieval = await retrieve(ctx, deps.repo, deps.embedder, focus, scope, {
    finalLimit: options.format === 'section_by_section' ? 20 : 12,
    maxPerSource: options.format === 'section_by_section' ? 8 : 5,
    preferRequirements: options.format === 'obligations',
  });

  const { citations, citationIdByChunk, failures } = await buildAndVerifyCitations(
    ctx,
    deps.repo,
    retrieval.candidates,
    focus,
    options.idFactory,
  );

  const verifiedIds = new Set(citations.filter((c) => c.verified).map((c) => c.citationId));

  const verifiedCandidates = retrieval.candidates.filter((c) => {
    const id = citationIdByChunk.get(c.chunkId);
    return id !== undefined && verifiedIds.has(id);
  });

  const summaryLines = extractiveSummary(
    verifiedCandidates.map((c) => ({
      text: c.content,
      heading: c.headingPath.at(-1) ?? c.clause ?? c.section ?? null,
    })),
    { maxSentences: options.format === 'executive' ? 6 : 12 },
  );

  const claims: Claim[] = summaryLines
    .map((line) => {
      const owner = verifiedCandidates.find((c) => c.content.includes(line.sentence.slice(0, 40)));
      const citationId = owner ? citationIdByChunk.get(owner.chunkId) : undefined;
      return {
        claimId: options.idFactory(),
        text: line.sentence,
        citationIds: citationId && verifiedIds.has(citationId) ? [citationId] : [],
        supported: Boolean(citationId && verifiedIds.has(citationId)),
        fromGeneralModel: false,
      } satisfies Claim;
    })
    .filter((c) => c.supported);

  const coverage = computeEvidenceCoverage({
    claims,
    citations,
    regulationSourceIds: scope.filter((s) => s.role === 'governing').map((s) => s.sourceId),
    projectSourceIds: scope.filter((s) => s.role === 'project').map((s) => s.sourceId),
  });

  const confidence = computeConfidence({
    coverage,
    citations,
    retrievalScores: retrieval.candidates.map((c) => c.rerankScore),
    sourceAuthorityScores: scope.map((s) =>
      sourceAuthorityScore({
        role: s.role,
        hasEffectiveDate: s.effectiveDate !== null,
        promoted: s.promoted,
        tags: s.tags,
        superseded: s.superseded,
      }),
    ),
    effectiveDates: scope.map((s) => s.effectiveDate),
    conflictCount: 0,
  });

  const answer = assembleAnswer({
    answerId: options.idFactory(),
    task: 'summarize',
    question: focus,
    citations,
    claims,
    coverage,
    confidence,
    documentsReviewed: toDocumentsReviewed(scope),
    decision: null,
    uncertainties: failures.map((f) => f.reason),
    modelDescriptor: `${deps.chat.id}:${deps.chat.model} + ${deps.embedder.id}:${deps.embedder.model}`,
    scope: `${options.format.replace(/_/g, ' ')} summary of ${scope.length} document version(s).`,
    summaryOverride: claims.map((c) => c.text).join(' '),
  });

  return {
    answer,
    telemetry: {
      ...retrieval.telemetry,
      verifiedCitations: verifiedIds.size,
      unverifiedCitations: citations.length - verifiedIds.size,
      providerTokens: 0,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Ingestion-time safety                                                      */
/* -------------------------------------------------------------------------- */

export interface IngestionSafetyResult {
  quarantine: boolean;
  reason: string | null;
  signals: ReturnType<typeof detectInjection>;
}

/** Scans extracted text for injection attempts before it is ever indexed. */
export function screenExtractedText(text: string): IngestionSafetyResult {
  const signals = detectInjection(text);
  const quarantine = shouldQuarantine(signals);
  return {
    quarantine,
    reason: quarantine ? signals.map((s) => s.pattern).join(', ') : null,
    signals,
  };
}

export type { FusedCandidate, ChunkCandidate };
