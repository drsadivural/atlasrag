import type { BoundingBox, Citation, Entailment } from '@uxe/contracts';
import { findExcerpt, normalizeForMatch, normalizeWhitespace, splitSentences, truncateExcerpt } from './text.js';
import type { FusedCandidate } from './fusion.js';

export interface PageRecord {
  pageNumber: number;
  text: string;
  width: number | null;
  height: number | null;
  wordBoxes: Array<{ t: string; x: number; y: number; w: number; h: number }>;
}

export interface CitationDraft {
  citationId: string;
  sourceId: string;
  sourceVersionId: string;
  sourceSha256: string;
  documentTitle: string;
  documentType: string;
  pageNumber: number | null;
  sheetName: string | null;
  cellRange: string | null;
  slideNumber: number | null;
  shapeName: string | null;
  chapter: string | null;
  section: string | null;
  clause: string | null;
  headingPath: string[];
  paragraphIndex: number | null;
  charStart: number | null;
  charEnd: number | null;
  urlFragment: string | null;
  boundingBoxes: BoundingBox[];
  supportingExcerpt: string;
  retrievalScore: number;
  rerankScore: number;
  entailment: Entailment;
  effectiveDate: Date | null;
}

export interface VerificationResult {
  verified: boolean;
  method: 'exact' | 'normalized' | 'failed';
  /** Why verification failed, surfaced in the evidence drawer rather than hidden. */
  reason: string | null;
  charStart: number | null;
  charEnd: number | null;
  boundingBoxes: BoundingBox[];
}

/**
 * Re-checks a citation's excerpt against the stored extracted text for the page it claims
 * to come from.
 *
 * This is the gate that makes "never invent a source, page, clause or quote" enforceable
 * rather than aspirational. It runs after the answer is drafted and before anything is
 * persisted or shown. Two independent things are checked:
 *
 *   1. The excerpt exists verbatim in the page text (exact, or after Unicode/whitespace
 *      folding — a PDF ligature must not fail an otherwise honest quote).
 *   2. The excerpt is found on the page the citation *claims*, not merely somewhere in the
 *      document. A quote that is real but attributed to the wrong page is still a wrong
 *      citation, and clicking it would open the wrong place.
 *
 * A failure never silently drops the answer; it downgrades the citation to unverified so
 * the reader sees the distinction.
 */
export function verifyExcerpt(
  excerpt: string,
  page: PageRecord | null,
  options: { computeBoxes?: boolean } = {},
): VerificationResult {
  const trimmed = normalizeWhitespace(excerpt);

  if (!trimmed) {
    return { verified: false, method: 'failed', reason: 'Excerpt is empty', charStart: null, charEnd: null, boundingBoxes: [] };
  }
  if (!page) {
    return {
      verified: false,
      method: 'failed',
      reason: 'The cited page could not be loaded from stored extracted text',
      charStart: null,
      charEnd: null,
      boundingBoxes: [],
    };
  }

  const span = findExcerpt(page.text, excerpt);
  if (!span) {
    return {
      verified: false,
      method: 'failed',
      reason: `Excerpt does not appear on page ${page.pageNumber} of the stored source text`,
      charStart: null,
      charEnd: null,
      boundingBoxes: [],
    };
  }

  const boxes =
    options.computeBoxes === false ? [] : computeBoundingBoxes(page, page.text.slice(span.start, span.end));

  return {
    verified: true,
    method: span.method,
    reason: null,
    charStart: span.start,
    charEnd: span.end,
    boundingBoxes: boxes,
  };
}

/**
 * Derives highlight rectangles from the per-word boxes captured during extraction.
 *
 * Words are grouped into visual lines (by y-centre) and merged into one rectangle per line,
 * which is what a reader expects a highlight to look like across a wrapped sentence.
 * Returns an empty array when the document has no coordinate data at all (plain text,
 * HTML, some OCR paths) — the viewer then falls back to a text-offset highlight.
 */
