import '../shared/theme.css';
import './flight.css';
import { h, sleep } from '../shared/dom';
import { installChrome } from '../shared/chrome';
import { onScreenKeyboard } from '../shared/keyboard';
import { consentNote, CONSENT_TEXT_VERSION } from '../shared/consent';
import { CONFIG, SYSTEMS, type SystemId } from './config';
import { FlightEngine } from './engine';
import { Game } from './game';
import { CALM, type Scenario } from './scenarios';
import { Sfx } from './audio';
import { FlightNet, type ActivitySummary, type DayPodium, type LeaderboardEntry, type LeaderboardView, type SessionState } from './net';

type Mode = 'attract' | 'countdown' | 'playing' | 'gameover' | 'initials' | 'email' | 'leaderboard';

const sfx = new Sfx();
const net = new FlightNet();
let mode: Mode = 'attract';
let game: Game;
let lastLeaderboard: LeaderboardView = { entries: [], day_label: 'Today', champions: [], total_games: 0 };

// ---------- static DOM ----------
// Everything sits inside the flying area: systems flank the view (3 left, 3
// right), the blaster and Temporal buttons sit along the bottom, and the
// bottom-right corner holds only a read-only gauge (the admin hot corner).
const app = document.getElementById('app')!;
const stage = h('div', { class: 'fd-stage' });
const overlay = h('div', { class: 'fd-overlay' });
app.append(stage, overlay);

const vignette = h('div', { class: 'fd-vignette' });
const flash = h('div', { class: 'fd-flash' });
const staticFx = h('div', { class: 'fd-static' });
const sweep = h('div', { class: 'fd-sweep' });
const cockpit = h('div', { class: 'fd-cockpit', html: cockpitSvg() });
const banner = h('div', { class: 'fd-banner' }, h('h2', {}), h('p', {}));
const reticle = h('div', { class: 'fd-joy' }, h('i'));
const hint = h('div', { class: 'fd-hint' }, 'Steer toward the pointer · click / Space to fire · tap red panels to repair');
const wfStrip = h('div', { class: 'fd-wf' });
const sideL = h('div', { class: 'fd-side left' });
const sideR = h('div', { class: 'fd-side right' });
const blasterBtn = h('button', { class: 'fd-blaster', 'aria-label': 'Fire blaster' }, h('span', { class: 'bi' }, '✦'), h('span', {}, 'Blaster'));
const temporalBtn = h('button', { class: 'fd-temporal', 'aria-label': 'Deploy Temporal' });
const gaugeVal = h('div', { class: 'gv' }, '100%');
const gaugeBar = h('i');
const gauge = h('div', { class: 'fd-gauge', 'aria-hidden': 'true' }, h('div', { class: 'gl' }, 'Points rate'), gaugeVal, h('div', { class: 'gb' }, gaugeBar));

const hudScore = h('div', { class: 'val' }, '0');
const hudTime = h('div', { class: 'val' }, String(CONFIG.GAME_SECONDS));
const hudHull = h('i', { style: 'width:100%' });
const hudHullVal = h('div', { class: 'val' }, '100%');
const chipTaps = h('span', { class: 'fd-chip' }, 'Repair: 1 tap');
const chipMult = h('span', { class: 'fd-chip mult', style: 'display:none' }, '');
const chipRate = h('span', { class: 'fd-chip rate' }, 'Points rate 100%');
const chipNet = h('span', { class: 'fd-chip off', style: 'display:none' }, 'Offline');
const nextBar = h('i', { style: 'width:0;background:var(--uv)' });
const timeBox = h('div', { class: 'time' }, h('div', { class: 'lbl' }, 'Time'), hudTime);
const hud = h('div', { class: 'fd-hud' },
  h('div', { style: 'padding-left:calc(var(--u)*0.5)' }, h('div', { class: 'lbl' }, 'Score'), hudScore,
    h('div', { class: 'lbl', style: 'margin-top:calc(var(--u)*0.6)' }, 'Next Temporal'), h('div', { class: 'fd-bar' }, nextBar),
    h('div', { class: 'fd-chips' }, chipRate, chipMult, chipNet)),
  timeBox,
  h('div', { class: 'right' }, h('div', { class: 'lbl' }, 'Hull'), hudHullVal, h('div', { class: 'fd-bar' }, hudHull),
    h('div', { class: 'fd-chips', style: 'justify-content:flex-end' }, chipTaps)),
);
const muteBtn = h('button', { class: 'fd-mute', onclick: () => { muteBtn.textContent = sfx.toggleMute() ? '🔇' : '🔊'; } }, sfx.muted ? '🔇' : '🔊');
stage.append(vignette, staticFx, cockpit, flash, sweep, banner, hud, reticle, hint, wfStrip, sideL, sideR, blasterBtn, temporalBtn, gauge, muteBtn);

