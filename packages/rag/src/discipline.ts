import { contentTokens, lightStem, normalizeWhitespace } from './text.js';

/**
 * What trade a document belongs to, and what a clause is about.
 *
 * A twelve-sheet smoke-ventilation layout was tested against clauses on fire-station
 * bedrooms, above-ground LPG tank installation, LPG working pressure to ASME, yard
 * hydrants, curtainwall perimeter joints, GRP facade systems and glass baluster design to
 * ASCE. None of them belong in a smoke layout, and each produced a "needs evidence" row —
 * which reads to a client as a gap in their design rather than a clause that was never
 * theirs to answer.
 *
 * The two states were merged and had to be separated: a clause this document could
 * evidence and does not is a finding; a clause belonging to a trade this document does not
 * cover is out of scope. Telling them apart needs to know what the document is.
 */
export type Discipline =
  | 'smoke_control'
  | 'fire_detection'
  | 'fire_suppression'
  | 'means_of_egress'
  | 'gas_systems'
  | 'facade_structure'
  | 'electrical'
  | 'civil_defence_facilities'
  | 'general';

/**
 * Words that identify a trade, weighted by how exclusively they belong to it.
 *
 * A term appearing in one discipline's list only is worth more than one shared with
 * another: "hoistway" says lift, "pressurization" says smoke control or lift, "system"
 * says nothing. The lists are deliberately short — a long list of near-synonyms dilutes
 * exactly the terms that carry the signal.
 */
const LEXICON: Record<Exclude<Discipline, 'general'>, string[]> = {
  smoke_control: [
    'smoke',
    'extract',
    'exhaust',
    'plenum',
    'damper',
    'duct',
    'ventilation',
    'pressurization',
    'makeup',
    'cfm',
    'ach',
    'vent',
    'louver',
    'atrium',
    'hoistway',
    'stair',
  ],
  fire_detection: [
    'detector',
    'detection',
    'alarm',
    'annunciator',
    'notification',
    'sounder',
    'strobe',
    'aspirating',
    'beam',
    'manual',
    'callpoint',
    'addressable',
    'loop',
  ],
  fire_suppression: [
    'sprinkler',
    'hydrant',
    'standpipe',
    'riser',
    'hose',
    'nozzle',
    'deluge',
    'preaction',
    'foam',
    'mist',
    'extinguisher',
    'pump',
    'breeching',
    'suppression',
    'agent',
  ],
  means_of_egress: [
    'egress',
    'exit',
    'travel',
    'corridor',
    'occupant',
    'discharge',
    'refuge',
    'handrail',
    'guard',
    'baluster',
    'tread',
    'riser',
    'door',
    'signage',
  ],
  gas_systems: [
    'lpg',
    'lng',
    'cylinder',
    'tank',
    'regulator',
    'odorant',
    'propane',
    'butane',
    'prdp',
    'mounded',
    'aboveground',
    'gas',
  ],
  facade_structure: [
    'curtainwall',
    'facade',
    'cladding',
    'glazing',
    'spandrel',
    'perimeter',
    'grp',
    'aluminium',
    'composite',
    'panel',
    'insulation',
    'membrane',
  ],
  electrical: [
    'busbar',
    'switchgear',
    'transformer',
    'generator',
    'ups',
    'cable',
    'conduit',
    'earthing',
    'luminaire',
    'circuit',
    'distribution',
  ],
  civil_defence_facilities: [
    'apparatus',
    'bedroom',
    'locker',
    'dormitory',
    'barracks',
    'watchroom',
    'appliance',
    'brigade',
    'station',
  ],
};

const STEMMED: Array<[Exclude<Discipline, 'general'>, Set<string>]> = Object.entries(LEXICON).map(
  ([discipline, terms]) => [
    discipline as Exclude<Discipline, 'general'>,
    new Set(terms.map((term) => lightStem(term))),
  ],
);

