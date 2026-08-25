import { normalizeWhitespace, splitSentences } from './text.js';

export interface ExtractedPage {
  pageNumber: number;
  text: string;
  width: number | null;
  height: number | null;
  sheetName: string | null;
  slideNumber: number | null;
  ocrApplied: boolean;
  ocrConfidence: number | null;
  wordBoxes: Array<{ t: string; x: number; y: number; w: number; h: number }>;
}

export type SectionKind = 'heading' | 'clause' | 'table' | 'definition' | 'list' | 'paragraph';
export type Modality = 'mandatory' | 'recommended' | 'permissive' | 'prohibited';

export interface DetectedSection {
  ordinal: number;
  level: number;
  kind: SectionKind;
  /**
   * True when `title` was read from a heading line in the document.
   *
   * Body text that appears before any heading inherits a title (or gets a synthetic
   * "Introduction"), and that string is NOT present in the page text. Prefixing a chunk
   * with it would produce excerpts that fail verbatim citation verification, so chunking
   * only prepends the title when this flag is set.
   */
  fromHeading: boolean;
  chapter: string | null;
  section: string | null;
  clause: string | null;
  title: string;
  body: string;
  headingPath: string[];
  pageNumber: number | null;
  charStart: number;
  charEnd: number;
  modality: Modality | null;
  isRequirement: boolean;
  effectiveDate: Date | null;
  supersededNote: string | null;
  crossReferences: string[];
  exceptions: string[];
}

/**
 * Numbered heading, e.g. "6.4.2 Emergency illumination" or "Article 12 - Scope".
 * Anchored to the start of a line and deliberately conservative: matching a mid-sentence
 * decimal as a clause number would shred the document structure.
 */
const NUMBERED_HEADING = /^\s{0,6}((?:\d{1,3})(?:\.\d{1,3}){0,5})\.?\s+([A-Z(À-ɏ][^\n]{2,140})$/;

/** "CHAPTER 6", "Section 4", "Article 12", "Annex B", "Part III", "Schedule 2". */
const NAMED_HEADING =
  /^\s{0,6}(chapter|section|article|annex|appendix|part|schedule|clause)\s+([0-9IVXLC]+(?:\.\d+)*|[A-Z])\b[.:\s-]*(.*)$/i;

/** ALL-CAPS or Title Case line with no terminal punctuation. */
const BARE_HEADING = /^\s{0,6}([A-Z][A-Z0-9 &/,'()-]{4,80})\s*$/;

const TABLE_HINT = /^\s*(table|figure|fig\.|exhibit|schedule)\s+[0-9A-Z]/i;
const DEFINITION_HINT =
  /^\s*["“]?([A-Z][\w \-/]{2,60})["”]?\s+(means|shall mean|is defined as|refers to)\b/;
const LIST_ITEM = /^\s*(?:[-*•●▪]|\(?[a-z]\)|\(?[ivx]+\)|\d{1,2}\))\s+/i;

/** "Notwithstanding", "Except as provided", "Unless otherwise" introduce exceptions. */
const EXCEPTION_HINT =
  /\b(notwithstanding|except (?:as|where|when)|unless otherwise|save (?:as|where)|does not apply|shall not apply|exempt(?:ion|ed)?)\b/i;

/** Cross-reference to another clause: "in accordance with 6.4.2", "see Section 3.1". */
const CROSS_REF =
  /\b(?:see|refer to|in accordance with|as (?:specified|defined|required) in|per|pursuant to|subject to)\s+((?:clause|section|article|annex|table|part|chapter)?\s*[0-9A-Z]+(?:\.\d+)*)/gi;

const SUPERSEDED_HINT =
  /\b(superseded by|replaced by|withdrawn|no longer (?:in force|applicable)|repealed)\b[^.]{0,80}/i;

const EFFECTIVE_DATE =
  /\b(?:effective(?: (?:from|on|date))?|in force (?:from|on)|applies from|comes into (?:force|effect) on)\s*:?\s*(\d{1,2}\s+\w+\s+\d{4}|\w+\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2})/i;

/**
 * Detects the modality of an obligation.
 *
 * The distinction is load-bearing: only `mandatory` and `prohibited` statements can make a
 * document non-compliant. Reporting a "should" as a violation would be a false positive,
 * and reporting a "shall" as advisory would be a dangerous false negative.
 */
export function detectModality(text: string): Modality | null {
  const t = text.toLowerCase();
  if (/\b(shall not|must not|may not|is prohibited|are prohibited|no .{0,30}shall)\b/.test(t)) {
    return 'prohibited';
  }
  if (/\b(shall|must|is required to|are required to|is mandatory)\b/.test(t)) return 'mandatory';
  if (/\b(should|is recommended|are recommended|ought to)\b/.test(t)) return 'recommended';
  if (/\b(may|is permitted|are permitted|is allowed|can be)\b/.test(t)) return 'permissive';
  return null;
}

/** A requirement is a mandatory or prohibitive statement with enough substance to test. */
export function isRequirementText(text: string): boolean {
  const modality = detectModality(text);
  if (modality !== 'mandatory' && modality !== 'prohibited') return false;
  return normalizeWhitespace(text).length >= 40;
}

export function extractCrossReferences(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(CROSS_REF)) {
    const ref = normalizeWhitespace(match[1] ?? '');
    if (ref && ref.length <= 40) out.add(ref);
  }
  return [...out];
}