// ---------- engine ----------
const engine = new FlightEngine(stage, {
  onHit: (kind) => {
    if (mode !== 'playing') return;
    game.hit(kind);
    sfx.hit(kind === 'mine' || kind === 'enemy');
    flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on');
    navigator.vibrate?.(60);
  },
  onRing: () => { if (mode === 'playing') { game.ring(); sfx.ring(); toast('+ring bonus', 'var(--uv-glow)'); } },
  onDestroy: (kind, radius, range) => {
    if (mode !== 'playing') return;
    const p = game.destroyed(kind, radius, range);
    sfx.boom(false);
    toast(game.streak > 2 ? `+${Math.round(p)} · streak ×${game.streak}` : `+${Math.round(p)}`, 'var(--amber)', true);
  },
  onEnemyDestroyed: (range) => {
    if (mode !== 'playing') return;
    const p = game.enemyDestroyed(range);
    sfx.boom(true);
    toast(`Enemy down +${Math.round(p)}`, 'var(--mint)');
  },
  onNearMiss: (c) => { if (mode === 'playing') { const p = game.nearMiss(c); if (c > 0.35) toast(`Near miss +${Math.round(p)}`, 'var(--sky)', true); } },
  onMiss: () => { if (mode === 'playing') game.missed(); },
});

// ---------- system tiles ----------
const tileEls = new Map<SystemId, { el: HTMLButtonElement; st: HTMLElement; fx: HTMLElement; ring: SVGCircleElement }>();
const RING_LEN = 2 * Math.PI * 20;
SYSTEMS.forEach((s, i) => {
  const st = h('span', { class: 'st' }, 'Online');
  const fx = h('span', { class: 'fx' }, s.effect);
  const ringWrap = h('span', { class: 'ring', html: `<svg viewBox="0 0 50 50"><circle class="bg" cx="25" cy="25" r="20"/><circle class="fg" cx="25" cy="25" r="20" stroke-dasharray="${RING_LEN}" stroke-dashoffset="${RING_LEN}"/></svg>` });
  const el = h('button', { class: 'fd-tile' },
    h('span', { class: 'nm' }, h('span', { class: 'ic' }, s.icon), s.name), ringWrap, st, fx);
  // The whole tile is the tap target (children have pointer-events: none).
  el.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); repair(s.id); });
  (i < 3 ? sideL : sideR).append(el);
  tileEls.set(s.id, { el, st, fx, ring: ringWrap.querySelector('.fg') as SVGCircleElement });
});

function repair(id: SystemId): void {
  if (mode !== 'playing' || !game.broken(id)) return;
  const done = game.tapRepair(id);
  const t = tileEls.get(id)!.el;
  t.classList.remove('tap'); void t.offsetWidth; t.classList.add('tap');
  if (done) sfx.repaired(); else sfx.tap(game.systems[id].progress);
  navigator.vibrate?.(15);
  renderTiles();
}

function renderTiles(): void {
  const durable = game?.durable ?? false;
  for (const s of SYSTEMS) {
    const t = tileEls.get(s.id)!;
    const st = game?.systems[s.id];
    const broken = !!st?.broken;
    t.el.classList.toggle('broken', broken);
    t.el.classList.toggle('durable', durable);
    const p = st?.progress ?? 0, need = st?.need ?? 1;
    const left = need - p;
    t.st.textContent = broken ? (p ? `${left} more tap${left === 1 ? '' : 's'}` : `${s.fix}: tap ${need}×`) : durable ? '🔒 Durable' : 'Online';
    t.fx.textContent = `${s.effect} · −${Math.round(CONFIG.RATE_PENALTY_PER_BROKEN * 100)}% pts`;
    t.ring.style.strokeDashoffset = String(RING_LEN * (1 - p / need));
  }
}

// ---------- Temporal button ----------
const emblemBox = h('div', { class: 'emblem', html: emblemSvg() });
const tCap = h('div', { class: 'cap' }, 'Temporal');
const tSub = h('div', { class: 'sub' }, `Earn ${CONFIG.THRESHOLD.toLocaleString()} pts to unlock`);
const tCharges = h('div', { class: 'charges' }, '1');
temporalBtn.append(tCharges, emblemBox, h('div', {}, tCap, tSub));
temporalBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); deploy(); });
void loadOfficialLogo();

async function loadOfficialLogo(): Promise<void> {
  // Drop an official logo at web/public/flight/temporal-logo.svg to replace the placeholder emblem.
  try {
    const r = await fetch(CONFIG.LOGO_URL, { method: 'HEAD' });
    if (r.ok && (r.headers.get('content-type') ?? '').includes('svg')) {
      emblemBox.replaceChildren(h('img', { src: CONFIG.LOGO_URL, alt: 'Temporal' }));
    }
  } catch { /* keep placeholder */ }
}

function deploy(): void {
  if (mode !== 'playing') return;
  game.deployTemporal();
}

function renderTemporal(): void {
  const ready = game.charges > 0 && !game.durable;
  temporalBtn.classList.toggle('ready', ready);
  temporalBtn.classList.toggle('active', game.durable);
  tCharges.textContent = game.charges > 1 ? `×${game.charges}` : '1';
  if (game.durable) {
    tCap.textContent = 'Temporal active';
    tSub.textContent = CONFIG.LOCK_FOR_REST_OF_GAME ? 'All systems durable' : `All systems durable · ${Math.ceil(game.durableLeftMs / 1000)}s`;
  } else if (ready) {
    tCap.textContent = 'Deploy Temporal';
    tSub.textContent = 'Tap (or press T) to lock every system';
  } else {
    tCap.textContent = 'Temporal';
    tSub.textContent = `${Math.max(0, Math.ceil(game.nextThreshold - game.score)).toLocaleString()} pts to unlock`;
  }
}

