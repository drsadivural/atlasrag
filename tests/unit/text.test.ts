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
  rejoinHyphenatedLines,
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

describe('finding a quotation that the page wrapped', () => {
  /*
   * The needle is rejoined by normalisation, so the haystack has to be too. When only one
   * side was, every citation quoting a hyphen-wrapped word stopped verifying — and an
   * answer with no verified citations abstains, which is how a working consultation turns
   * into "the selected sources do not answer this question".
   */
  const page =
    'Where a fire pump set only serves \ninternal building systems, the capaci-\nty of the pump sets shall suffice.';

  it('locates it when the quote reads as one word', () => {
    const span = findExcerpt(page, 'the capacity of the pump sets');
    expect(span).not.toBeNull();
    // The offsets still land on the real characters, hyphen and newline included.
    expect(page.slice(span!.start, span!.end)).toContain('capaci-');
  });

  it('locates it when the quote carries the break as a space', () => {
    expect(findExcerpt(page, 'the capaci- ty of the pump sets')).not.toBeNull();
  });

  it('still refuses text that is genuinely not there', () => {
    expect(findExcerpt(page, 'the capacity of the sprinkler risers')).toBeNull();
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

  /*
   * A hyphen a typesetter put at the end of a line comes out of a PDF as a real character.
   * Collapsing the newline after it leaves "capaci- ty" inside a sentence — in the stored
   * page text, in every chunk built from it, and so in the quotation printed under an
   * answer as what the regulation says. It does not say that.
   */
  it('rejoins a word the page broke across a line', () => {
    expect(rejoinHyphenatedLines('the capaci-\nty of the pump')).toBe('the capacity of the pump');
    expect(normalizeWhitespace('the capaci-\n  ty of the pump')).toBe('the capacity of the pump');
  });

  it('rejoins it after the line break has already been collapsed to a space', () => {
    // Text that has been through anything that flattens newlines keeps the break only as
    // "capaci- ty", and that is the form a model hands back in a headline.
    expect(rejoinHyphenatedLines('the capaci- ty of the pump')).toBe('the capacity of the pump');
  });

  it('leaves a hyphen that was not a line break alone', () => {
    // A space before it was never a wrap, and a capital after it says the break was not one.
    expect(rejoinHyphenatedLines('two -\nthree')).toBe('two -\nthree');
    expect(rejoinHyphenatedLines('well-\nKnown')).toBe('well-\nKnown');
    // No whitespace after the hyphen: written as one word, and it stays that way.
    expect(rejoinHyphenatedLines('fire-rated door')).toBe('fire-rated door');
    expect(rejoinHyphenatedLines('a range of 5 - 10 metres')).toBe('a range of 5 - 10 metres');
  });

  it('does not touch a line break with no hyphen', () => {
    expect(normalizeWhitespace('first line\nsecond line')).toBe('first line second line');
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

  it('unifies a plural with its own singular', () => {
    // The whole point of stemming. "-es" used to be stripped whole, so "lines" became "lin"
    // while "line" stayed "line" and the two never matched — which silently cost every
    // clause whose subject the submission wrote in the other number.
    for (const [singular, plural] of [
      ['line', 'lines'],
      ['distance', 'distances'],
      ['device', 'devices'],
      ['valve', 'valves'],
      ['surface', 'surfaces'],
    ] as const) {
      expect(lightStem(plural)).toBe(lightStem(singular));
    }
  });

  it('still strips "-es" where it really is the plural', () => {
    expect(lightStem('boxes')).toBe('box');
    expect(lightStem('classes')).toBe('class');
    expect(lightStem('churches')).toBe('church');
    expect(lightStem('flashes')).toBe('flash');
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
