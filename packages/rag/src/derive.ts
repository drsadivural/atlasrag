import { normalizeWhitespace, splitSentences } from './text.js';

/**
 * Reasoning that combines values rather than matching them.
 *
 * Every finding in a manual review that carries engineering weight comes from putting a
 * number in the drawing next to a rule in the code: a roof level decides the height band,
 * which decides the governing table; an area times a height times an air-change rate
 * decides the flow the fans must move. Matching stated values against stated values
 * reaches none of it, and a tool that only matches will report a building's most important
 * non-conformities as "needs evidence" because nobody wrote the conclusion on the drawing.
 *
 * Two things here, both derived and both explainable:
 *
 *  - building attributes, which decide which clauses apply at all; and
 *  - internal consistency, which needs no code knowledge whatsoever — a document that
 *    states two different values for one thing is wrong on its own terms.
 */

/* -------------------------------------------------------------------------- */
/* Building attributes                                                        */
/* -------------------------------------------------------------------------- */

export type HeightBand = 'low_rise' | 'high_rise' | 'super_high_rise';

export interface BuildingAttributes {
  /** Highest floor level found, in metres above the fire access level. */
  heightM: number | null;
  band: HeightBand | null;
  /** Where the height came from, quoted, so a reader can check it. */
  heightEvidence: string | null;
  sprinklered: boolean | null;
  sprinkleredEvidence: string | null;
  basement: boolean;
}

/**
 * Height thresholds, in metres.
 *
 * The bands are the ones the UAE code uses, and they are the reason a clause about "Super
 * highrise buildings (having height greater than 90 m)" must not be reported as unmet by a
 * 23.76 m building. Named constants because they are the kind of number that ends up
 * copied into three places and changed in two.
 */
export const HIGH_RISE_M = 23;
export const SUPER_HIGH_RISE_M = 90;

/**
 * A floor level, annotated as one.
 *
 * The level word must sit next to the number — "FFL +8.94", "ROOF LEVEL 23.760",
 * "+23.76 FFL". An earlier version only required the word to appear somewhere on the same
 * line and then took every number on it, which on a sheet of CAD annotations found a
 * gypsum wallboard callout and declared a 12-storey building 400 m tall. That is the same
 * mistake as comparing two numbers because they share a unit: a bare figure means nothing
 * until something says what it is.
 */
const LEVEL_WORD = String.raw`(?:ffl|sfl|fgl|level|lvl|elev(?:ation)?|parapet)`;
const LEVEL_BEFORE = new RegExp(
  String.raw`\b(?:roof\s+)?${LEVEL_WORD}\b[\s.:=]{0,4}([+-]?\d{1,3}(?:[.,]\d{1,3})?)\s*m?\b`,
  'gi',
);
const LEVEL_AFTER = new RegExp(
  String.raw`([+-]\d{1,3}(?:[.,]\d{1,3})?)\s*m?\s*(?:\b(?:roof\s+)?${LEVEL_WORD}\b)`,
  'gi',
);

const SPRINKLERED = /\b(sprinkler(?:ed|s)?|sprinkler system|fully sprinklered)\b/i;
const UNSPRINKLERED = /\b(?:non[- ]?sprinklered|unsprinklered|no sprinkler)\b/i;
const BASEMENT = /\b(basement|sub[- ]?basement|b\d\b|lower ground)\b/i;

/**
 * Reads the building's own attributes out of the submitted drawings.
 *
 * Deliberately conservative: a level is only believed when it is annotated as one. Picking
 * the largest number on a drawing would find a duct length or a grid coordinate and
 * declare a bungalow a super high rise.
 */
export function deriveBuildingAttributes(text: string): BuildingAttributes {
  const levels: Array<{ value: number; quote: string; precise: boolean }> = [];

  for (const line of text.split(/\r?\n/)) {
    for (const pattern of [LEVEL_BEFORE, LEVEL_AFTER]) {
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) {
        const raw = match[1];
        if (raw === undefined) continue;
        const value = Number.parseFloat(raw.replace(',', '.'));
        if (Number.isNaN(value)) continue;
        // Levels are metres above or below datum. A figure past 300 is millimetres, a grid
        // reference or a drawing scale — none of which is a storey height.
        if (Math.abs(value) > 300) continue;
        levels.push({
          value,
          quote: normalizeWhitespace(match[0]).slice(0, 80),
          precise: /[.,]/.test(raw) || /^[+-]/.test(raw),
        });
      }
    }
  }

  /*
   * A surveyed level is written with a sign or a decimal — "+23.760", "FFL 8.94". A bare
   * integer after "Level" is almost always a storey number, and reading "Level 12" as
   * twelve metres would put a 40 m building in the wrong band.
   *
   * So precise levels win outright. Bare integers are used only when the drawing offers
   * nothing better, and then the disclosure says the height was derived and can be wrong.
   */
  const precise = levels.filter((level) => level.precise);
  const usable = precise.length > 0 ? precise : levels;

  const highest = usable.reduce<{ value: number; quote: string } | null>(
    (best, item) => (best === null || item.value > best.value ? item : best),
    null,
  );

  const sprinklered = UNSPRINKLERED.test(text) ? false : SPRINKLERED.test(text) ? true : null;
  const sprinkleredQuote =
    sprinklered === null
      ? null
      : (splitSentences(normalizeWhitespace(text)).find((sentence) =>
          (sprinklered ? SPRINKLERED : UNSPRINKLERED).test(sentence),
        ) ?? null);

  return {
    heightM: highest?.value ?? null,
    band: highest === null ? null : bandFor(highest.value),
    heightEvidence: highest?.quote ?? null,
    sprinklered,
    sprinkleredEvidence: sprinkleredQuote?.slice(0, 160) ?? null,
    basement: BASEMENT.test(text),
  };
}

