import { CONFIG, repairTapsAt, SYSTEMS, type SystemId } from './config';
import { buildSchedule, CALM, type ObstacleKind, type Scenario } from './scenarios';

export interface SystemState { broken: boolean; progress: number; need: number }

/** Things that can hit the ship: hazards plus enemy ships and their lasers. */
export type HitKind = ObstacleKind | 'enemy' | 'laser';

/** One game action. The session workflow runs one Temporal activity per event. */
export interface GameEvent { type: string; t_ms: number; kind?: string; value?: number }

export interface GameHooks {
  onScenario: (s: Scenario) => void;
  onBreak: (id: SystemId) => void;
  onRepair: (id: SystemId, byTemporal: boolean) => void;
  onCharge: (charges: number) => void;
  onDeploy: () => void;
  onDurableEnd: () => void;
  onEmergency: () => void;
}

/** Snapshot sent to (and restored from) the FlightSessionWorkflow. */
export interface Snapshot {
  elapsed_ms: number;
  score: number;
  distance: number;
  hull: number;
  broken: SystemId[];
  durable: boolean;
  deploys: number;
  repairs: number;
  damage_taken: number;
  temporal_charges: number;
  next_threshold: number;
}

const DAMAGE: Record<HitKind, number> = { asteroid: 10, debris: 7, mine: 18, bolt: 9, ring: 0, enemy: 14, laser: 8 };
const HEAVY: HitKind[] = ['mine', 'enemy', 'laser'];
const KILL_BASE: Partial<Record<ObstacleKind, number>> = { asteroid: CONFIG.ASTEROID_POINTS, debris: CONFIG.DEBRIS_POINTS, mine: CONFIG.ASTEROID_POINTS * 1.6 };
const RING_BONUS = 150;
const lerp = (a: number, b: number, t: number) => a + (b - a) * Math.max(0, Math.min(1, t));
const smooth = (t: number) => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };

export class Game {
  elapsedMs = 0;
  score = 0;
  distance = 0;
  hull = 100;
  deploys = 0;
  repairs = 0;
  damageTaken = 0;
  charges = 0;
  nextThreshold: number = CONFIG.THRESHOLD;
  durableUntil = 0;
  durableForever = false;
  kills = 0;
  enemyKills = 0;
  shots = 0;
  /** Consecutive blaster hits without a miss (feeds the streak bonus). */
  streak = 0;
  bestStreak = 0;
  nearMisses = 0;
  /** When each system broke, for the repair-speed bonus. */
  private brokeAt: Partial<Record<SystemId, number>> = {};
  systems: Record<SystemId, SystemState>;
  scenario: Scenario = CALM;
  /** Events since the last telemetry flush (each becomes a Temporal activity). */
  pendingEvents: GameEvent[] = [];
  /** Per-type counts kept locally, for the offline summary. */
  localCounts: Record<string, number> = {};
  /** Elapsed ms at which each Temporal charge was earned (for tuning reports). */
  chargeTimes: number[] = [];

  private schedule = buildSchedule(CONFIG.GAME_SECONDS);
  private scheduleIdx = -1;
  private scenarioStartMs = 0;
  private breakAcc = 0;

  constructor(private hooks: GameHooks) {
    this.systems = Object.fromEntries(SYSTEMS.map((s) => [s.id, { broken: false, progress: 0, need: 1 }])) as Record<SystemId, SystemState>;
  }

  get over(): boolean { return this.elapsedMs >= CONFIG.GAME_SECONDS * 1000; }
  get timeLeftS(): number { return Math.max(0, CONFIG.GAME_SECONDS - this.elapsedMs / 1000); }
  get tS(): number { return this.elapsedMs / 1000; }
  /** 0 during the easy opening, then ramps 0..1, reaching full intensity at MAX_AT_S and holding. */
  get ramp(): number { return Math.max(0, Math.min(1, (this.tS - CONFIG.EASY_SECONDS) / (CONFIG.MAX_AT_S - CONFIG.EASY_SECONDS))); }
  /** 0..1 over the whole climb to full speed (0 at launch, 1 at MAX_AT_S). */
  get climb(): number { return Math.min(1, this.tS / CONFIG.MAX_AT_S); }
  get durable(): boolean { return this.durableForever || this.elapsedMs < this.durableUntil; }
  get durableLeftMs(): number { return this.durableForever ? Infinity : Math.max(0, this.durableUntil - this.elapsedMs); }
  broken(id: SystemId): boolean { return this.systems[id].broken; }
  get brokenCount(): number { return SYSTEMS.filter((s) => this.systems[s.id].broken).length; }
  /** Taps a system breaking right now would need. */
  get tapsNow(): number { return repairTapsAt(this.elapsedMs); }

