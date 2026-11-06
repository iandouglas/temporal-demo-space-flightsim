/** Sector events the ship flies through (banner + colour + which hazards spawn). */
export type ObstacleKind = 'asteroid' | 'debris' | 'mine' | 'bolt' | 'ring';

export interface Scenario {
  id: string;
  banner: string;
  sub: string;
  /** Fog / nebula tint for the sector. */
  color: number;
  accent: number;
  durationS: number;
  /** Hazards picked (one at a time) while in this sector. */
  kinds: ObstacleKind[];
  /** Chance per second to break a random system (capped by MAX_BROKEN). */
  breakRate?: number;
  multiplier?: number;
  /** Enemy ships come in faster during this sector. */
  enemyBoost?: number;
  klaxon?: boolean;
}

export const CALM: Scenario = {
  id: 'calm', banner: '', sub: '', color: 0x0a0c24, accent: 0x6a5cff, durationS: 3, kinds: ['asteroid'],
};

export const SCENARIOS: Scenario[] = [
  { id: 'asteroids', banner: 'Asteroid field ahead', sub: 'Steer clear, or blast them', color: 0x1c1208, accent: 0xffa04a, durationS: 12, kinds: ['asteroid'], klaxon: true },
  { id: 'debris', banner: 'Debris field', sub: 'Wreckage from a failed deploy', color: 0x0d1418, accent: 0x7fd4ff, durationS: 11, kinds: ['debris', 'debris', 'asteroid'], klaxon: true },
  { id: 'mines', banner: 'Minefield detected', sub: 'Mines hit hard. Shoot them first', color: 0x1a060a, accent: 0xff3b5c, durationS: 11, kinds: ['mine', 'asteroid'], klaxon: true },
  { id: 'ion', banner: 'Ion storm', sub: 'Dodge the lightning. Systems will glitch', color: 0x061a22, accent: 0x5ef6ff, durationS: 11, kinds: ['bolt', 'asteroid'], breakRate: 0.3, klaxon: true },
  { id: 'fighters', banner: 'Hostile fighters', sub: 'Enemy ships inbound. Blast them for big points', color: 0x08180c, accent: 0x6bff8f, durationS: 12, kinds: ['asteroid', 'debris'], enemyBoost: 2.5, klaxon: true },
  { id: 'wormhole', banner: 'Wormhole: 1.5× points', sub: 'Fly through the rings for bonus', color: 0x160a2c, accent: 0xc38bff, durationS: 10, kinds: ['ring', 'ring', 'asteroid'], multiplier: 1.5 },
  { id: 'flare', banner: 'Solar flare', sub: 'Sensors and nav may glitch', color: 0x2a1204, accent: 0xffd36a, durationS: 9, kinds: ['asteroid', 'debris'], breakRate: 0.2, klaxon: true },
];

/** Build a ~90s run: calm opener, then shuffled sectors with short calm gaps. */
export function buildSchedule(totalS: number, rand: () => number = Math.random): { at: number; s: Scenario }[] {
  const out: { at: number; s: Scenario }[] = [{ at: 0, s: CALM }];
  // Asteroids open the show; fighters never before 30s; everything else shuffled.
  const first = SCENARIOS.find((p) => p.id === 'asteroids')!;
  const rest = SCENARIOS.filter((p) => p !== first).sort(() => rand() - 0.5);
  const fi = rest.findIndex((p) => p.id === 'fighters');
  if (fi < 2) rest.splice(2, 0, ...rest.splice(fi, 1));
  const order = [first, ...rest, ...[...SCENARIOS].sort(() => rand() - 0.5)];
  let t = 5;
  let last = '';
  for (const s of order) {
    if (t >= totalS) break;
    if (s.id === last) continue;
    out.push({ at: t, s });
    t += s.durationS;
    out.push({ at: t, s: { ...CALM, durationS: 2 } });
    t += 2;
    last = s.id;
  }
  return out;
}