/** Terms that belong to exactly one discipline are what actually identify it. */
const EXCLUSIVE: Map<string, Exclude<Discipline, 'general'>> = (() => {
  const counts = new Map<string, Exclude<Discipline, 'general'>[]>();
  for (const [discipline, terms] of STEMMED) {
    for (const term of terms) counts.set(term, [...(counts.get(term) ?? []), discipline]);
  }
  return new Map(
    [...counts.entries()]
      .filter(([, owners]) => owners.length === 1)
      .map(([term, owners]) => [term, owners[0] as Exclude<Discipline, 'general'>]),
  );
})();

export interface DisciplineProfile {
  /** Disciplines this text engages with, strongest first. */
  disciplines: Discipline[];
  /** Per-discipline share of the exclusive terms found, for explaining the decision. */
  scores: Map<Discipline, number>;
}

/**
 * What trades a document covers.
 *
 * Scored on exclusive terms only. A drawing that says "duct" forty times and "hydrant"
 * once is a smoke-control drawing that happens to note a hydrant, not a suppression
 * submission, and counting raw mentions would not tell the two apart.
 */
export function profileDisciplines(text: string, minimumShare = 0.15): DisciplineProfile {
  const counts = new Map<Discipline, number>();
  let total = 0;

  for (const token of contentTokens(text)) {
    const owner = EXCLUSIVE.get(lightStem(token));
    if (owner === undefined) continue;
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
    total += 1;
  }

  if (total === 0) return { disciplines: ['general'], scores: new Map() };

  const scores = new Map<Discipline, number>(
    [...counts.entries()].map(([discipline, count]) => [discipline, count / total]),
  );
  const disciplines = [...scores.entries()]
    .filter(([, share]) => share >= minimumShare)
    .sort((a, b) => b[1] - a[1])
    .map(([discipline]) => discipline);

  // Nothing cleared the bar but something was found: keep the strongest rather than
  // declaring a document about nothing.
  if (disciplines.length === 0) {
    const strongest = [...scores.entries()].sort((a, b) => b[1] - a[1])[0];
    return { disciplines: strongest ? [strongest[0]] : ['general'], scores };
  }
  return { disciplines, scores };
}

/**
 * The single discipline a clause belongs to, or null when it belongs to none in
 * particular.
 *
 * A clause about corridors and occupant load is an egress clause; one about "the system"
 * is nobody's, and a clause nobody owns is applied to everybody rather than filtered out.
 * Being unsure is not grounds for hiding a requirement.
 */
export function clauseDiscipline(text: string): Discipline | null {
  const counts = new Map<Exclude<Discipline, 'general'>, number>();
  for (const token of contentTokens(text)) {
    const owner = EXCLUSIVE.get(lightStem(token));
    if (owner === undefined) continue;
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
  if (counts.size === 0) return null;

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  if (!top) return null;
  // A clause that mentions two trades equally is not routed to either.
  if (second && second[1] === top[1]) return null;
  return top[0];
}

/**
 * Whether a submission of these disciplines can reasonably be expected to evidence a
 * clause of this one.
 *
 * `null` means the clause names no trade, so anybody may have to answer it.
 */
export function isInScope(clause: Discipline | null, submission: Discipline[]): boolean {
  if (clause === null || clause === 'general') return true;
  if (submission.includes('general')) return true;
  return submission.includes(clause);
}

/** Human-readable name, for the sentence that tells a reader why a clause was set aside. */
export function disciplineLabel(discipline: Discipline): string {
  return {
    smoke_control: 'smoke control and ventilation',
    fire_detection: 'fire detection and alarm',
    fire_suppression: 'fire suppression',
    means_of_egress: 'means of egress',
    gas_systems: 'gas and LPG systems',
    facade_structure: 'facade and structure',
    electrical: 'electrical',
    civil_defence_facilities: 'civil defence facilities',
    general: 'general',
  }[discipline];
}

/** "smoke control and ventilation and fire detection and alarm" reads badly; this does not. */
export function describeDisciplines(disciplines: Discipline[]): string {
  const labels = disciplines.map(disciplineLabel);
  if (labels.length === 0) return 'no identifiable discipline';
  if (labels.length === 1) return labels[0] as string;
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/** Normalised text for profiling, so callers do not each invent their own. */
export function profileText(parts: string[]): string {
  return normalizeWhitespace(parts.join(' ')).slice(0, 200_000);
}
