import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  sourceChunks,
  sourcePages,
  sourceSections,
  sourceVersions,
  sources,
} from '../schema/index.js';
import { newId } from '../ids.js';
import type { TenantContext } from '../tenant.js';

/**
 * Stopwords removed before building the OR-ed tsquery. Postgres' own dictionary already
 * drops these from the tsvector, so leaving them in the query only adds noise terms that
 * match nothing.
 */
const LEXICAL_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'do',
  'does',
  'for',
  'from',
  'has',
  'have',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'with',
  'will',
  'would',
  'my',
  'me',
  'we',
  'you',
  'they',
  'their',
  'there',
  'any',
  'all',
  'not',
  'if',
  'then',
  'than',
]);

export interface ChunkCandidate {
  chunkId: string;
  sourceId: string;
  sourceVersionId: string;
  ordinal: number;
  content: string;
  pageNumber: number | null;
  pageEnd: number | null;
  sheetName: string | null;
  cellRange: string | null;
  slideNumber: number | null;
  chapter: string | null;
  section: string | null;
  clause: string | null;
  headingPath: string[];
  paragraphIndex: number | null;
  charStart: number;
  charEnd: number;
  kind: string;
  documentTitle: string;
  documentType: string;
  sourceSha256: string;
  sourceVersionLabel: string;
  effectiveDate: Date | null;
  /** Normalised 0..1. Lexical rank for BM25-equivalent hits, cosine similarity for vectors. */
  score: number;
  /** Where the candidate came from, so reciprocal-rank fusion can weight the two lists. */
  channel: 'lexical' | 'vector' | 'locator';
  rank: number;
}

export interface RetrievalScope {
  /** Already filtered through `visibleSourcePredicate` by the caller. */
  sourceVersionIds: string[];
}

export class RetrievalRepository {
  constructor(private readonly db: Database) {}

  /* ---------------------------------------------------------------------- */
  /* Indexing                                                               */
  /* ---------------------------------------------------------------------- */

  async replacePages(
    ctx: TenantContext,
    versionId: string,
    pages: Array<{
      pageNumber: number;
      text: string;
      width: number | null;
      height: number | null;
      sheetName: string | null;
      slideNumber: number | null;
      ocrApplied: boolean;
      ocrConfidence: number | null;
      wordBoxes: Array<{ t: string; x: number; y: number; w: number; h: number }>;
    }>,
  ) {
    await this.db.transaction(async (tx) => {
      await tx.delete(sourcePages).where(eq(sourcePages.sourceVersionId, versionId));
      // Chunked inserts keep a 1,300-page regulation from exceeding parameter limits.
      for (let i = 0; i < pages.length; i += 200) {
        const batch = pages.slice(i, i + 200);
        if (batch.length === 0) continue;
        await tx.insert(sourcePages).values(
          batch.map((p) => ({
            id: newId(),
            sourceVersionId: versionId,
            workspaceId: ctx.workspaceId,
            ...p,
          })),
        );
      }
    });
  }

  async replaceSections(
    ctx: TenantContext,
    versionId: string,
    sections: Array<
      Omit<typeof sourceSections.$inferInsert, 'id' | 'sourceVersionId' | 'workspaceId'>
    >,
  ) {
    await this.db.transaction(async (tx) => {
      await tx.delete(sourceSections).where(eq(sourceSections.sourceVersionId, versionId));
      for (let i = 0; i < sections.length; i += 200) {
        const batch = sections.slice(i, i + 200);
        if (batch.length === 0) continue;
        await tx.insert(sourceSections).values(
          batch.map((s) => ({
            id: newId(),
            sourceVersionId: versionId,
            workspaceId: ctx.workspaceId,
            ...s,
          })),
        );
      }
    });
  }