  // ---- difficulty ramp (read by the engine every frame) ----
  /** Cruise speed: starts slow for practice, accelerates to MAX_SPEED at MAX_AT_S, then holds. */
  get cruise(): number { return lerp(CONFIG.START_SPEED, CONFIG.MAX_SPEED, smooth(this.climb)); }
  get speed(): number { return this.cruise * (this.broken('engines') ? 0.65 : 1) * (this.durable ? 1.1 : 1); }
  /** Seconds between hazards. One at a time, never clustered; gaps shrink as the clock runs down. */
  get spawnGap(): number { return this.tS < CONFIG.EASY_SECONDS ? CONFIG.EASY_SPAWN_GAP : lerp(1.6, 0.45, this.ramp); }
  /** Asteroid size multiplier: pebbles early, boulders late. */
  get sizeScale(): number { return lerp(0.4, 1.8, Math.pow(this.climb, 0.9)); }
  /** Extra closing speed for hazards late in the game. */
  get hazardSpeed(): number { return lerp(0, 22, this.ramp); }
  get enemyGap(): number {
    if (this.tS < CONFIG.EASY_SECONDS) return Infinity;
    return lerp(11, 4, this.ramp) / (this.scenario.enemyBoost ?? 1);
  }
  get maxEnemies(): number { return this.tS < 55 ? 1 : 2; }
  get enemyFireGap(): number { return lerp(2.4, 1.1, this.ramp); }

  // ---- scoring ----
  /** 0.4..1: how much of the full points rate broken systems leave you. */
  get rateFactor(): number {
    return Math.max(CONFIG.RATE_FLOOR, 1 - CONFIG.RATE_PENALTY_PER_BROKEN * this.brokenCount);
  }
  /** Bonus multipliers (wormhole, Temporal). */
  get multiplier(): number {
    let m = this.scenario.multiplier ?? 1;
    if (this.durable) m *= CONFIG.DURABLE_MULTIPLIER;
    return m;
  }
  /**
   * Continuous distance scoring: faster flight earns more, with a floor so the
   * slow practice opening still counts. Never rounded, so ties are rare.
   */
  get pointsPerSec(): number {
    return CONFIG.POINTS_PER_SEC * (0.7 + 0.3 * (this.speed / CONFIG.MAX_SPEED)) * this.rateFactor * this.multiplier;
  }

  /** Advance the simulation. Returns true on the frame the game ends. */
  update(dtMs: number): boolean {
    if (this.over) return false;
    const wasDurable = this.durable;
    this.elapsedMs = Math.min(this.elapsedMs + dtMs, CONFIG.GAME_SECONDS * 1000);
    const dt = dtMs / 1000;

    while (this.scheduleIdx + 1 < this.schedule.length && this.schedule[this.scheduleIdx + 1].at <= this.tS) {
      this.scheduleIdx++;
      this.scenario = this.schedule[this.scheduleIdx].s;
      this.scenarioStartMs = this.elapsedMs;
      if (this.scenario.banner) this.log('sector', this.scenario.id);
      this.hooks.onScenario(this.scenario);
    }

    this.distance += this.speed * dt;
    // Score only ever goes up; broken systems just slow how fast it grows.
    this.addScore(this.pointsPerSec * dt);

    // Storms/flares glitch systems, but never more than 1-2 at a time.
    if (this.scenario.breakRate && this.brokenCount < 2) {
      this.breakAcc += this.scenario.breakRate * dt;
      if (this.breakAcc >= 1) {
        this.breakAcc = 0;
        const pool: SystemId[] = this.scenario.id === 'flare' ? ['sensors', 'navigation', 'shields'] : SYSTEMS.map((s) => s.id);
        this.breakRandom(pool);
      }
    }
    // After the easy opening, an occasional random fault keeps the panel busy.
    if (this.tS > CONFIG.EASY_SECONDS && this.brokenCount === 0 && Math.random() < dt * 0.05) {
      this.breakRandom(SYSTEMS.map((s) => s.id));
    }

    if (wasDurable && !this.durable) this.hooks.onDurableEnd();
    return this.over;
  }

