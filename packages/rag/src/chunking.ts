import type { DetectedSection, ExtractedPage } from './structure.js';
import { normalizeWhitespace, splitSentences } from './text.js';

export interface Chunk {
  ordinal: number;
  /** Verbatim text from the source page. Never contains synthetic prefixes. */
  content: string;
  /** Parent heading path. Indexed and embedded, but never quoted as source text. */
  headingText: string;
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
  sectionOrdinal: number | null;
}

export interface ChunkOptions {
  /** Target size in approximate tokens. Regulations chunk smaller than prose on purpose. */
  targetTokens?: number;
  maxTokens?: number;
  /** Sentences of context carried into the next chunk within the same section. */
  overlapSentences?: number;
  /** Carry the heading path alongside each chunk so retrieval sees the context. */
  includeHeadingContext?: boolean;
}

const DEFAULTS: Required<ChunkOptions> = {
  targetTokens: 320,
  maxTokens: 512,
  overlapSentences: 1,
  includeHeadingContext: true,
};

/** Rough token estimate. Close enough for budgeting; exactness is not required here. */
export function estimateTokens(text: string): number {
  return Math.ceil(normalizeWhitespace(text).length / 4);
}

/**
 * Structural chunking.
 *
 * Rules that matter for evidence quality:
 *  1. A chunk never spans two sections. Mixing clause 6.4.2 with 6.5.1 would let the
 *     system quote text under the wrong clause number, which is the single worst failure
 *     mode in a compliance product.
 *  2. Tables and definitions are emitted whole even when they exceed the target size,
 *     because half a table is not evidence.
 *  3. Overlap is applied only *within* a section, so context is carried without ever
 *     leaking across an unrelated boundary.
 *  4. The parent heading path is prefixed to the chunk body so that both the lexical and
 *     the vector index see "Chapter 6 > Emergency lighting" alongside the sentence.
 */
export function chunkSections(sections: DetectedSection[], options: ChunkOptions = {}): Chunk[] {
  const opts = { ...DEFAULTS, ...options };
  const chunks: Chunk[] = [];
  let ordinal = 0;

  for (const section of sections) {
    const body = normalizeWhitespace(section.body);
    /**
     * The title is prepended only when it is real source text.
     *
     * Two things disqualify it. First, an inherited or synthetic title (`fromHeading`
     * false) does not appear on the page at all, so quoting it would make the excerpt
     * unverifiable. Second, regulations routinely repeat the heading as the opening words
     * of the clause ("6.4.2 Emergency illumination" then "Emergency illumination shall
     * ..."), where re-prefixing would produce a stuttering quotation.
     */
    const titlePrefix =
      section.fromHeading &&
      section.title &&
      !body.toLowerCase().startsWith(section.title.toLowerCase())
        ? `${section.title}\n`
        : '';
    const headingLine =
      section.headingPath.length > 0 ? section.headingPath.join(' > ') : section.title;
    const headingText = opts.includeHeadingContext ? headingLine : '';

    const base = {
      headingText,
      pageNumber: section.pageNumber,
      pageEnd: section.pageNumber,
      sheetName: null,
      cellRange: null,
      slideNumber: null,
      chapter: section.chapter,
      section: section.section,
      clause: section.clause,
      headingPath: section.headingPath,
      kind: section.kind,
      sectionOrdinal: section.ordinal,
    };

    // Tables and definitions stay intact regardless of size.
    if (section.kind === 'table' || section.kind === 'definition') {
      const content = `${titlePrefix}${body}`.trim();
      if (content) {
        ordinal += 1;
        chunks.push({
          ...base,
          ordinal,
          content,
          tokenCount: estimateTokens(content),
          paragraphIndex: 0,
          charStart: section.charStart,
          charEnd: section.charEnd,
        });
      }
      continue;
    }

    const sentences = splitSentences(body);

    // A heading with no body still deserves a chunk so the clause is findable by title.
    if (sentences.length === 0) {
      const content = section.title.trim();
      if (content) {
        ordinal += 1;
        chunks.push({
          ...base,
          ordinal,
          content,
          tokenCount: estimateTokens(content),
          paragraphIndex: 0,
          charStart: section.charStart,
          charEnd: section.charEnd,
        });
      }
      continue;
    }

    let buffer: string[] = [];
    let bufferTokens = 0;
    let paragraphIndex = 0;
    let charCursor = section.charStart;

    const flush = () => {
      if (buffer.length === 0) return;
      const joined = buffer.join(' ');
      const content = `${titlePrefix}${joined}`.trim();
      ordinal += 1;
      chunks.push({
        ...base,
        ordinal,
        content,
        tokenCount: estimateTokens(content),
        paragraphIndex,
        charStart: charCursor,
        charEnd: charCursor + joined.length,
      });
      paragraphIndex += 1;
      charCursor += joined.length;

      // Carry the tail sentences forward as overlap, within this section only.
      const carry = opts.overlapSentences > 0 ? buffer.slice(-opts.overlapSentences) : [];
      buffer = [...carry];
      bufferTokens = carry.reduce((sum, s) => sum + estimateTokens(s), 0);
    };

    for (const sentence of sentences) {
      const tokens = estimateTokens(sentence);

      // A single sentence longer than the hard limit is emitted alone rather than split,
      // so a long obligation is never quoted as a fragment.
      if (tokens > opts.maxTokens) {
        flush();
        const content = `${titlePrefix}${sentence}`.trim();
        ordinal += 1;
        chunks.push({
          ...base,
          ordinal,
          content,
          tokenCount: estimateTokens(content),
          paragraphIndex,
          charStart: charCursor,
          charEnd: charCursor + sentence.length,
        });
        paragraphIndex += 1;
        charCursor += sentence.length;
        buffer = [];
        bufferTokens = 0;
        continue;
      }

      if (bufferTokens + tokens > opts.targetTokens && buffer.length > 0) flush();
      buffer.push(sentence);
      bufferTokens += tokens;
    }

    // Final flush without overlap carry-over.
    if (buffer.length > 0) {
      const joined = buffer.join(' ');
      const content = `${titlePrefix}${joined}`.trim();
      ordinal += 1;
      chunks.push({
        ...base,
        ordinal,
        content,
        tokenCount: estimateTokens(content),
        paragraphIndex,
        charStart: charCursor,
        charEnd: charCursor + joined.length,
      });
    }
  }

  return chunks;
}