  async replaceChunks(
    ctx: TenantContext,
    sourceId: string,
    versionId: string,
    chunks: Array<{
      ordinal: number;
      content: string;
      tokenCount: number;
      pageNumber: number | null;
      pageEnd: number | null;
      sheetName: string | null;
      cellRange: string | null;
      slideNumber: number | null;
      chapter: string | null;
      section: string | null;
      clause: string | null;
      headingPath: string[];
      paragraphIndex: number | null;
      charStart: number;
      charEnd: number;
      kind: string;
      sectionId: string | null;
      headingText: string;
    }>,
  ) {
    const ids: string[] = [];
    await this.db.transaction(async (tx) => {
      await tx.delete(sourceChunks).where(eq(sourceChunks.sourceVersionId, versionId));
      for (let i = 0; i < chunks.length; i += 200) {
        const batch = chunks.slice(i, i + 200);
        if (batch.length === 0) continue;
        const rows = batch.map((c) => {
          const id = newId();
          ids.push(id);
          return {
            id,
            sourceId,
            sourceVersionId: versionId,
            organizationId: ctx.organizationId,
            workspaceId: ctx.workspaceId,
            ...c,
          };
        });
        await tx.insert(sourceChunks).values(rows);
      }
    });
    return ids;
  }

  /**
   * Writes embeddings with a raw parameterised statement because the pgvector literal
   * format is a string the driver must not re-quote as JSON.
   */
  async replaceEmbeddings(
    ctx: TenantContext,
    versionId: string,
    model: string,
    rows: Array<{ chunkId: string; vector: number[] }>,
  ) {
    await this.db.execute(sql`DELETE FROM embeddings WHERE source_version_id = ${versionId}`);
    for (let i = 0; i < rows.length; i += 100) {
      const batch = rows.slice(i, i + 100);
      if (batch.length === 0) continue;
      const values = batch.map(
        (r) =>
          sql`(${newId()}, ${r.chunkId}, ${versionId}, ${ctx.workspaceId}, ${ctx.organizationId}, ${model}, ${r.vector.length}, ${`[${r.vector.join(',')}]`}::vector)`,
      );
      await this.db.execute(sql`
        INSERT INTO embeddings (id, chunk_id, source_version_id, workspace_id, organization_id, model, dimensions, embedding)
        VALUES ${sql.join(values, sql`, `)}
        ON CONFLICT (chunk_id, model) DO UPDATE SET embedding = EXCLUDED.embedding
      `);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Retrieval                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Builds the tsquery for the lexical channel.
   *
   * `websearch_to_tsquery` ANDs every term, which is right for a search box but wrong for
   * retrieval: a four-word question would return nothing unless one passage contained all
   * four words. Terms are therefore OR-ed and `ts_rank_cd` (which rewards term density and
   * proximity, the same signals BM25 uses) does the discrimination. Quoted phrases in the
   * user's query are preserved as adjacency groups so exact-phrase intent still wins.
   *
   * Terms are stripped to alphanumerics before being embedded in the tsquery string, so no
   * tsquery operator can arrive from user input.
   */
  static buildTsQuery(query: string): string | null {
    return RetrievalRepository.tsQueryParts(query)?.any ?? null;
  }

  /**
   * The query in two strengths: every term, and any term.
   *
   * `any` is what has always been used, and it is right for recall — a paraphrased
   * question shares only some words with the passage that answers it. On a small corpus
   * that is enough. On a 17,000-chunk code it is not: "fire resistance rated window
   * assemblies" ORs down to a pool where thousands of chunks match on "fire" alone, and the
   * passage that contains all five words has to out-rank them on `ts_rank_cd` to survive
   * into the top sixty.
   *
   * `all` fixes that by asking the question precisely first. It is run before `any` and
   * usually returns few or no rows; the two are concatenated, so precision leads and recall
   * still follows. Neither is discarded, which matters because `all` returns nothing at all
   * for most natural questions.
   */
  static tsQueryParts(query: string): { all: string; any: string } | null {
    const phrases: string[] = [];
    const remainder = query.replace(/"([^"]{2,120})"/g, (_m, phrase: string) => {
      const words = String(phrase)
        .toLowerCase()
        .match(/[a-z0-9]+/g);
      if (words && words.length > 0) phrases.push(words.join(' <-> '));
      return ' ';
    });