  get scenarioProgress(): number {
    return Math.min(1, (this.elapsedMs - this.scenarioStartMs) / (this.scenario.durationS * 1000));
  }

  private addScore(pts: number): void {
    this.score += pts;
    while (this.score >= this.nextThreshold) {
      this.nextThreshold += CONFIG.THRESHOLD;
      this.charges++;
      this.chargeTimes.push(Math.round(this.elapsedMs));
      this.log('temporal_charge', '', this.charges);
      this.hooks.onCharge(this.charges);
    }
  }

  /** Break one random healthy system, respecting MAX_BROKEN. Returns true if one broke. */
  breakRandom(pool: SystemId[]): boolean {
    if (this.durable || this.brokenCount >= CONFIG.MAX_BROKEN) return false;
    const candidates = pool.filter((id) => !this.systems[id].broken);
    if (!candidates.length) return false;
    const id = candidates[Math.floor(Math.random() * candidates.length)];
    this.systems[id] = { broken: true, progress: 0, need: this.tapsNow };
    this.brokeAt[id] = this.elapsedMs;
    this.log('system_failure', id, 0);
    this.hooks.onBreak(id);
    return true;
  }

  hit(kind: HitKind): void {
    let dmg = DAMAGE[kind];
    if (this.broken('shields')) dmg *= 2;
    if (this.durable) dmg *= 0.4;
    this.hull -= dmg;
    this.damageTaken += dmg;
    this.log('collision', kind, Math.round(dmg));
    if (!this.durable) {
      // A collision knocks out 1 system (heavy hits: up to MAX_BREAKS_PER_HIT), never the whole ship.
      const n = HEAVY.includes(kind) ? 1 + (Math.random() < 0.5 ? 1 : 0) : Math.random() < 0.7 ? 1 : 0;
      const weighted: SystemId[] = ['shields', 'shields', 'engines', 'navigation', 'sensors', 'life_support', 'cargo'];
      for (let i = 0; i < Math.min(n, CONFIG.MAX_BREAKS_PER_HIT); i++) {
        this.breakRandom(kind === 'bolt' ? ['sensors', 'navigation', 'engines'] : weighted);
      }
    }
    if (this.hull <= 0) {
      this.hull = CONFIG.HULL_EMERGENCY_RESTORE;
      this.hooks.onEmergency();
    }
  }

  ring(): void { this.addScore(RING_BONUS * this.multiplier); }

  /** Obstacle passed within a whisker: bonus scales with how close (0..1). */
  nearMiss(closeness: number): number {
    const pts = CONFIG.NEAR_MISS_POINTS * closeness * closeness * this.multiplier;
    this.nearMisses++;
    this.addScore(pts);
    return pts;
  }

  shot(): void { this.shots++; this.log('fire_blaster'); }
  /** A bolt expired without hitting anything: the accuracy streak resets. */
  missed(): void { this.streak = 0; }

  private streakBonus(): number {
    this.streak++;
    this.bestStreak = Math.max(this.bestStreak, this.streak);
    return CONFIG.STREAK_POINTS * (this.streak - 1);
  }

  /** A blaster bolt destroyed a hazard `range` units away. Returns points awarded. */
  destroyed(kind: ObstacleKind, radius: number, range: number): number {
    const pts = ((KILL_BASE[kind] ?? 0) * (0.6 + radius * 0.4) + range * 0.11 + this.streakBonus()) * this.multiplier;
    this.kills++;
    this.addScore(pts);
    this.log('destroy_obstacle', kind, Math.round(pts));
    return pts;
  }