export function computeBoundingBoxes(page: PageRecord, excerpt: string): BoundingBox[] {
  if (page.wordBoxes.length === 0) return [];

  const target = normalizeForMatch(excerpt)
    .split(' ')
    .filter((w) => w.length > 0);
  if (target.length === 0) return [];

  const words = page.wordBoxes.map((w) => ({ ...w, norm: normalizeForMatch(w.t) }));

  // Locate the contiguous run of word boxes matching the excerpt.
  let matchStart = -1;
  for (let i = 0; i + target.length <= words.length; i += 1) {
    let ok = true;
    for (let j = 0; j < target.length; j += 1) {
      const candidate = words[i + j]?.norm ?? '';
      const wanted = target[j] ?? '';
      // Trailing punctuation is stripped by normalisation on one side only, so allow a
      // prefix match on the final token.
      if (candidate !== wanted && !(j === target.length - 1 && candidate.startsWith(wanted))) {
        ok = false;
        break;
      }
    }
    if (ok) {
      matchStart = i;
      break;
    }
  }

  if (matchStart === -1) return [];
  const run = words.slice(matchStart, matchStart + target.length);
  if (run.length === 0) return [];

  // Group into lines. A new line starts when the vertical centre moves by more than half
  // the typical glyph height.
  const lines: Array<typeof run> = [];
  let current: typeof run = [];
  let lastCentre: number | null = null;

  for (const word of run) {
    const centre = word.y + word.h / 2;
    if (lastCentre !== null && Math.abs(centre - lastCentre) > Math.max(word.h * 0.6, 0.004)) {
      if (current.length > 0) lines.push(current);
      current = [];
    }
    current.push(word);
    lastCentre = centre;
  }
  if (current.length > 0) lines.push(current);

  return lines.map((line) => {
    const x0 = Math.min(...line.map((w) => w.x));
    const y0 = Math.min(...line.map((w) => w.y));
    const x1 = Math.max(...line.map((w) => w.x + w.w));
    const y1 = Math.max(...line.map((w) => w.y + w.h));
    return {
      page: page.pageNumber,
      x: clamp01(x0),
      y: clamp01(y0),
      width: clamp01(x1 - x0),
      height: clamp01(y1 - y0),
    };
  });
}

/**
 * Chooses the sentences from a retrieved passage that best answer the question, and
 * returns them verbatim. Because the excerpt is *selected* rather than *written*, it is
 * always present in the source by construction — verification then confirms it against the
 * stored page text rather than trusting that construction.
 */
export function selectExcerpt(
  passage: string,
  query: string,
  options: { maxChars?: number; minSentences?: number } = {},
): string {
  const maxChars = options.maxChars ?? 320;
  const minSentences = options.minSentences ?? 1;
  const sentences = splitSentences(passage);
  if (sentences.length === 0) return truncateExcerpt(passage, maxChars);

  const queryTerms = new Set(normalizeForMatch(query).split(' ').filter((t) => t.length > 2));

  const scored = sentences.map((sentence, index) => {
    const terms = normalizeForMatch(sentence).split(' ');
    const hits = terms.filter((t) => queryTerms.has(t)).length;
    const density = terms.length === 0 ? 0 : hits / Math.sqrt(terms.length);
    // Obligation language is what a compliance reader wants quoted.
    const obligation = /\b(shall|must|shall not|must not|required|prohibited)\b/i.test(sentence) ? 0.35 : 0;
    return { sentence, index, score: density + obligation };
  });

  const best = [...scored].sort((a, b) => b.score - a.score)[0];
  if (!best) return truncateExcerpt(passage, maxChars);

  // Grow outwards from the best sentence, keeping the original reading order, so the
  // excerpt reads as a contiguous quotation rather than stitched fragments.
  const picked = [best.index];
  let length = best.sentence.length;
  let lo = best.index;
  let hi = best.index;

  while (length < maxChars && (lo > 0 || hi < sentences.length - 1)) {
    const prev = lo > 0 ? (scored[lo - 1] ?? null) : null;
    const next = hi < sentences.length - 1 ? (scored[hi + 1] ?? null) : null;
    const takeNext = next !== null && (prev === null || next.score >= prev.score);
    const chosen = takeNext ? next : prev;
    if (!chosen) break;
    if (length + chosen.sentence.length + 1 > maxChars && picked.length >= minSentences) break;
    if (takeNext) hi += 1;
    else lo -= 1;
    picked.push(chosen.index);
    length += chosen.sentence.length + 1;
  }

  const ordered = [...new Set(picked)].sort((a, b) => a - b);
  const text = ordered.map((i) => sentences[i]).join(' ');
  return normalizeWhitespace(text);
}