    const terms = (remainder.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)*/g) ?? [])
      .map((t) => t.replace(/[^a-z0-9.]/g, ''))
      .filter((t) => t.length > 1 && !LEXICAL_STOPWORDS.has(t))
      // A dotted clause number is a single lexeme to Postgres; quoting keeps it intact.
      .map((t) => (t.includes('.') ? `'${t}'` : t));

    const parts = [...phrases.map((p) => `(${p})`), ...new Set(terms)];
    if (parts.length === 0) return null;
    return { all: parts.join(' & '), any: parts.join(' | ') };
  }

  /**
   * Lexical half of hybrid retrieval: PostgreSQL full-text search with `ts_rank_cd`,
   * a BM25-equivalent ranking over the same chunk text the vectors index.
   *
   * Reads `search_vector`, a stored generated column, rather than building the tsvector per
   * row. The GIN index could satisfy the match but not the ranking, so every matched row
   * was rebuilt to be scored — on a real code a broad query matches around 17,500 chunks,
   * and that rebuild was most of the query's time.
   *
   * `sourceVersionIds` is always supplied by the caller *after* running the ACL
   * predicate, so this query can never reach a document the user may not see.
   */
  async lexicalSearch(
    ctx: TenantContext,
    scope: RetrievalScope,
    query: string,
    limit: number,
  ): Promise<ChunkCandidate[]> {
    if (scope.sourceVersionIds.length === 0 || !query.trim()) return [];
    const parts = RetrievalRepository.tsQueryParts(query);
    if (!parts) return [];

    /*
     * Precision first, then recall, in one pass.
     *
     * `matched_all` is 1 for a chunk that contains every query term and 0 otherwise, and it
     * is the primary sort key. So a passage answering the whole question outranks every
     * passage that merely shares a common word with it, and when nothing matches everything
     * — which is the usual case for a natural question — the ordering falls back to
     * `ts_rank_cd` over the OR query exactly as before.
     */
    const rows = await this.db.execute(sql`
      WITH q AS (
        SELECT to_tsquery('english', ${parts.any}) AS tsq,
               to_tsquery('english', ${parts.all}) AS tsq_all
      )
      SELECT
        c.id, c.source_id, c.source_version_id, c.ordinal, c.content,
        c.page_number, c.page_end, c.sheet_name, c.cell_range, c.slide_number,
        c.chapter, c.section, c.clause, c.heading_path, c.paragraph_index,
        c.char_start, c.char_end, c.kind,
        s.title AS document_title, s.document_type, s.effective_date,
        v.sha256 AS source_sha256, v.version AS source_version_label,
        ts_rank_cd(c.search_vector, q.tsq, 32) AS rank,
        (c.search_vector @@ q.tsq_all) AS matched_all
      FROM source_chunks c
      CROSS JOIN q
      JOIN sources s ON s.id = c.source_id
      JOIN source_versions v ON v.id = c.source_version_id
      WHERE c.workspace_id = ${ctx.workspaceId}
        AND c.source_version_id = ANY(${sql.param(scope.sourceVersionIds)}::text[])
        AND c.search_vector @@ q.tsq
      ORDER BY matched_all DESC, rank DESC
      LIMIT ${limit}
    `);

    return this.mapCandidates(rows as unknown as Array<Record<string, unknown>>, 'lexical');
  }

  /**
   * Vector half of hybrid retrieval. Cosine distance via pgvector; `1 - distance` gives a
   * 0..1 similarity that is directly comparable across queries.
   */
  async vectorSearch(
    ctx: TenantContext,
    scope: RetrievalScope,
    embedding: number[],
    model: string,
    limit: number,
  ): Promise<ChunkCandidate[]> {
    if (scope.sourceVersionIds.length === 0 || embedding.length === 0) return [];
    const literal = `[${embedding.join(',')}]`;

    const rows = await this.db.execute(sql`
      SELECT
        c.id, c.source_id, c.source_version_id, c.ordinal, c.content,
        c.page_number, c.page_end, c.sheet_name, c.cell_range, c.slide_number,
        c.chapter, c.section, c.clause, c.heading_path, c.paragraph_index,
        c.char_start, c.char_end, c.kind,
        s.title AS document_title, s.document_type, s.effective_date,
        v.sha256 AS source_sha256, v.version AS source_version_label,
        1 - (e.embedding <=> ${literal}::vector) AS rank
      FROM embeddings e
      JOIN source_chunks c ON c.id = e.chunk_id
      JOIN sources s ON s.id = c.source_id
      JOIN source_versions v ON v.id = c.source_version_id
      WHERE e.workspace_id = ${ctx.workspaceId}
        AND e.source_version_id = ANY(${sql.param(scope.sourceVersionIds)}::text[])
        AND e.model = ${model}
      ORDER BY e.embedding <=> ${literal}::vector
      LIMIT ${limit}
    `);

    return this.mapCandidates(rows as unknown as Array<Record<string, unknown>>, 'vector');
  }

  /**
   * Whether these documents are embedded under a model other than the one asking.
   *
   * `vectorSearch` filters on the embedding model, so a deployment that switches embedding
   * providers without re-embedding gets zero vector rows for every query — retrieval
   * silently drops to lexical-only, with no error and nothing on screen to say the semantic
   * half has stopped working. This distinguishes that from a corpus that simply has no
   * embeddings yet, which is a different and much more visible problem.
   */
  async embeddedUnderOtherModel(
    ctx: TenantContext,
    scope: RetrievalScope,
    model: string,
  ): Promise<boolean> {
    if (scope.sourceVersionIds.length === 0) return false;
    const rows = (await this.db.execute(sql`
      SELECT 1
        FROM embeddings e
       WHERE e.workspace_id = ${ctx.workspaceId}
         AND e.source_version_id = ANY(${sql.param(scope.sourceVersionIds)}::text[])
         AND e.model <> ${model}
       LIMIT 1
    `)) as unknown as unknown[];
    return Array.isArray(rows) && rows.length > 0;
  }

  /**
   * The clause a query names, matched against the column that holds it.
   *
   * Structure detection lifts "6.4.2" out of the heading into `clause`, and the body below
   * a heading does not repeat it — so on a real code, a clause number is absent from the
   * indexed text of all but a handful of the chunks that carry one. Searching for it as
   * text found nothing, whatever the ranking did afterwards.
   *
   * This does not search text at all. It reads the identifier the indexer already parsed,
   * which is exact, needs no extraction to have gone well, and is the one lookup in a
   * compliance product that should never be approximate.
   *
   * Sub-clauses come back under their parent — asking for 6.4 returns 6.4.1 and 6.4.2 —
   * but always after every exact match, so naming a clause precisely still puts that clause
   * first.
   */
  async locatorSearch(
    ctx: TenantContext,
    scope: RetrievalScope,
    locators: string[],
    limit: number,
  ): Promise<ChunkCandidate[]> {
    if (scope.sourceVersionIds.length === 0 || locators.length === 0) return [];

    // Bounded so a query full of numbers cannot turn into an unbounded prefix scan.
    const wanted = [...new Set(locators.map((l) => l.trim()).filter(Boolean))].slice(0, 8);
    if (wanted.length === 0) return [];
    const prefixes = wanted.map((l) => `${l}.%`);

    const rows = await this.db.execute(sql`
      SELECT
        c.id, c.source_id, c.source_version_id, c.ordinal, c.content,
        c.page_number, c.page_end, c.sheet_name, c.cell_range, c.slide_number,
        c.chapter, c.section, c.clause, c.heading_path, c.paragraph_index,
        c.char_start, c.char_end, c.kind,
        s.title AS document_title, s.document_type, s.effective_date,
        v.sha256 AS source_sha256, v.version AS source_version_label,
        CASE
          WHEN c.clause = ANY(${sql.param(wanted)}::text[]) THEN 1.0
          WHEN c.section = ANY(${sql.param(wanted)}::text[]) THEN 0.8
          WHEN c.chapter = ANY(${sql.param(wanted)}::text[]) THEN 0.6
          ELSE 0.4
        END AS rank
      FROM source_chunks c
      JOIN sources s ON s.id = c.source_id
      JOIN source_versions v ON v.id = c.source_version_id
      WHERE c.workspace_id = ${ctx.workspaceId}
        AND c.source_version_id = ANY(${sql.param(scope.sourceVersionIds)}::text[])
        AND (
          c.clause = ANY(${sql.param(wanted)}::text[])
          OR c.section = ANY(${sql.param(wanted)}::text[])
          OR c.chapter = ANY(${sql.param(wanted)}::text[])
          OR c.clause LIKE ANY(${sql.param(prefixes)}::text[])
        )
      ORDER BY rank DESC, c.ordinal ASC
      LIMIT ${limit}
    `);

    return this.mapCandidates(rows as unknown as Array<Record<string, unknown>>, 'locator');
  }

  private mapCandidates(
    rows: Array<Record<string, unknown>>,
    channel: 'lexical' | 'vector' | 'locator',
  ): ChunkCandidate[] {
    const list = Array.isArray(rows) ? rows : [];
    // Normalise raw ranks to 0..1 within this result set so the two channels are fusible.
    const maxRank = list.reduce((m, r) => Math.max(m, Number(r.rank ?? 0)), 0) || 1;

    return list.map((r, index) => ({
      chunkId: String(r.id),
      sourceId: String(r.source_id),
      sourceVersionId: String(r.source_version_id),
      ordinal: Number(r.ordinal),
      content: String(r.content),
      pageNumber: r.page_number === null ? null : Number(r.page_number),
      pageEnd: r.page_end === null ? null : Number(r.page_end),
      sheetName: r.sheet_name === null ? null : String(r.sheet_name),
      cellRange: r.cell_range === null ? null : String(r.cell_range),
      slideNumber: r.slide_number === null ? null : Number(r.slide_number),
      chapter: r.chapter === null ? null : String(r.chapter),
      section: r.section === null ? null : String(r.section),
      clause: r.clause === null ? null : String(r.clause),
      headingPath: Array.isArray(r.heading_path) ? (r.heading_path as string[]) : [],
      paragraphIndex: r.paragraph_index === null ? null : Number(r.paragraph_index),
      charStart: Number(r.char_start ?? 0),
      charEnd: Number(r.char_end ?? 0),
      kind: String(r.kind ?? 'prose'),
      documentTitle: String(r.document_title),
      documentType: String(r.document_type),
      sourceSha256: String(r.source_sha256),
      sourceVersionLabel: String(r.source_version_label),
      effectiveDate: r.effective_date ? new Date(String(r.effective_date)) : null,
      score: Math.max(0, Math.min(1, Number(r.rank ?? 0) / maxRank)),
      channel,
      rank: index + 1,
    }));
  }

  /**
   * Parent/neighbour expansion. After reranking, the winning chunks are widened by their
   * immediate neighbours so a clause split across a chunk boundary is still quoted whole.
   */
  async neighbours(ctx: TenantContext, versionId: string, ordinals: number[], radius = 1) {
    if (ordinals.length === 0) return [];
    const wanted = new Set<number>();
    for (const o of ordinals) {
      for (let d = -radius; d <= radius; d += 1) wanted.add(o + d);
    }
    const list = [...wanted].filter((n) => n >= 0);
    if (list.length === 0) return [];

    return this.db
      .select()
      .from(sourceChunks)
      .where(
        and(
          eq(sourceChunks.workspaceId, ctx.workspaceId),
          eq(sourceChunks.sourceVersionId, versionId),
          inArray(sourceChunks.ordinal, list),
        ),
      )
      .orderBy(asc(sourceChunks.ordinal));
  }

  /** Page text is the ground truth that citation verification re-checks excerpts against. */
  async getPage(ctx: TenantContext, versionId: string, pageNumber: number) {
    const [row] = await this.db
      .select()
      .from(sourcePages)
      .where(
        and(
          eq(sourcePages.workspaceId, ctx.workspaceId),
          eq(sourcePages.sourceVersionId, versionId),
          eq(sourcePages.pageNumber, pageNumber),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async getPages(ctx: TenantContext, versionId: string) {
    return this.db
      .select()
      .from(sourcePages)
      .where(
        and(
          eq(sourcePages.workspaceId, ctx.workspaceId),
          eq(sourcePages.sourceVersionId, versionId),
        ),
      )
      .orderBy(asc(sourcePages.pageNumber));
  }

  async getChunk(ctx: TenantContext, chunkId: string) {
    const [row] = await this.db
      .select()
      .from(sourceChunks)
      .where(and(eq(sourceChunks.id, chunkId), eq(sourceChunks.workspaceId, ctx.workspaceId)))
      .limit(1);
    return row ?? null;
  }

  /** Requirement extraction reads the sections flagged as obligations during indexing. */
  async requirementSections(ctx: TenantContext, versionIds: string[]) {
    if (versionIds.length === 0) return [];
    return this.db
      .select()
      .from(sourceSections)
      .where(
        and(
          eq(sourceSections.workspaceId, ctx.workspaceId),
          inArray(sourceSections.sourceVersionId, versionIds),
          eq(sourceSections.isRequirement, true),
        ),
      )
      .orderBy(asc(sourceSections.sourceVersionId), asc(sourceSections.ordinal));
  }

  async sectionsForVersion(ctx: TenantContext, versionId: string) {
    return this.db
      .select()
      .from(sourceSections)
      .where(
        and(
          eq(sourceSections.workspaceId, ctx.workspaceId),
          eq(sourceSections.sourceVersionId, versionId),
        ),
      )
      .orderBy(asc(sourceSections.ordinal));
  }

  async chunksForVersion(ctx: TenantContext, versionId: string) {
    return this.db
      .select()
      .from(sourceChunks)
      .where(
        and(
          eq(sourceChunks.workspaceId, ctx.workspaceId),
          eq(sourceChunks.sourceVersionId, versionId),
        ),
      )
      .orderBy(asc(sourceChunks.ordinal));
  }

  /** Resolves the current version id for each source, used when scoping retrieval. */
  async currentVersionIds(ctx: TenantContext, sourceIds: string[]) {
    if (sourceIds.length === 0) return [];
    const rows = await this.db
      .select({ sourceId: sources.id, versionId: sourceVersions.id })
      .from(sources)
      .innerJoin(
        sourceVersions,
        and(eq(sourceVersions.sourceId, sources.id), eq(sourceVersions.isCurrent, true)),
      )
      .where(and(eq(sources.workspaceId, ctx.workspaceId), inArray(sources.id, sourceIds)));
    return rows;
  }

  /** Extraction coverage: how much of the page text ended up inside an indexed chunk. */
  async extractionCoverage(versionId: string): Promise<number> {
    const rows = await this.db.execute(sql`
      SELECT
        (SELECT coalesce(sum(length(text)), 0) FROM source_pages WHERE source_version_id = ${versionId}) AS page_chars,
        (SELECT coalesce(sum(length(content)), 0) FROM source_chunks WHERE source_version_id = ${versionId}) AS chunk_chars
    `);
    const first = (rows as unknown as Array<Record<string, unknown>>)[0];
    const pageChars = Number(first?.page_chars ?? 0);
    const chunkChars = Number(first?.chunk_chars ?? 0);
    if (pageChars === 0) return 0;
    // Overlap can push chunk_chars above page_chars; coverage is capped at 1.
    return Math.min(1, chunkChars / pageChars);
  }
}