// ---------- input ----------
// Free flight: the pointer's offset from the view centre is a turn *rate*.
// Centre (or no finger) = hold your current heading; nothing ever re-centres.
const keys = new Set<string>();
let turn = { x: 0, y: 0 };
let steerPointer: number | null = null;
const DEAD = 0.07;
const curve = (v: number) => (Math.abs(v) < DEAD ? 0 : Math.sign(v) * Math.pow((Math.abs(v) - DEAD) / (1 - DEAD), 1.25));

function aim(e: PointerEvent): void {
  if (mode !== 'playing') return;
  const onControl = !!(e.target as HTMLElement).closest('button');
  if (e.pointerType === 'mouse') {
    // Hovering a control = hold course, so reaching for a tile doesn't yank the ship.
    if (onControl) { turn = { x: 0, y: 0 }; reticle.classList.remove('on'); return; }
  } else {
    if (e.type === 'pointerdown') { if (onControl || steerPointer !== null) return; steerPointer = e.pointerId; }
    if (e.pointerId !== steerPointer) return;
  }
  const r = stage.getBoundingClientRect();
  const px = e.clientX - r.left, py = e.clientY - r.top;
  turn = { x: curve(Math.max(-1, Math.min(1, (px / r.width) * 2 - 1)) * 1.6), y: curve(Math.max(-1, Math.min(1, 1 - (py / r.height) * 2)) * 1.6) };
  turn.x = Math.max(-1, Math.min(1, turn.x)); turn.y = Math.max(-1, Math.min(1, turn.y));
  reticle.style.left = `${px}px`;
  reticle.style.top = `${py}px`;
  reticle.classList.add('on');
  hint.style.opacity = '0';
}
const endSteer = (e: PointerEvent) => {
  if (e.pointerType !== 'mouse' && e.pointerId === steerPointer) { steerPointer = null; turn = { x: 0, y: 0 }; reticle.classList.remove('on'); }
};
stage.addEventListener('pointerdown', aim);
stage.addEventListener('pointermove', aim);
stage.addEventListener('pointerup', endSteer);
stage.addEventListener('pointercancel', endSteer);
document.addEventListener('pointerleave', () => { turn = { x: 0, y: 0 }; });

// Blaster: hold to auto-fire. Mouse button on the view, the BLASTER button, or Space.
let fireCooldown = 0;
const mouseFire = { on: false };
stage.addEventListener('pointerdown', (e) => {
  if (mode === 'playing' && e.pointerType === 'mouse' && e.button === 0 && !(e.target as HTMLElement).closest('button')) { mouseFire.on = true; fireNow(); }
});
window.addEventListener('pointerup', (e) => { if (e.pointerType === 'mouse') mouseFire.on = false; });
const blasterPointers = new Set<number>();
blasterBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault(); e.stopPropagation();
  blasterPointers.add(e.pointerId); blasterBtn.classList.add('on'); fireNow();
});
const blasterUp = (e: PointerEvent) => { blasterPointers.delete(e.pointerId); if (!blasterPointers.size) blasterBtn.classList.remove('on'); };
blasterBtn.addEventListener('pointerup', blasterUp);
blasterBtn.addEventListener('pointercancel', blasterUp);
blasterBtn.addEventListener('pointerleave', blasterUp);

function fireNow(): void {
  if (mode !== 'playing' || fireCooldown > 0) return;
  fireCooldown = 1 / CONFIG.BLASTER_PER_SEC;
  engine.fire();
  game.shot();
  sfx.laser();
}