/**
 * Spreadsheets chunk by sheet and row block rather than by sentence, and carry a cell
 * range so a citation can point at "Sheet Budget - B12:D40" instead of a page number
 * that does not exist.
 */
export function chunkSpreadsheet(
  pages: ExtractedPage[],
  options: { rowsPerChunk?: number } = {},
): Chunk[] {
  const rowsPerChunk = options.rowsPerChunk ?? 40;
  const chunks: Chunk[] = [];
  let ordinal = 0;

  for (const page of pages) {
    const rows = page.text.split(/\r?\n/).filter((r) => r.trim().length > 0);
    const header = rows[0] ?? '';

    for (let i = 0; i < rows.length; i += rowsPerChunk) {
      const block = rows.slice(i, i + rowsPerChunk);
      if (block.length === 0) continue;
      // Repeat the header row in every block so column meaning survives chunking.
      const content = i === 0 ? block.join('\n') : `${header}\n${block.join('\n')}`;
      const firstRow = i + 1;
      const lastRow = i + block.length;

      ordinal += 1;
      chunks.push({
        ordinal,
        content,
        headingText: page.sheetName ?? 'Sheet',
        tokenCount: estimateTokens(content),
        pageNumber: page.pageNumber,
        pageEnd: page.pageNumber,
        sheetName: page.sheetName,
        cellRange: `A${firstRow}:${lastRow === firstRow ? `A${firstRow}` : `Z${lastRow}`}`,
        slideNumber: null,
        chapter: null,
        section: null,
        clause: null,
        headingPath: page.sheetName ? [page.sheetName] : [],
        paragraphIndex: Math.floor(i / rowsPerChunk),
        charStart: 0,
        charEnd: content.length,
        kind: 'table',
        sectionOrdinal: null,
      });
    }
  }

  return chunks;
}

/** Slides chunk one-per-slide: a slide is already the author's unit of meaning. */
export function chunkSlides(pages: ExtractedPage[]): Chunk[] {
  return pages
    .filter((p) => p.text.trim().length > 0)
    .map((page, index) => ({
      ordinal: index + 1,
      content: page.text.trim(),
      headingText: '',
      tokenCount: estimateTokens(page.text),
      pageNumber: page.pageNumber,
      pageEnd: page.pageNumber,
      sheetName: null,
      cellRange: null,
      slideNumber: page.slideNumber ?? page.pageNumber,
      chapter: null,
      section: null,
      clause: null,
      headingPath: [],
      paragraphIndex: 0,
      charStart: 0,
      charEnd: page.text.length,
      kind: 'prose',
      sectionOrdinal: null,
    }));
}

/**
 * The text an embedding is computed from: heading context plus the verbatim body.
 *
 * Kept separate from `content` so the vector index benefits from parent-heading context
 * while the quotable text stays byte-faithful to the source page.
 */
export function embeddingInput(chunk: Pick<Chunk, 'content' | 'headingText'>): string {
  return chunk.headingText ? `${chunk.headingText}\n${chunk.content}` : chunk.content;
}
