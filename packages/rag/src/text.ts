/**
 * Text utilities shared by chunking, citation verification and evidence matching.
 *
 * The distinction between `normalizeForMatch` and the raw text matters a great deal:
 * citations are stored with the *raw* excerpt so a reader sees exactly what the document
 * says, but verification also tries a normalised comparison so that a PDF's ligatures,
 * soft hyphens and non-breaking spaces do not cause a genuine quote to be rejected.
 */

/** Characters PDF extractors routinely emit that are visually identical to ASCII. */
const UNICODE_FOLDS: Array<[RegExp, string]> = [
  [/[‘’‚‛′]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[‐‑‒–—―−]/g, '-'],
  // Written as escapes: the literal characters are invisible in a diff.
  [/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' '],
  [/\u00AD|\u200B|\u200C|\u200D|\uFEFF/gu, ''],
  [/ﬀ/g, 'ff'],
  [/ﬁ/g, 'fi'],
  [/ﬂ/g, 'fl'],
  [/ﬃ/g, 'ffi'],
  [/ﬄ/g, 'ffl'],
  [/…/g, '...'],
];

export function foldUnicode(input: string): string {
  let out = input;
  for (const [pattern, replacement] of UNICODE_FOLDS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Rejoins a word a PDF broke across a line.
 *
 * Extractors emit the hyphen a typesetter put at a line end as a real character, so
 * collapsing the newline that followed it leaves "capaci- ty" in the middle of a sentence
 * — in stored page text, in every chunk built from it, and therefore in the quotation
 * printed under an answer as what the regulation says. It does not say that.
 *
 * The join is deliberately narrow: a letter, a hyphen, then whitespace — a line break or
 * at least one space — then a lower-case letter. The whitespace is what makes it a wrap,
 * which is why "fire-rated" is left exactly as written, and the space form is included
 * because by the time text has passed through anything that collapses newlines the break
 * survives only as "capaci- ty". A hyphen with a space *before* it is a dash and does not
 * match; "well-\nKnown" keeps its hyphen because the capital says the break was not one.
 *
 * Compounds that legitimately end a line lose their hyphen under this rule. That is the
 * price of the common case being right, and the common case is overwhelmingly more common.
 */
export function rejoinHyphenatedLines(input: string): string {
  return input.replace(/(\p{L})-(?:[ \t]*\r?\n[ \t]*|[ \t]+)(\p{Ll})/gu, '$1$2');
}

/** Collapses whitespace and folds look-alike characters, preserving case. */
export function normalizeWhitespace(input: string): string {
  return rejoinHyphenatedLines(foldUnicode(input)).replace(/\s+/g, ' ').trim();
}

/** Aggressive form used only for comparison, never for display or storage. */
export function normalizeForMatch(input: string): string {
  return normalizeWhitespace(input).toLowerCase();
}

/**
 * Splits into sentences without breaking on the abbreviations and clause numbers that
 * saturate regulatory text ("cl. 6.4.2", "Fig. 3", "e.g."). A naive split on `.` would
 * shatter every clause reference and destroy the excerpts we quote.
 */
const ABBREVIATIONS = new Set([
  'no',
  'nos',
  'art',
  'arts',
  'sec',
  'secs',
  'cl',
  'cls',
  'fig',
  'figs',
  'tbl',
  'para',
  'paras',
  'ch',
  'chap',
  'vol',
  'ed',
  'eds',
  'pp',
  'approx',
  'min',
  'max',
  'etc',
  'eg',
  'ie',
  'cf',
  'vs',
  'ref',
  'app',
  'annex',
  'inc',
  'ltd',
  'co',
  'mr',
  'mrs',
  'ms',
  'dr',
  'st',
  'ave',
  'e.g',
  'i.e',
]);

export function splitSentences(input: string): string[] {
  const text = foldUnicode(input).replace(/\s+/g, ' ').trim();
  if (!text) return [];

  const out: string[] = [];
  let start = 0;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;

    const next = text[i + 1];
    // A terminator must be followed by whitespace (or end of string) to end a sentence.
    if (next !== undefined && next !== ' ') continue;

    if (ch === '.') {
      const before = text.slice(Math.max(0, i - 12), i);
      const lastWord = (before.match(/([A-Za-z.]+)$/)?.[1] ?? '').toLowerCase();
      if (ABBREVIATIONS.has(lastWord.replace(/\.$/, ''))) continue;
      // "6.4.2" — a digit on both sides of the dot is a clause number, not a full stop.
      if (/\d$/.test(before) && /^\s?\d/.test(text.slice(i + 1, i + 3))) continue;
      // A single capital letter before the dot is an initial ("J. Smith").
      if (/(^|\s)[A-Z]$/.test(before)) continue;
    }

    const sentence = text.slice(start, i + 1).trim();
    if (sentence) out.push(sentence);
    start = i + 1;
  }

  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

const STOPWORDS = new Set([
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
  'which',
  'with',
  'will',
  'would',
  'these',
  'those',
  'such',
  'any',
  'all',
  'not',
  'no',
  'if',
  'when',
  'where',
  'then',
  'than',
  'there',
  'their',
  'they',
  'we',
  'you',
]);

export function isStopword(token: string): boolean {
  return STOPWORDS.has(token);
}

/** Lowercase alphanumeric tokens, keeping clause numbers like `6.4.2` intact. */
export function tokenize(input: string): string[] {
  const folded = foldUnicode(input).toLowerCase();
  const matches = folded.match(/[a-z]+(?:'[a-z]+)?|\d+(?:\.\d+)*/g);
  return matches ?? [];
}

export function contentTokens(input: string): string[] {
  return tokenize(input).filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Very light suffix stripping. Full Porter stemming would over-merge regulatory terms
 * ("lighting" vs "light" matter differently in a fire code), so this only removes the
 * inflections that reliably mean the same thing.
 */
export function lightStem(token: string): string {
  if (token.length <= 4) return token;
  if (token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  /*
   * "-es" is only a two-letter plural after a sibilant: boxes, classes, churches, dishes.
   * Everywhere else the "e" belongs to the word and only the "s" is the plural.
   *
   * Stripping both unconditionally broke the thing stemming exists to do. "lines" became
   * "lin" while "line" stayed "line" — the singular and the plural of the same word no
   * longer matched each other, so a clause about separation distances scored nothing
   * against a drawing that annotates a separation distance. It went unnoticed because the
   * two forms were mangled consistently on each side; they simply never met.
   */
  if (/(?:ss|x|z|ch|sh)es$/.test(token)) return token.slice(0, -2);
  if (token.endsWith('s') && !token.endsWith('ss') && !token.endsWith('us')) {
    return token.slice(0, -1);
  }
  return token;
}

export function stemmedTokens(input: string): string[] {
  return contentTokens(input).map(lightStem);
}

/** Character n-grams, used by the embedding to survive OCR noise and morphology. */
export function charNgrams(token: string, min = 3, max = 5): string[] {
  const padded = `<${token}>`;
  const out: string[] = [];
  for (let n = min; n <= max; n += 1) {
    for (let i = 0; i + n <= padded.length; i += 1) out.push(padded.slice(i, i + n));
  }
  return out;
}

export interface MatchSpan {
  start: number;
  end: number;
  method: 'exact' | 'normalized';
}

/**
 * Locates `needle` inside `haystack`, returning offsets into the ORIGINAL haystack.
 *
 * Tries an exact match first. If that fails, it retries against a normalised copy while
 * maintaining an index map back to the original, so the highlight the user sees still
 * lands on the real characters. Returns null when the text genuinely is not present —
 * which is what causes a citation to be marked unverified rather than displayed as green.
 */
export function findExcerpt(haystack: string, needle: string): MatchSpan | null {
  const trimmedNeedle = needle.trim();
  if (!trimmedNeedle) return null;

  const exact = haystack.indexOf(trimmedNeedle);
  if (exact !== -1) {
    return { start: exact, end: exact + trimmedNeedle.length, method: 'exact' };
  }

  // Build a normalised haystack plus a map from normalised index -> original index.
  const map: number[] = [];
  let normalized = '';
  let pendingSpace = false;

  for (let i = 0; i < haystack.length; i += 1) {
    const raw = haystack[i] as string;
    const folded = foldUnicode(raw);
    if (folded === '') continue;

    /*
     * The same wrap-joining the needle gets, applied to the haystack.
     *
     * `normalizeForMatch` rejoins a word the page broke across a line, so a needle reads
     * "capacity". If this loop left the haystack reading "capaci- ty" the two could never
     * meet, and every citation quoting a wrapped word — which in a typeset code is a great
     * many of them — would be marked unverified and drag the answer into abstaining. These
     * two rules have to stay identical; see rejoinHyphenatedLines.
     */
    if (folded === '-' && /\p{L}/u.test(normalized.at(-1) ?? '')) {
      const wrap = /^(?:[ \t]*\r?\n[ \t]*|[ \t]+)(\p{Ll})/u.exec(haystack.slice(i + 1));
      if (wrap) {
        // Skip the hyphen and the whitespace; the loop's own increment lands on the letter.
        i += wrap[0].length - (wrap[1]?.length ?? 1);
        pendingSpace = false;
        continue;
      }
    }

    for (const ch of folded) {
      if (/\s/.test(ch)) {
        pendingSpace = normalized.length > 0;
        continue;
      }
      if (pendingSpace) {
        normalized += ' ';
        map.push(i);
        pendingSpace = false;
      }
      normalized += ch.toLowerCase();
      map.push(i);
    }
  }

  const normalizedNeedle = normalizeForMatch(trimmedNeedle);
  if (!normalizedNeedle) return null;

  const idx = normalized.indexOf(normalizedNeedle);
  if (idx === -1) return null;

  const start = map[idx] ?? 0;
  const endIdx = idx + normalizedNeedle.length - 1;
  const end = (map[endIdx] ?? haystack.length - 1) + 1;
  return { start, end, method: 'normalized' };
}

/** Trims an excerpt to whole words near a character budget, adding an ellipsis. */
export function truncateExcerpt(text: string, maxChars = 320): string {
  const clean = normalizeWhitespace(text);
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Deterministic 32-bit FNV-1a. Used for embedding buckets and stable synthetic IDs. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