/**
 * Classifies how a passage relates to a claim.
 *
 * `contradicts` is detected from explicit negation or prohibition against the claim's own
 * terms. Anything not clearly supporting or contradicting is `context`, which deliberately
 * cannot by itself justify a compliant verdict.
 */
export function classifyEntailment(claim: string, passage: string): Entailment {
  const claimTerms = new Set(
    normalizeForMatch(claim)
      .split(' ')
      .filter((t) => t.length > 3),
  );
  const passageNorm = normalizeForMatch(passage);
  const overlap = [...claimTerms].filter((t) => passageNorm.includes(t)).length;
  const ratio = claimTerms.size === 0 ? 0 : overlap / claimTerms.size;

  const claimIsNegative = /\b(not|no|without|prohibited|shall not|must not|fails?|non-compliant)\b/i.test(claim);
  const passageIsNegative = /\b(shall not|must not|is prohibited|are prohibited|no .{0,20}shall|not permitted|not allowed)\b/i.test(passage);

  if (ratio < 0.28) return 'context';
  // Opposite polarity over the same subject matter is a contradiction.
  if (claimIsNegative !== passageIsNegative) return 'contradicts';
  return 'supports';
}

/**
 * Detects genuine conflicts between two passages that address the same obligation but
 * state different requirements (different numbers, or opposite polarity).
 */
export function detectConflict(a: string, b: string): { conflict: boolean; reason: string | null } {
  // Two passages only conflict if they are about the same thing. Without this gate,
  // "exit width 1.5 m" and "travel distance 38 m" look like conflicting length values
  // purely because both are measured in metres.
  const subjectOverlap = sharedTerms(a, b);
  if (subjectOverlap < 0.3) return { conflict: false, reason: null };

  const aNums = extractQuantities(a);
  const bNums = extractQuantities(b);

  for (const [unit, aValue] of aNums) {
    const bValue = bNums.get(unit);
    if (bValue !== undefined && Math.abs(aValue - bValue) > 1e-9) {
      return {
        conflict: true,
        reason: `Conflicting values for ${unit}: ${aValue} versus ${bValue}`,
      };
    }
  }

  const aNeg = /\b(shall not|must not|is prohibited|not permitted)\b/i.test(a);
  const bNeg = /\b(shall not|must not|is prohibited|not permitted)\b/i.test(b);
  const aPos = /\b(shall|must|is required)\b/i.test(a) && !aNeg;
  const bPos = /\b(shall|must|is required)\b/i.test(b) && !bNeg;

  if ((aNeg && bPos) || (aPos && bNeg)) {
    return { conflict: true, reason: 'One provision requires what the other prohibits' };
  }

  return { conflict: false, reason: null };
}

/** Pulls "1.2 m", "45 minutes", "30 %" style quantities out of regulatory prose. */
export function extractQuantities(text: string): Map<string, number> {
  const out = new Map<string, number>();
  const pattern =
    /(\d+(?:[.,]\d+)?)\s*(mm|cm|m|km|in|ft|kg|g|lb|s|sec|seconds?|min|minutes?|h|hours?|%|percent|lux|lx|kpa|pa|bar|db|persons?|occupants?)\b/gi;

  for (const match of text.matchAll(pattern)) {
    const raw = match[1];
    const unit = match[2];
    if (!raw || !unit) continue;
    const value = Number.parseFloat(raw.replace(',', '.'));
    if (Number.isNaN(value)) continue;
    const key = canonicalUnit(unit.toLowerCase());
    // Keep the first occurrence: the leading figure in a clause is the operative one.
    if (!out.has(key)) out.set(key, convertToCanonical(value, unit.toLowerCase()));
  }
  return out;
}