  /** Enemy kill: worth more the farther away it was and the faster we were flying. */
  enemyDestroyed(range: number): number {
    const pts = (CONFIG.ENEMY_POINTS + range * 2.4 + this.speed * 1.3 + this.streakBonus()) * this.multiplier;
    this.enemyKills++;
    this.addScore(pts);
    this.log('destroy_enemy', 'fighter', Math.round(pts));
    return pts;
  }

  /** One tap on a broken system tile. Returns true when it is fixed. */
  tapRepair(id: SystemId): boolean {
    const s = this.systems[id];
    if (!s.broken) return false;
    s.progress++;
    this.log('repair_tap', id, s.progress);
    if (s.progress >= s.need) {
      this.systems[id] = { broken: false, progress: 0, need: 1 };
      this.repairs++;
      // Quick repairs pay: full bonus if fixed within a second, fading to 0 by 8s.
      const secs = (this.elapsedMs - (this.brokeAt[id] ?? this.elapsedMs)) / 1000;
      this.addScore(CONFIG.REPAIR_SPEED_POINTS * Math.max(0, 1 - Math.max(0, secs - 1) / 7));
      this.hooks.onRepair(id, false);
      return true;
    }
    return false;
  }

  deployTemporal(): boolean {
    if (this.charges <= 0 || this.durable) return false;
    this.charges--;
    this.deploys++;
    for (const s of SYSTEMS) {
      if (this.systems[s.id].broken) { this.systems[s.id] = { broken: false, progress: 0, need: 1 }; this.hooks.onRepair(s.id, true); }
    }
    this.hull = Math.min(100, this.hull + 25);
    if (CONFIG.LOCK_FOR_REST_OF_GAME) this.durableForever = true;
    else this.durableUntil = this.elapsedMs + CONFIG.DURATION_MS;
    this.log('deploy_temporal', '', this.deploys);
    this.hooks.onDeploy();
    return true;
  }

  private log(type: string, kind = '', value = 0): void {
    this.pendingEvents.push({ type, t_ms: Math.round(this.elapsedMs), kind, value });
    if (type !== 'sector') this.localCounts[type] = (this.localCounts[type] ?? 0) + 1;
  }

  snapshot(): Snapshot {
    return {
      elapsed_ms: Math.round(this.elapsedMs),
      score: Math.floor(this.score),
      distance: Math.round(this.distance),
      hull: Math.round(this.hull),
      broken: SYSTEMS.map((s) => s.id).filter((id) => this.systems[id].broken),
      durable: this.durable,
      deploys: this.deploys,
      repairs: this.repairs,
      damage_taken: Math.round(this.damageTaken),
      temporal_charges: this.charges,
      next_threshold: this.nextThreshold,
    };
  }

  /** Rehydrate from the workflow's last known state after a crash/reload. */
  restore(s: Snapshot): void {
    this.elapsedMs = s.elapsed_ms;
    this.score = s.score;
    this.distance = s.distance;
    this.hull = s.hull;
    this.deploys = s.deploys;
    this.repairs = s.repairs;
    this.damageTaken = s.damage_taken;
    this.charges = s.temporal_charges;
    this.nextThreshold = s.next_threshold || CONFIG.THRESHOLD * (Math.floor(s.score / CONFIG.THRESHOLD) + 1);
    const need = repairTapsAt(this.elapsedMs);
    for (const sys of SYSTEMS) this.systems[sys.id] = { broken: s.broken.includes(sys.id), progress: 0, need };
    // Durable timers are not restored exactly; a short grace period is kinder.
    this.durableUntil = s.durable ? this.elapsedMs + 3000 : 0;
    // Skip the schedule forward without replaying banners for past sectors.
    while (this.scheduleIdx + 1 < this.schedule.length && this.schedule[this.scheduleIdx + 1].at <= this.tS) this.scheduleIdx++;
    this.scenario = this.scheduleIdx >= 0 ? this.schedule[this.scheduleIdx].s : CALM;
    this.scenarioStartMs = this.scheduleIdx >= 0 ? this.schedule[this.scheduleIdx].at * 1000 : 0;
    this.hooks.onScenario(this.scenario);
  }
}
