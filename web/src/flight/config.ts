/**
 * Flight Deck tuning knobs. The Temporal-button rules were ambiguous in the
 * brief, so both readings are configurable here.
 */
export const CONFIG = {
  GAME_SECONDS: 90,
  /** Every THRESHOLD points earns one "Deploy Temporal" charge. */
  THRESHOLD: 10_000,
  /** How long a deploy locks every system in the DURABLE state. */
  DURATION_MS: 10_000,
  /** true = the first deploy locks systems for the rest of the game. */
  LOCK_FOR_REST_OF_GAME: false,
  /** Score multiplier while Temporal is deployed. */
  DURABLE_MULTIPLIER: 1.35,

  /**
   * Distance points per second at MAX_SPEED with every system online (the
   * slow opening earns ~80% of that). Tuned with the bonuses so an average
   * pilot crosses 10k at ~30-40s and earns 2-3 Temporal charges per run.
   */
  POINTS_PER_SEC: 320,
  /** Each broken system cuts the points *rate* by this much (score never goes down). */
  RATE_PENALTY_PER_BROKEN: 0.15,
  RATE_FLOOR: 0.4,
  // Bonuses: all continuous (size, range, speed, closeness, streak, repair time),
  // so two players almost never land on the same score.
  ASTEROID_POINTS: 45,
  DEBRIS_POINTS: 32,
  ENEMY_POINTS: 200,
  NEAR_MISS_POINTS: 140,
  STREAK_POINTS: 9,
  REPAIR_SPEED_POINTS: 110,

  /** Repair taps needed = max(REPAIR_TAPS_MIN, floor(elapsed / REPAIR_TAP_STEP_S)). */
  REPAIR_TAPS_MIN: 1,
  REPAIR_TAP_STEP_S: 15,
  /** Never more than this many systems broken at once. */
  MAX_BROKEN: 3,
  /** A single collision breaks at most this many systems (mines/enemy fire: this, others: 1). */
  MAX_BREAKS_PER_HIT: 2,
  /** Practice opening: no enemies, just 1-2 small, slow hazards. */
  EASY_SECONDS: 15,
  EASY_SPAWN_GAP: 6.5,
  /** The ship launches slowly and reaches MAX_SPEED at MAX_AT_S, holding it to the end. */
  START_SPEED: 16,
  MAX_SPEED: 76,
  MAX_AT_S: 75,

  HULL_EMERGENCY_RESTORE: 25,
  BLASTER_PER_SEC: 4,

  TELEMETRY_MS: 1000,
  /** Optional official logo; falls back to the built-in emblem when missing. */
  LOGO_URL: '/flight/temporal-logo.svg',
} as const;

export type SystemId = 'engines' | 'shields' | 'navigation' | 'sensors' | 'life_support' | 'cargo';

export const SYSTEMS: { id: SystemId; name: string; fix: string; effect: string; icon: string }[] = [
  { id: 'engines', name: 'Engines', fix: 'Fix engine', effect: 'Ship slows', icon: '⚙' },
  { id: 'shields', name: 'Shields', fix: 'Restore shields', effect: 'Hits do 2× damage', icon: '⛨' },
  { id: 'navigation', name: 'Navigation', fix: 'Recalibrate', effect: 'Steering drifts', icon: '⌖' },
  { id: 'sensors', name: 'Sensors', fix: 'Reboot sensors', effect: 'Hazards cloaked', icon: '◎' },
  { id: 'life_support', name: 'Life Support', fix: 'Restore air', effect: 'Vision fading', icon: '♥' },
  { id: 'cargo', name: 'Cargo Hold', fix: 'Seal cargo', effect: 'Cargo leaking', icon: '▦' },
];

/** Taps needed to repair a system that breaks at `elapsedMs`. */
export function repairTapsAt(elapsedMs: number): number {
  return Math.max(CONFIG.REPAIR_TAPS_MIN, Math.floor(elapsedMs / 1000 / CONFIG.REPAIR_TAP_STEP_S));
}
