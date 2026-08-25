import { describe, expect, it } from 'vitest';
import {
  charNgrams,
  contentTokens,
  findExcerpt,
  fnv1a,
  jaccard,
  lightStem,
  normalizeForMatch,
  normalizeWhitespace,
  splitSentences,
  truncateExcerpt,
} from '@uxe/rag';

describe('splitSentences', () => {
  it('splits ordinary prose', () => {
    expect(splitSentences('One thing. Two things. Three.')).toEqual([
      'One thing.',
      'Two things.',
      'Three.',
    ]);
  });

  it('does not split on a clause number', () => {
    // The whole citation system depends on "6.4.2" surviving as one token.
    const sentences = splitSentences('Clause 6.4.2 applies. See section 3.1.4 for exceptions.');
    expect(sentences).toHaveLength(2);
    expect(sentences[0]).toContain('6.4.2');
    expect(sentences[1]).toContain('3.1.4');
  });

  it('does not split on regulatory abbreviations', () => {
    expect(splitSentences('Refer to cl. 6.4 and fig. 3 for detail.')).toHaveLength(1);
    expect(splitSentences('Approved by Dr. Vural on Monday.')).toHaveLength(1);
  });

  it('does not split on an initial', () => {
    expect(splitSentences('Signed by J. Smith yesterday.')).toHaveLength(1);
  });

  it('returns nothing for empty input', () => {
    expect(splitSentences('')).toEqual([]);
    expect(splitSentences('   ')).toEqual([]);
  });
});

describe('findExcerpt', () => {
  const page = 'Emergency illumination shall cover every point along the means of egress.';

  it('finds an exact match and reports offsets into the original', () => {
    const span = findExcerpt(page, 'shall cover every point');
    expect(span?.method).toBe('exact');
    expect(page.slice(span?.start, span?.end)).toBe('shall cover every point');
  });

  it('finds a match across a line break', () => {
    const wrapped = 'Emergency illumination shall cover\nevery point along the means of egress.';
    const span = findExcerpt(wrapped, 'shall cover every point');
    expect(span).not.toBeNull();
    expect(span?.method).toBe('normalized');
    // Offsets must still land on real characters in the ORIGINAL string.
    expect(wrapped.slice(span?.start, span?.end)).toContain('shall cover');
  });

  it('finds a match despite curly quotes and ligatures', () => {
    const fancy = 'The “means of egress” shall be kept clear.';
    const span = findExcerpt(fancy, '"means of egress" shall be kept clear');
    expect(span).not.toBeNull();
  });

  it('returns null when the text genuinely is not present', () => {
    // This is the case that must fail: a citation that cannot be found is unverified.
    expect(findExcerpt(page, 'shall provide a fire blanket')).toBeNull();
  });

  it('returns null for empty needles', () => {
    expect(findExcerpt(page, '')).toBeNull();
    expect(findExcerpt(page, '   ')).toBeNull();
  });
});

describe('normalisation', () => {
  it('collapses whitespace without changing case', () => {
    expect(normalizeWhitespace('  A   B \n C ')).toBe('A B C');
  });

  it('lowercases only in the match form', () => {
    expect(normalizeForMatch('  Emergency  LIGHTING ')).toBe('emergency lighting');
  });

  it('folds unicode look-alikes', () => {
    expect(normalizeForMatch('“quoted” – dash')).toBe('"quoted" - dash');
  });
});

describe('tokenisation', () => {
  it('keeps clause numbers intact', () => {
    expect(contentTokens('clause 6.4.2 requires lighting')).toContain('6.4.2');
  });

  it('drops stopwords and single characters', () => {
    const tokens = contentTokens('the a of emergency lighting');
    expect(tokens).not.toContain('the');
    expect(tokens).toContain('emergency');
  });

  it('stems conservatively', () => {
    expect(lightStem('lights')).toBe('light');
    expect(lightStem('policies')).toBe('policy');
    // Short words are left alone rather than being mangled.
    expect(lightStem('gas')).toBe('gas');
    // "lighting" and "light" are not merged: they mean different things in a fire code.
    expect(lightStem('lighting')).toBe('lighting');
  });

  it('produces padded character n-grams', () => {
    const grams = charNgrams('exit', 3, 3);
    expect(grams).toContain('<ex');
    expect(grams).toContain('it>');
  });
});

describe('helpers', () => {
  it('computes jaccard similarity', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
    expect(jaccard(new Set(), new Set(['a']))).toBe(0);
  });

  it('hashes deterministically', () => {
    expect(fnv1a('emergency')).toBe(fnv1a('emergency'));
    expect(fnv1a('emergency')).not.toBe(fnv1a('lighting'));
  });

  it('truncates on a word boundary, never mid-word', () => {
    const source = 'one two three four five six seven eight';
    const result = truncateExcerpt(source, 20);
    expect(result.endsWith('...')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(24);

    const body = result.slice(0, -3);
    expect(source.startsWith(body)).toBe(true);
    // The character following the cut is a space, i.e. a whole word was kept.
    expect(source.charAt(body.length)).toBe(' ');
  });

  it('returns short text untouched', () => {
    expect(truncateExcerpt('short text', 100)).toBe('short text');
  });
});
