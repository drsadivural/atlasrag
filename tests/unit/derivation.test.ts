import { describe, expect, it } from 'vitest';
import {
  appliesAtHeight,
  bandFor,
  clauseDiscipline,
  deriveBuildingAttributes,
  extractMeasurements,
  heightCondition,
  isInScope,
  profileDisciplines,
} from '@uxe/rag';

/*
 * Defect class D. A twelve-sheet smoke-ventilation layout was tested against clauses on
 * fire-station bedrooms, LPG tank installation, curtainwall perimeter joints and glass
 * baluster design. Each came back "needs evidence", which reads to a client as a gap in
 * their design rather than a clause that was never theirs to answer.
 */
describe('routing a submission to the clauses it can answer', () => {
  const SMOKE_DRAWING = `
    SMOKE EXTRACT DUCT LAYOUT. STAIR PRESSURIZATION FAN SP-01.
    MOTORIZED SMOKE DAMPER. EXTRACT PLENUM. MAKEUP AIR LOUVER.
    18000 CFM EXHAUST. HOISTWAY PRESSURIZATION. VENT SHAFT.
  `;

  it('reads a smoke drawing as smoke control', () => {
    expect(profileDisciplines(SMOKE_DRAWING).disciplines).toContain('smoke_control');
  });

  it('routes a clause to the trade it belongs to', () => {
    expect(
      clauseDiscipline('Aboveground LPG tank installation shall comply with the requirements of'),
    ).toBe('gas_systems');
    expect(
      clauseDiscipline('Curtainwall perimeter joints and fire stopping shall be a listed system.'),
    ).toBe('facade_structure');
    expect(clauseDiscipline('Fire apparatus bedrooms and locker rooms shall be separated.')).toBe(
      'civil_defence_facilities',
    );
  });

  it('keeps an LPG clause out of a smoke submission', () => {
    const submission = profileDisciplines(SMOKE_DRAWING).disciplines;
    expect(isInScope('gas_systems', submission)).toBe(false);
    expect(isInScope('facade_structure', submission)).toBe(false);
    expect(isInScope('smoke_control', submission)).toBe(true);
  });

  it('applies a clause that names no trade to everybody', () => {
    // Being unsure is not grounds for hiding a requirement.
    expect(clauseDiscipline('The system shall be maintained in accordance with Section 5.')).toBe(
      null,
    );
    expect(isInScope(null, ['smoke_control'])).toBe(true);
  });
});

/*
 * Defect class F. Every finding that carries engineering weight comes from combining a
 * number in the drawing with a rule in the code. The first and cheapest of those is the
 * building's own height, which decides which clauses apply at all.
 */
describe('deriving the building from its own drawings', () => {
  it('reads a level that is annotated as one', () => {
    const attributes = deriveBuildingAttributes('ROOF LEVEL 23.760\nFFL +8.94\nGROUND FFL 0.00');
    expect(attributes.heightM).toBe(23.76);
    expect(attributes.band).toBe('high_rise');
    expect(attributes.heightEvidence).toContain('23.76');
  });

  it('ignores a number that is merely near the word', () => {
    /*
     * The version that did not do this found a gypsum wallboard callout on a sheet whose
     * title block said LEVEL, and declared a twelve-storey building 400 m tall — which then
     * disapplied a clause it should have tested.
     */
    const attributes = deriveBuildingAttributes(
      'LEVEL 3 PLAN. FIRE DAMPER SLEEVE 400 RETAINING ANGLE GYPSUM WALLBOARD 250',
    );
    expect(attributes.heightM).toBe(3);
  });

  it('prefers a surveyed level over a storey number', () => {
    // "Level 12" is the twelfth floor. "+23.760" is twenty-three metres. Reading the first
    // as the second puts a 40 m building in the wrong band.
    const attributes = deriveBuildingAttributes('LEVEL 12 PLAN\nROOF FFL +23.760');
    expect(attributes.heightM).toBe(23.76);
  });

  it('falls back to a bare level when the drawing offers nothing better', () => {
    const attributes = deriveBuildingAttributes('LEVEL 12 PLAN');
    expect(attributes.heightM).toBe(12);
  });

  it('finds nothing rather than guessing when no level is annotated', () => {
    const attributes = deriveBuildingAttributes('DUCT 600x400. GRILLE 900 CFM. SCALE 1:100');
    expect(attributes.heightM).toBeNull();
    expect(attributes.band).toBeNull();
  });

  it('puts the thresholds where the code puts them', () => {
    expect(bandFor(12.677)).toBe('low_rise');
    expect(bandFor(23.76)).toBe('high_rise');
    expect(bandFor(120)).toBe('super_high_rise');
  });
});

describe('a clause that applies to a different building', () => {
  it('reads the height band a clause restricts itself to', () => {
    const condition = heightCondition(
      'All Super highrise buildings (having height greater than 90 m from the Fire access level) shall have Fire lifts.',
    );
    expect(condition).toEqual(expect.objectContaining({ threshold: 90, direction: 'above' }));
  });

  it('does not mistake a travel distance for a building height', () => {
    // Reading "travel distance shall not exceed 45 m" as a height band would silently
    // disapply half a code.
    expect(
      heightCondition('Travel distance to an exit shall not exceed 45 m in sprinklered buildings.'),
    ).toBeNull();
  });

  it('disapplies a super-high-rise clause for a low building', () => {
    const condition = heightCondition('Buildings having height greater than 90 m shall have X.');
    expect(appliesAtHeight(condition, 12.677)).toBe(false);
    expect(appliesAtHeight(condition, 120)).toBe(true);
  });

  it('tests the clause when the height is unknown', () => {
    // Disapplying a clause on a guess is the more dangerous of the two errors.
    const condition = heightCondition('Buildings having height greater than 90 m shall have X.');
    expect(appliesAtHeight(condition, null)).toBeNull();
    expect(appliesAtHeight(null, 23)).toBeNull();
  });
});

/*
 * The root cause the defect analysis named: quantities carried no dimension, so an area
 * was compared against a height. Extraction separates the superscript, and "23.73 m ²" was
 * being read as 23.73 metres.
 */
describe('quantities carry their dimension', () => {
  it('reads a detached superscript as area, not length', () => {
    const [area] = extractMeasurements('BEDROOM 01 23.73 m ²');
    expect(area?.unit).toBe('area_m2');
    expect(area?.value).toBe(23.73);
  });

  it('reads m3 and CFM as their own dimensions', () => {
    expect(extractMeasurements('water tank capacity 150 m3')[0]?.unit).toBe('volume_m3');
    expect(extractMeasurements('EXHAUST 18000 CFM')[0]?.unit).toBe('flow_cfm');
  });

  it('still reads a plain metre as a length', () => {
    const [length] = extractMeasurements('clear water column hi. 1.9 m');
    expect(length?.unit).toBe('length_m');
    expect(length?.value).toBe(1.9);
  });

  it('never lets an area and a height meet', () => {
    // "2.9.5 specifies 90.00 m but the project document states 23.73 m" was a building
    // height threshold compared against the floor area of a substation.
    const height = extractMeasurements('height greater than 90 m from the fire access level');
    const area = extractMeasurements('GROUND FLOOR SUBSTATION 23.73 m ²');
    expect(height[0]?.unit).not.toBe(area[0]?.unit);
  });
});