export function extractExceptions(text: string): string[] {
  return splitSentences(text).filter((s) => EXCEPTION_HINT.test(s));
}

function parseEffectiveDate(text: string): Date | null {
  const match = text.match(EFFECTIVE_DATE);
  if (!match?.[1]) return null;
  const parsed = new Date(match[1]);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

interface HeadingHit {
  chapter: string | null;
  section: string | null;
  clause: string | null;
  title: string;
  level: number;
  kind: SectionKind;
}

/** Recognises a heading line and derives chapter/section/clause from its numbering. */
export function detectHeading(line: string): HeadingHit | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 200) return null;
  if (LIST_ITEM.test(trimmed) && !NUMBERED_HEADING.test(trimmed)) return null;

  if (TABLE_HINT.test(trimmed)) {
    return { chapter: null, section: null, clause: null, title: trimmed, level: 3, kind: 'table' };
  }

  const numbered = trimmed.match(NUMBERED_HEADING);
  if (numbered?.[1] && numbered[2]) {
    const number = numbered[1];
    const parts = number.split('.');
    const depth = parts.length;
    return {
      chapter: parts[0] ?? null,
      // "6.4" is a section; "6.4.2" and deeper are clauses.
      section: depth >= 2 ? parts.slice(0, 2).join('.') : null,
      clause: depth >= 3 ? number : null,
      title: normalizeWhitespace(numbered[2]),
      level: Math.min(depth, 6),
      kind: depth >= 3 ? 'clause' : 'heading',
    };
  }

  const named = trimmed.match(NAMED_HEADING);
  if (named?.[1] && named[2]) {
    const keyword = named[1].toLowerCase();
    const number = named[2];
    const rest = normalizeWhitespace(named[3] ?? '');
    const isChapter = keyword === 'chapter' || keyword === 'part';
    return {
      chapter: isChapter ? number : null,
      section: keyword === 'section' || keyword === 'article' ? number : null,
      clause: keyword === 'clause' ? number : null,
      title: rest ? `${named[1]} ${number} ${rest}` : `${named[1]} ${number}`,
      level: isChapter ? 1 : 2,
      kind: 'heading',
    };
  }

  const bare = trimmed.match(BARE_HEADING);
  if (bare?.[1] && !/[.!?;:]$/.test(trimmed)) {
    return {
      chapter: null,
      section: null,
      clause: null,
      title: normalizeWhitespace(bare[1]),
      level: 2,
      kind: 'heading',
    };
  }

  return null;
}

/**
 * Walks the extracted pages and produces an ordered section tree.
 *
 * Inherited chapter/section/clause context is the reason a citation can say
 * "Ch. 6 - §6.4.2 - p. 214" even when the paragraph itself contains no numbering: the
 * numbers come from the nearest enclosing heading, not from the sentence.
 */