function canonicalUnit(unit: string): string {
  if (['mm', 'cm', 'm', 'km', 'in', 'ft'].includes(unit)) return 'length_m';
  if (['s', 'sec', 'second', 'seconds', 'min', 'minute', 'minutes', 'h', 'hour', 'hours'].includes(unit)) {
    return 'time_s';
  }
  if (['kg', 'g', 'lb'].includes(unit)) return 'mass_kg';
  if (['%', 'percent'].includes(unit)) return 'percent';
  if (['lux', 'lx'].includes(unit)) return 'illuminance_lx';
  if (['kpa', 'pa', 'bar'].includes(unit)) return 'pressure_pa';
  if (['person', 'persons', 'occupant', 'occupants'].includes(unit)) return 'people';
  return unit;
}

function convertToCanonical(value: number, unit: string): number {
  switch (unit) {
    case 'mm': return value / 1000;
    case 'cm': return value / 100;
    case 'km': return value * 1000;
    case 'in': return value * 0.0254;
    case 'ft': return value * 0.3048;
    case 'min': case 'minute': case 'minutes': return value * 60;
    case 'h': case 'hour': case 'hours': return value * 3600;
    case 'g': return value / 1000;
    case 'lb': return value * 0.453592;
    case 'kpa': return value * 1000;
    case 'bar': return value * 100000;
    default: return value;
  }
}

function sharedTerms(a: string, b: string): number {
  const aSet = new Set(normalizeForMatch(a).split(' ').filter((t) => t.length > 3));
  const bSet = new Set(normalizeForMatch(b).split(' ').filter((t) => t.length > 3));
  if (aSet.size === 0 || bSet.size === 0) return 0;
  let hits = 0;
  for (const t of aSet) if (bSet.has(t)) hits += 1;
  return hits / Math.min(aSet.size, bSet.size);
}

/** Builds an unverified citation draft from a retrieved, reranked passage. */
export function draftCitation(
  candidate: FusedCandidate,
  query: string,
  citationId: string,
  claim?: string,
): CitationDraft {
  const excerpt = selectExcerpt(candidate.content, query);
  return {
    citationId,
    sourceId: candidate.sourceId,
    sourceVersionId: candidate.sourceVersionId,
    sourceSha256: candidate.sourceSha256,
    documentTitle: candidate.documentTitle,
    documentType: candidate.documentType,
    pageNumber: candidate.pageNumber,
    sheetName: candidate.sheetName,
    cellRange: candidate.cellRange,
    slideNumber: candidate.slideNumber,
    shapeName: null,
    chapter: candidate.chapter,
    section: candidate.section,
    clause: candidate.clause,
    headingPath: candidate.headingPath,
    paragraphIndex: candidate.paragraphIndex,
    charStart: candidate.charStart,
    charEnd: candidate.charEnd,
    urlFragment: null,
    boundingBoxes: [],
    supportingExcerpt: excerpt,
    retrievalScore: clamp01(candidate.score),
    rerankScore: clamp01(candidate.rerankScore),
    entailment: claim ? classifyEntailment(claim, candidate.content) : 'context',
    effectiveDate: candidate.effectiveDate,
  };
}

export function finalizeCitation(
  draft: CitationDraft,
  verification: VerificationResult,
  tenantId: string,
): Citation {
  return {
    citationId: draft.citationId,
    tenantId,
    sourceId: draft.sourceId,
    sourceVersionId: draft.sourceVersionId,
    sourceSha256: draft.sourceSha256,
    documentTitle: draft.documentTitle,
    documentType: draft.documentType as Citation['documentType'],
    pageNumber: draft.pageNumber,
    sheetName: draft.sheetName,
    cellRange: draft.cellRange,
    slideNumber: draft.slideNumber,
    shapeName: draft.shapeName,
    chapter: draft.chapter,
    section: draft.section,
    clause: draft.clause,
    headingPath: draft.headingPath,
    paragraphIndex: draft.paragraphIndex,
    charStart: verification.charStart ?? draft.charStart,
    charEnd: verification.charEnd ?? draft.charEnd,
    urlFragment: draft.urlFragment,
    boundingBoxes: verification.boundingBoxes,
    supportingExcerpt: draft.supportingExcerpt,
    retrievalScore: draft.retrievalScore,
    rerankScore: draft.rerankScore,
    entailment: draft.entailment,
    verified: verification.verified,
    verificationMethod: verification.method,
    effectiveDate: draft.effectiveDate ? draft.effectiveDate.toISOString() : null,
    supersededBy: null,
    createdAt: new Date().toISOString(),
  };
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