window.addEventListener('keydown', (e) => {
  if (mode !== 'playing') return;
  const k = e.key.toLowerCase();
  keys.add(k);
  if (k === ' ') { e.preventDefault(); fireNow(); }
  if (k === 't' || k === 'enter') { e.preventDefault(); deploy(); }
  const n = Number(e.key);
  if (n >= 1 && n <= SYSTEMS.length) repair(SYSTEMS[n - 1].id);
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

function steerInput(): { x: number; y: number } {
  const x = (keys.has('arrowright') || keys.has('d') ? 1 : 0) - (keys.has('arrowleft') || keys.has('a') ? 1 : 0);
  const y = (keys.has('arrowup') || keys.has('w') ? 1 : 0) - (keys.has('arrowdown') || keys.has('s') ? 1 : 0);
  return x || y ? { x, y } : turn;
}
function firing(): boolean { return mouseFire.on || blasterPointers.size > 0 || keys.has(' '); }

// ---------- overlay screens ----------
let cleanups: (() => void)[] = [];
let screenToken = 0;
/** Swap the overlay screen, tearing down keyboards owned by the old one. Call own() after this. */
function setOverlay(...nodes: Node[]): number {
  cleanups.splice(0).forEach((f) => f());
  overlay.replaceChildren(...nodes);
  return ++screenToken;
}
function own<T extends { destroy: () => void }>(kb: T): T { cleanups.push(() => kb.destroy()); return kb; }

// ---------- feedback helpers ----------
let bannerTimer = 0;
function showBanner(title: string, sub: string, color: string, alert = false, ms = 2600): void {
  (banner.children[0] as HTMLElement).textContent = title;
  (banner.children[1] as HTMLElement).textContent = sub;
  banner.style.setProperty('--banner', color);
  banner.classList.remove('on', 'alert'); void banner.offsetWidth;
  banner.classList.add('on');
  if (alert) banner.classList.add('alert');
  clearTimeout(bannerTimer);
  bannerTimer = window.setTimeout(() => banner.classList.remove('on'), ms);
}
function toast(text: string, color = 'var(--mint)', small = false): void {
  const t = h('div', { class: `fd-toast${small ? ' small' : ''}`, style: `color:${color}` }, text);
  stage.append(t);
  setTimeout(() => t.remove(), 1500);
}
const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

// ---------- game lifecycle ----------
function newGame(): Game {
  return new Game({
    onScenario: (s: Scenario) => {
      engine.setScenario(s);
      staticFx.classList.toggle('on', s.id === 'ion');
      if (s.banner && mode === 'playing') {
        showBanner(s.banner, s.sub, hex(s.accent), !!s.klaxon);
        if (s.klaxon) sfx.klaxon();
      }
    },
    onBreak: (id) => { sfx.alarm(); const s = SYSTEMS.find((x) => x.id === id)!; toast(`${s.name} offline!`, 'var(--coral)'); renderTiles(); },
    onRepair: (id, byTemporal) => {
      const t = tileEls.get(id)!.el;
      t.classList.remove('fixed'); void t.offsetWidth; t.classList.add('fixed');
      if (!byTemporal) toast(`${SYSTEMS.find((x) => x.id === id)!.name} restored`, 'var(--mint)');
      renderTiles();
    },
    onCharge: () => { sfx.charge(); showBanner('Temporal ready', 'Tap the glowing button (or press T) to deploy', '#a99fff', false, 2200); },
    onDeploy: () => {
      sfx.whoosh();
      sweep.classList.remove('on'); void sweep.offsetWidth; sweep.classList.add('on');
      warpKick = 1;
      showBanner('Temporal deployed', 'Every system retries until it succeeds', '#a99fff', false, 3000);
      renderTiles();
    },
    onDurableEnd: () => { toast('Temporal window closed', 'var(--uv-glow)'); renderTiles(); },
    onEmergency: () => { showBanner('Hull breach!', `Emergency patch: hull back to ${CONFIG.HULL_EMERGENCY_RESTORE}%`, '#ff6b7a', true, 2200); sfx.klaxon(); },
  });
}

let warpKick = 0;
/** Dev-only scripted pilot: autopilot steering + "average" human reaction times. */
let autoplay = false;
const AUTO = { reactMs: 2500, tapEveryMs: 300, deployDelayMs: 1500, fireChance: 0.03 };
const autoState = { brokenAt: new Map<SystemId, number>(), lastTap: 0, chargeAt: 0 };
function autoPilotTick(): void {
  const now = game.elapsedMs;
  for (const s of SYSTEMS) {
    if (!game.broken(s.id)) { autoState.brokenAt.delete(s.id); continue; }
    if (!autoState.brokenAt.has(s.id)) autoState.brokenAt.set(s.id, now);
    if (now - autoState.brokenAt.get(s.id)! > AUTO.reactMs && now - autoState.lastTap > AUTO.tapEveryMs) {
      autoState.lastTap = now;
      repair(s.id);
      break; // one finger: one system at a time
    }
  }
  if (engine.hasTarget() && Math.random() < AUTO.fireChance) fireNow();
  if (game.charges > 0 && !game.durable) {
    if (!autoState.chargeAt) autoState.chargeAt = now;
    if (now - autoState.chargeAt > AUTO.deployDelayMs) { autoState.chargeAt = 0; deploy(); }
  }
}
let telemetryAcc = 0;

async function startGame(resumeFrom?: SessionState): Promise<void> {
  sfx.unlock();
  game = newGame();
  engine.reset();
  autoState.brokenAt.clear(); autoState.lastTap = 0; autoState.chargeAt = 0;
  turn = { x: 0, y: 0 };
  mode = 'countdown';
  document.body.classList.add('fd-playing');
  renderTiles();
  renderTemporal();
  if (resumeFrom) {
    net.adopt(resumeFrom);
    game.restore(resumeFrom);
    renderTiles();
  } else {
    engine.setScenario(CALM);
  }
  updateWfStrip();
  hint.style.opacity = '1';
  await countdown();
  mode = 'playing';
  if (resumeFrom) showRecovered(resumeFrom);
  else if (game.scenario.banner) showBanner(game.scenario.banner, game.scenario.sub, hex(game.scenario.accent), true);
}

function updateWfStrip(): void {
  const st = net.lastState;
  wfStrip.textContent = net.workflowId
    ? `◉ Temporal workflow ${net.workflowId}${st ? ` · ${st.activities_total + st.activities_pending} activities · ${st.history_events} history events` : ''}`
    : 'Offline: flying without Temporal (no crash recovery)';
}

async function countdown(): Promise<void> {
  setOverlay();
  const box = h('div', { class: 'fd-screen' });
  overlay.append(box);
  for (const n of ['3', '2', '1']) {
    box.replaceChildren(h('div', { class: 'fd-count' }, n));
    sfx.beep();
    await sleep(800);
  }
  box.replaceChildren(h('div', { class: 'fd-count', style: 'font-size:calc(var(--u)*12)' }, 'Launch'));
  sfx.beep(true);
  warpKick = 1.2;
  await sleep(500);
  setOverlay();
}

function showRecovered(st: SessionState): void {
  const el = h('div', { class: 'fd-recovered' },
    h('h3', {}, 'Recovered by Temporal'),
    h('p', {}, `The browser crashed, but the game didn’t. Score ${st.score.toLocaleString()}, hull ${Math.round(st.hull)}% and ${st.broken.length} broken systems were restored from ${st.history_events} events of workflow history.`),
  );
  stage.append(el);
  setTimeout(() => el.remove(), 5500);
}

// ---------- end of game: the Temporal payoff ----------
const ACTIVITY_LABELS: [string, string, string][] = [
  // [event type, label, icon]
  ['fire_blaster', 'blaster shots', '✦'],
  ['destroy_obstacle', 'hazards destroyed', '☄'],
  ['destroy_enemy', 'enemies destroyed', '✈'],
  ['collision', 'collisions', '💥'],
  ['system_failure', 'system failures', '⚠'],
  ['repair_tap', 'repair taps', '🔧'],
  ['temporal_charge', 'charges earned', '⚡'],
  ['deploy_temporal', 'Temporal deploys', '✨'],
];

async function endGame(): Promise<void> {
  mode = 'gameover';
  document.body.classList.remove('fd-playing');
  const s = game.snapshot();
  const flushed = net.flushFinal(s, game.pendingEvents.splice(0));
  const summaryBox = h('div', { class: 'fd-payoff' }, h('p', { class: 'dim' }, 'Asking the workflow what it did…'));
  const rankLine = h('p', { class: 'fd-rankline' }, 'Posting your score…');
  const boardBtn = h('button', { class: 'btn big mint', disabled: true, onclick: () => showLeaderboard(result) }, 'See the leaderboard');
  let result: { rank: number | null; score: number; name: string } = { rank: null, score: s.score, name: net.name };
  const token = setOverlay(h('div', { class: 'fd-screen dim fade-in fd-over' },
    h('p', { class: 'temporal-badge' }, `Mission complete · ${net.name}`),
    h('div', { class: 'fd-final' }, s.score.toLocaleString()),
    h('div', { class: 'fd-stats' },
      stat('Distance', `${Math.round(s.distance * 37).toLocaleString()} km`),
      stat('Kills', `${game.kills + game.enemyKills}`),
      stat('Best streak', game.bestStreak),
      stat('Temporal deploys', s.deploys),
    ),
    summaryBox,
    rankLine,
    boardBtn,
  ));
  await flushed;
  // Post the score and read the activity summary in parallel.
  const finishing = net.finish(s).then(async (r) => {
    result = r;
    lastLeaderboard = await net.leaderboard();
    if (!lastLeaderboard.entries.length) lastLeaderboard = { ...lastLeaderboard, entries: r.top };
    rankLine.textContent = r.rank ? `You’re #${r.rank} today!` : 'Not in today’s top 10 yet. One more run?';
    boardBtn.disabled = false;
  });
  const summary = await waitForSummary();
  if (token === screenToken) summaryBox.replaceWith(renderPayoff(summary));
  await finishing;
}

/** Poll the workflow's summary query until its background activities have landed. */
async function waitForSummary(): Promise<ActivitySummary | null> {
  let last: ActivitySummary | null = null;
  for (let i = 0; i < 20; i++) {
    last = await net.summary();
    if (!last || last.pending === 0) break;
    await sleep(300);
  }
  return last;
}

function renderPayoff(sm: ActivitySummary | null): HTMLElement {
  const counts = sm?.counts ?? game.localCounts;
  const total = sm ? sm.total : Object.values(counts).reduce((a, b) => a + b, 0);
  const cells = ACTIVITY_LABELS.filter(([k]) => counts[k]).map(([k, label, icon]) =>
    h('div', { class: 'fd-act' },
      h('span', { class: 'ai' }, icon),
      h('span', { class: 'an' }, (counts[k] ?? 0).toLocaleString()),
      h('span', { class: 'al' }, label),
      sm?.retries[k] ? h('span', { class: 'ar' }, `${sm.retries[k]} retried`) : null));
  return h('div', { class: 'fd-payoff fade-in' },
    h('div', { class: 'fd-payoff-head' },
      h('div', { class: 'emblem', html: emblemSvg() }),
      h('div', {},
        h('div', { class: 'k' }, sm ? 'Your flight was a Temporal workflow' : 'Offline: no workflow this time'),
        h('div', { class: 'big' }, sm ? `Temporal ran ${total.toLocaleString()} activities` : `${total.toLocaleString()} game actions`),
        h('div', { class: 'dim' }, sm ? 'One activity for every shot, hit, repair and deploy.' : 'Online, each one runs as a Temporal activity.'))),
    h('div', { class: 'fd-acts' }, ...cells),
    sm ? h('div', { class: 'fd-payoff-foot' },
      h('span', {}, h('b', {}, sm.history_events.toLocaleString()), ' history events'),
      h('span', {}, sm.total_retries ? [h('b', {}, String(sm.total_retries)), ' automatic retries, ', h('b', {}, '0'), ' lost'] : [h('b', {}, '0'), ' retries needed']),
      sm.pending ? h('span', {}, h('b', {}, String(sm.pending)), ' still running') : null,
      h('code', {}, sm.workflow_id)) : null,
  );
}

const stat = (k: string, v: string | number) => h('div', {}, h('div', { class: 'k' }, k), h('div', { class: 'v' }, String(v)));

/** Leaderboard name preview: the email's username only (the server has the final say). */
const usernameOf = (email: string) => email.split('@')[0].split('+')[0].replace(/[^A-Za-z0-9._-]/g, '').slice(0, 16);

/** Email is required to fly: it's the booth's lead capture, saved the moment the game starts. */
function askEmailToFly(): void {
  const preview = h('p', { class: 'fd-name-preview' }, 'Your leaderboard name will be your email username');
  const kb = onScreenKeyboard({
    mode: 'email', placeholder: 'you@company.com', submitLabel: 'Fly',
    onChange: (v) => {
      const u = usernameOf(v);
      preview.replaceChildren(u ? h('span', {}, 'You’ll fly as ', h('b', {}, u)) : 'Your leaderboard name will be your email username');
    },
    onSubmit: (email) => void launch(email),
  });
  setOverlay(h('div', { class: 'fd-screen dim fade-in' },
    h('h2', {}, 'Enter your email to fly'),
    h('p', { class: 'dim' }, 'Top pilots win a prize. The board shows only your email username, never your address.'),
    h('div', { class: 'fd-kb' }, preview, kb.el, consentNote()),
    h('button', { class: 'btn ghost', onclick: () => void toAttract() }, 'Back'),
  ));
  own(kb);
}

async function launch(email: string): Promise<void> {
  setOverlay(h('div', { class: 'fd-screen dim' }, h('h2', {}, 'Preparing your ship…'),
    h('p', { class: 'dim' }, 'Starting your flight workflow')));
  await net.createSession(email, CONSENT_TEXT_VERSION);
  updateWfStrip();
  await startGame();
}

function showLeaderboard(r: { rank: number | null; score: number; name: string }): void {
  const { rank, score, name } = r;
  mode = 'leaderboard';
  setOverlay(h('div', { class: 'fd-screen dim fade-in' },
    h('h2', {}, rank ? `You placed #${rank}!` : 'Not quite the top 10'),
    h('p', { class: 'dim' }, rank ? `${name} · ${score.toLocaleString()} pts` : `${score.toLocaleString()} pts. One more run?`),
    leaderboardBlock(lastLeaderboard, rank),
    h('div', { class: 'row', style: 'justify-content:center' },
      h('button', { class: 'btn big mint', onclick: () => askEmailToFly() }, 'Fly again'),
      h('button', { class: 'btn ghost', onclick: () => void toAttract() }, 'Done')),
  ));
}

function leaderboardTable(entries: LeaderboardEntry[], highlightRank: number | null = null): HTMLElement {
  const rows = entries.length
    ? entries.map((e, i) => h('tr', { class: i + 1 === highlightRank ? 'me' : '' }, h('td', {}, `${i + 1}`), h('td', {}, e.name), h('td', {}, e.score.toLocaleString())))
    : [h('tr', { class: 'empty' }, h('td', { colspan: 3 }, 'No pilots yet today. Be the first!'))];
  return h('table', { class: 'fd-lb' }, h('tbody', {}, ...rows));
}

/** Previous days' top 3, newest first: yesterday's podium is the crowd hook. */
function championsBlock(champions: DayPodium[]): HTMLElement | null {
  if (!champions.length) return null;
  const medals = ['🥇', '🥈', '🥉'];
  return h('div', { class: 'fd-champs' },
    h('h3', {}, 'Previous champions'),
    h('div', { class: 'fd-champ-days' }, ...[...champions].reverse().map((d) =>
      h('div', { class: 'fd-champ-day' },
        h('div', { class: 'dl' }, d.label),
        ...d.top.map((e, i) => h('div', { class: 'cr' }, h('span', {}, medals[i]), h('span', { class: 'cn' }, e.name), h('span', { class: 'cs' }, e.score.toLocaleString())))))));
}

function leaderboardBlock(v: LeaderboardView, highlightRank: number | null = null): HTMLElement {
  return h('div', { class: 'fd-board' },
    h('h3', { style: 'color:var(--amber)' }, `Top 10 · ${v.day_label || 'Today'}`),
    leaderboardTable(v.entries, highlightRank),
    championsBlock(v.champions));
}

async function toAttract(): Promise<void> {
  mode = 'attract';
  net.forget();
  document.body.classList.remove('fd-playing', 'fd-durable');
  vignette.classList.remove('lifesupport');
  staticFx.classList.remove('on');
  game = newGame();
  engine.reset();
  engine.setScenario({ ...CALM, color: 0x120c30, accent: 0x7b6cff });
  const lbBox = h('div', { style: 'width:100%;display:flex;justify-content:center' }, leaderboardBlock(lastLeaderboard));
  setOverlay(h('div', { class: 'fd-screen fade-in', style: 'background:linear-gradient(180deg, rgba(5,6,13,0.2), rgba(5,6,13,0.75))' },
    h('p', { class: 'temporal-badge' }, 'Holodeck program'),
    h('h1', { class: 'fd-title' }, 'Flight Deck'),
    h('p', { style: 'font-size:calc(var(--u)*2.4);max-width:36em' }, `${CONFIG.GAME_SECONDS} seconds of free flight. Blast hazards and enemy fighters, keep your systems running, then deploy Temporal.`),
    h('button', { class: 'btn big mint fd-launch', onclick: () => askEmailToFly() }, 'Tap to launch'),
    h('div', { class: 'fd-howto' },
      h('div', {}, h('span', { class: 'big' }, '✋'), h('b', {}, 'Fly'), 'Point or drag where you want to turn. Your heading stays put.'),
      h('div', {}, h('span', { class: 'big' }, '✦'), h('b', {}, 'Blast'), 'Hold BLASTER, click, or Space. Enemy ships pay big.'),
      h('div', {}, h('span', { class: 'big' }, '🔧'), h('b', {}, 'Repair'), 'Tap red panels. Repairs take more taps as time runs out.'),
      h('div', {}, h('span', { class: 'big' }, '✨'), h('b', {}, 'Deploy'), `Every ${CONFIG.THRESHOLD.toLocaleString()} pts, Temporal locks every system (T).`)),
    lbBox,
  ));
  const board = await net.leaderboard();
  lastLeaderboard = board;
  if (mode === 'attract') lbBox.replaceChildren(leaderboardBlock(board));
}

// ---------- main loop ----------
let last = performance.now();
let hudAcc = 0;
let attractFire = 0;
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  warpKick = Math.max(0, warpKick - dt * 0.9);
  fireCooldown = Math.max(0, fireCooldown - dt);
  const playing = mode === 'playing';

  if (playing) {
    const ended = game.update(dt * 1000);
    if (autoplay) autoPilotTick();
    if (firing()) fireNow();
    telemetryAcc += dt * 1000;
    if (telemetryAcc >= CONFIG.TELEMETRY_MS) {
      telemetryAcc = 0;
      net.sendTelemetry(game.snapshot(), game.pendingEvents.splice(0));
      updateWfStrip();
    }
    if (ended) void endGame();
  } else if (mode === 'attract') {
    // Attract mode shows off the blaster too.
    attractFire -= dt;
    if (attractFire <= 0 && engine.hasTarget()) { engine.fire(); attractFire = 0.35; }
  }

  const attract = mode === 'attract';
  engine.update(dt, {
    turn: playing ? steerInput() : { x: 0, y: 0 },
    speed: attract ? 45 : mode === 'countdown' ? 20 + warpKick * 40 : game.speed,
    spawnGap: playing ? game.spawnGap : attract ? 1.1 : Infinity,
    sizeScale: playing ? game.sizeScale : 1,
    hazardSpeed: playing ? game.hazardSpeed : 0,
    kinds: attract ? ['asteroid', 'asteroid', 'debris', 'ring'] : [...game.scenario.kinds],
    enemyGap: playing ? game.enemyGap : attract ? 9 : Infinity,
    maxEnemies: playing ? game.maxEnemies : 1,
    enemyFireGap: playing ? game.enemyFireGap : 3,
    navBroken: playing && game.broken('navigation'),
    sensorsBroken: playing && game.broken('sensors'),
    durable: playing && game.durable,
    autopilot: !playing || autoplay,
    warp: warpKick,
  });
  engine.render();

  // Cockpit frame leans into turns and slides with the motion.
  const tr = engine.turnRates;
  cockpit.style.transform = `translate(${(-tr.yaw * 1.6).toFixed(2)}%, ${(tr.pitch * 1.4).toFixed(2)}%) rotate(${(engine.bank * 9).toFixed(2)}deg) scale(1.06)`;

  hudAcc += dt;
  if (playing && hudAcc > 0.08) {
    hudAcc = 0;
    hudScore.textContent = Math.floor(game.score).toLocaleString();
    hudTime.textContent = Math.ceil(game.timeLeftS).toString();
    timeBox.classList.toggle('low', game.timeLeftS <= 10);
    const hull = Math.max(0, Math.round(game.hull));
    hudHullVal.textContent = `${hull}%`;
    hudHull.style.width = `${hull}%`;
    hudHull.style.background = hull > 60 ? 'var(--mint)' : hull > 30 ? 'var(--amber)' : 'var(--coral)';
    chipTaps.textContent = `Repairs: ${game.tapsNow} tap${game.tapsNow === 1 ? '' : 's'}`;
    const m = game.multiplier;
    chipMult.style.display = m !== 1 ? '' : 'none';
    chipMult.textContent = `×${m.toFixed(1)} bonus`;
    const rate = Math.round(game.rateFactor * 100);
    const rateCol = rate >= 85 ? 'var(--mint)' : rate >= 60 ? 'var(--amber)' : 'var(--coral)';
    chipRate.textContent = `Points rate ${rate}%`;
    chipRate.style.color = rateCol;
    chipRate.style.borderColor = rateCol;
    gaugeVal.textContent = `${rate}%`;
    gaugeVal.style.color = rateCol;
    gaugeBar.style.background = rateCol;
    gauge.style.setProperty('--fill', `${rate}%`);
    chipNet.style.display = net.online ? 'none' : '';
    const into = 1 - (game.nextThreshold - game.score) / CONFIG.THRESHOLD;
    nextBar.style.width = `${Math.max(0, Math.min(1, into)) * 100}%`;
    vignette.classList.toggle('lifesupport', game.broken('life_support'));
    document.body.classList.toggle('fd-durable', game.durable);
    renderTemporal();
    if (game.durable) renderTiles();
  }
  requestAnimationFrame(frame);
}

// ---------- boot ----------
installChrome();
net.onStatus = () => updateWfStrip();
game = newGame();
requestAnimationFrame(frame);

async function boot(): Promise<void> {
  const sid = net.storedSessionId();
  if (sid) {
    const st = await net.getSession(sid);
    if (st && st.status === 'playing' && st.elapsed_ms < st.game_ms - 1000) { await startGame(st); return; }
    if (st && st.status === 'ended') {
      // Crashed on the game-over screen: restore the result so the visitor can still claim their score.
      net.adopt(st);
      game = newGame();
      game.restore(st);
      game.elapsedMs = st.game_ms;
      await endGame();
      showRecoveredOverlay(st);
      return;
    }
    net.forget();
  }
  await toAttract();
}

function showRecoveredOverlay(st: SessionState): void {
  const el = h('div', { class: 'fd-recovered', style: 'position:fixed;z-index:30' },
    h('h3', {}, 'Recovered by Temporal'), h('p', {}, `Your final score of ${st.score.toLocaleString()} was restored from workflow history.`));
  document.body.append(el);
  setTimeout(() => el.remove(), 5000);
}

void boot();

// Dev-only hook for automated testing (never in production builds).
if (import.meta.env.DEV) {
  (window as unknown as { __flight: unknown }).__flight = {
    get game() { return game; }, get mode() { return mode; }, net, engine,
    get autoplay() { return autoplay; }, set autoplay(v: boolean) { autoplay = v; engine.autopilotSkill = v ? 0.35 : 1; engine.autopilotWander = v ? 0.06 : 0.3; },
    set skill(v: number) { engine.autopilotSkill = v; },
    launch: (email: string) => launch(email),
    set fireChance(v: number) { AUTO.fireChance = v; },
    set wander(v: number) { engine.autopilotWander = v; },
  };
}

// ---------- art ----------
function emblemSvg(): string {
  // Original placeholder emblem (not the official Temporal logo).
  return `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="tg" cx="50%" cy="45%" r="55%"><stop offset="0" stop-color="#e9e4ff"/><stop offset="0.45" stop-color="#9b8cff"/><stop offset="1" stop-color="#3b2fb0"/></radialGradient>
      <filter id="tb"><feGaussianBlur stdDeviation="2.2"/></filter>
    </defs>
    <circle cx="60" cy="60" r="54" fill="none" stroke="#7b6cff" stroke-width="2" opacity="0.6"/>
    <circle cx="60" cy="60" r="46" fill="none" stroke="#a99fff" stroke-width="1" stroke-dasharray="3 6" opacity="0.8"/>
    <g filter="url(#tb)" opacity="0.8"><ellipse cx="60" cy="60" rx="44" ry="16" fill="none" stroke="#b8adff" stroke-width="4" transform="rotate(-30 60 60)"/></g>
    <ellipse cx="60" cy="60" rx="44" ry="16" fill="none" stroke="#e0dbff" stroke-width="2.5" transform="rotate(-30 60 60)"/>
    <ellipse cx="60" cy="60" rx="44" ry="16" fill="none" stroke="#8f82ff" stroke-width="2" transform="rotate(30 60 60)"/>
    <polygon points="60,30 86,45 86,75 60,90 34,75 34,45" fill="url(#tg)" stroke="#fff" stroke-width="1.5"/>
    <polygon points="60,42 75,51 75,69 60,78 45,69 45,51" fill="none" stroke="#1d1660" stroke-width="3" opacity="0.7"/>
    <circle cx="104" cy="35" r="4" fill="#fff"/><circle cx="16" cy="85" r="3" fill="#d6d0ff"/>
  </svg>`;
}

function cockpitSvg(): string {
  // Canopy struts + dashboard lip framing the view; pointer-events are disabled.
  return `<svg viewBox="0 0 1000 1000" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="strut" x1="0" x2="1"><stop offset="0" stop-color="#0a0c18"/><stop offset="0.5" stop-color="#262c48"/><stop offset="1" stop-color="#0a0c18"/></linearGradient>
      <linearGradient id="dash" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1a1f3a" stop-opacity="0.0"/><stop offset="0.35" stop-color="#101428" stop-opacity="0.85"/><stop offset="1" stop-color="#05060d"/></linearGradient>
    </defs>
    <path d="M0,0 L70,0 L230,1000 L0,1000 Z" fill="url(#strut)" opacity="0.92"/>
    <path d="M1000,0 L930,0 L770,1000 L1000,1000 Z" fill="url(#strut)" opacity="0.92"/>
    <path d="M70,0 L80,0 L240,1000 L230,1000 Z" fill="#6a5cff" opacity="0.5"/>
    <path d="M930,0 L920,0 L760,1000 L770,1000 Z" fill="#6a5cff" opacity="0.5"/>
    <path d="M0,0 L1000,0 L1000,26 Q500,70 0,26 Z" fill="#0a0c18" opacity="0.95"/>
    <path d="M0,915 Q500,860 1000,915 L1000,1000 L0,1000 Z" fill="url(#dash)"/>
    <path d="M160,925 Q500,875 840,925" stroke="#59fdd0" stroke-width="2" fill="none" opacity="0.35"/>
    <g stroke="#a99fff" stroke-width="1.5" fill="none" opacity="0.35">
      <circle cx="500" cy="500" r="26"/><path d="M500,450 L500,474 M500,526 L500,550 M450,500 L474,500 M526,500 L550,500"/>
    </g>
  </svg>`;
}