export function detectStructure(pages: ExtractedPage[]): DetectedSection[] {
  const sections: DetectedSection[] = [];
  let ordinal = 0;
  let offset = 0;

  let chapter: string | null = null;
  let section: string | null = null;
  let clause: string | null = null;
  const headingStack: Array<{ level: number; title: string }> = [];

  let current: DetectedSection | null = null;

  const pushCurrent = () => {
    if (!current) return;
    const body = current.body.trim();
    current.body = body;
    current.charEnd = current.charStart + body.length;
    current.modality = detectModality(`${current.title} ${body}`);
    current.isRequirement = isRequirementText(`${current.title}. ${body}`);
    current.crossReferences = extractCrossReferences(body);
    current.exceptions = extractExceptions(body);
    current.effectiveDate = parseEffectiveDate(body);
    const superseded = body.match(SUPERSEDED_HINT);
    current.supersededNote = superseded ? normalizeWhitespace(superseded[0]) : null;
    sections.push(current);
    current = null;
  };

  for (const page of pages) {
    const lines = page.text.split(/\r?\n/);
    for (const line of lines) {
      const heading = detectHeading(line);

      if (heading) {
        pushCurrent();

        if (heading.chapter) {
          chapter = heading.chapter;
          section = null;
          clause = null;
        }
        if (heading.section) {
          section = heading.section;
          clause = null;
          if (!chapter) chapter = heading.section.split('.')[0] ?? null;
        }
        if (heading.clause) {
          clause = heading.clause;
          const parts = heading.clause.split('.');
          chapter ??= parts[0] ?? null;
          section ??= parts.slice(0, 2).join('.');
        }
        if (!heading.chapter && !heading.section && !heading.clause) {
          // A bare or table heading does not change the numbering context.
        }

        while (headingStack.length > 0 && (headingStack.at(-1)?.level ?? 0) >= heading.level) {
          headingStack.pop();
        }
        headingStack.push({ level: heading.level, title: heading.title });

        ordinal += 1;
        current = {
          ordinal,
          level: heading.level,
          kind: heading.kind,
          fromHeading: true,
          chapter,
          section,
          clause,
          title: heading.title,
          body: '',
          headingPath: headingStack.map((h) => h.title),
          pageNumber: page.pageNumber,
          charStart: offset,
          charEnd: offset,
          modality: null,
          isRequirement: false,
          effectiveDate: null,
          supersededNote: null,
          crossReferences: [],
          exceptions: [],
        };
        offset += line.length + 1;
        continue;
      }

      if (!current) {
        // Body text before any heading still needs a home so nothing is lost.
        ordinal += 1;
        current = {
          ordinal,
          level: headingStack.length || 1,
          kind: 'paragraph',
          fromHeading: false,
          chapter,
          section,
          clause,
          title: headingStack.at(-1)?.title ?? 'Introduction',
          body: '',
          headingPath: headingStack.map((h) => h.title),
          pageNumber: page.pageNumber,
          charStart: offset,
          charEnd: offset,
          modality: null,
          isRequirement: false,
          effectiveDate: null,
          supersededNote: null,
          crossReferences: [],
          exceptions: [],
        };
      }

      const trimmed = line.trim();
      if (DEFINITION_HINT.test(trimmed) && current.kind === 'paragraph') {
        current.kind = 'definition';
      } else if (LIST_ITEM.test(trimmed) && current.kind === 'paragraph') {
        current.kind = 'list';
      }

      current.body += `${line}\n`;
      offset += line.length + 1;
    }
  }

  pushCurrent();
  return sections.filter((s) => s.title.trim().length > 0 || s.body.trim().length > 0);
}

/** A stable, human-readable reference for a section, used as the requirement reference. */
export function sectionReference(section: DetectedSection): string {
  if (section.clause) return section.clause;
  if (section.section) return section.section;
  if (section.chapter) return `Ch. ${section.chapter}`;
  return section.title.slice(0, 60);
}