export function bandFor(heightM: number): HeightBand {
  if (heightM > SUPER_HIGH_RISE_M) return 'super_high_rise';
  if (heightM > HIGH_RISE_M) return 'high_rise';
  return 'low_rise';
}

export function bandLabel(band: HeightBand): string {
  return { low_rise: 'low rise', high_rise: 'high rise', super_high_rise: 'super high rise' }[band];
}

/* -------------------------------------------------------------------------- */
/* Applicability by height                                                    */
/* -------------------------------------------------------------------------- */

/** A height condition a clause places on itself. */
export interface HeightCondition {
  /** Metres. */
  threshold: number;
  direction: 'above' | 'below';
  quote: string;
}

const HEIGHT_ABOVE =
  /\b(?:greater than|more than|exceeding|above|over|taller than|higher than|at least)\s+(\d{1,3}(?:[.,]\d{1,2})?)\s*m\b/i;
const HEIGHT_BELOW =
  /\b(?:less than|below|under|not exceeding|up to|not more than)\s+(\d{1,3}(?:[.,]\d{1,2})?)\s*m\b/i;

/**
 * The height band a clause restricts itself to, if it states one.
 *
 * Only read when the sentence is about the building's height, not any other length. "Super
 * highrise buildings having height greater than 90 m" qualifies; "travel distance shall
 * not exceed 45 m" does not, and confusing the two would silently disapply half a code.
 */
export function heightCondition(text: string): HeightCondition | null {
  for (const sentence of splitSentences(normalizeWhitespace(text))) {
    if (!/\b(?:building|storey|story|structure|highrise|high[- ]rise|height)\b/i.test(sentence)) {
      continue;
    }
    if (/\b(?:travel|distance|width|depth|diameter|spacing|length)\b/i.test(sentence)) continue;

    const above = sentence.match(HEIGHT_ABOVE);
    if (above?.[1]) {
      return {
        threshold: Number.parseFloat(above[1].replace(',', '.')),
        direction: 'above',
        quote: sentence.slice(0, 160),
      };
    }
    const below = sentence.match(HEIGHT_BELOW);
    if (below?.[1]) {
      return {
        threshold: Number.parseFloat(below[1].replace(',', '.')),
        direction: 'below',
        quote: sentence.slice(0, 160),
      };
    }
  }
  return null;
}

/**
 * Whether a clause that restricts itself by height applies to this building.
 *
 * `null` when the answer is not known — no condition stated, or no height derived. Not
 * knowing means the clause is tested, because disapplying a clause on a guess is the more
 * dangerous of the two errors.
 */
export function appliesAtHeight(
  condition: HeightCondition | null,
  heightM: number | null,
): boolean | null {
  if (condition === null || heightM === null) return null;
  return condition.direction === 'above'
    ? heightM > condition.threshold
    : heightM < condition.threshold;
}

/* -------------------------------------------------------------------------- */
/* Internal consistency                                                       */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Internal consistency: deliberately not here                                */
/* -------------------------------------------------------------------------- */

/*
 * A document that states two different figures for one thing is wrong on its own terms,
 * and catching that needs no knowledge of any code. It is the highest-value check left.
 *
 * It is not implemented, because two attempts at it both reproduced the defect they were
 * meant to remove. Comparing figures whose surrounding words overlap paired a clear water
 * column height against a clear void width. Comparing figures written under an identical
 * label then reported "BEDROOM 3.76 m2 and BEDROOM 24.31 m2 cannot both be right" — a room
 * schedule, where different rooms having different areas is the entire point of the table.
 *
 * Telling a room schedule from a system specification needs the document's structure, and
 * the structure is exactly what a flattened CAD annotation layer does not carry. Until a
 * layout-aware extraction exists, a check here can only guess, and a fabricated
 * non-conformity is the most expensive output this product has.
 */
