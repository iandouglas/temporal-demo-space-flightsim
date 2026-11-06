# Flight Deck: 90-Second Starship Game

A first-person cockpit flight game. Stars stream past, hazards come up ("ASTEROID
FIELD AHEAD"), the visitor steers to dodge, and ship systems break. The visitor
taps to repair them, whack-a-mole style. Every 10,000 points the big glowing
**Deploy Temporal** button lights up: press it and every system is locked
"durable" for a while. Top-10 leaderboard.

## Game loop

- **90 seconds**, then game over, initials entry (3 letters), optional email for
  a prize, leaderboard.
- **Steering**: the ship eases toward the mouse pointer, or the finger while
  dragging; arrow keys/WASD as a fallback.
- **Scoring**: points for distance, scaled by speed. Score only goes up: broken
  systems never deduct points, they slow the points rate (-15% each, floor 40%,
  shown on the HUD). Hitting things costs hull and breaks systems.
- **Sectors** (announced with a banner and klaxon, roughly every 12-15s):
  asteroid field, debris field, minefield, ion storm (breaks systems at random),
  alien drone swarm, solar flare, bonus nebula/wormhole (points multiplier).
  Difficulty ramps over the 90 seconds.
- **Systems** (big tiles): Engines, Shields, Navigation, Sensors, Life Support,
  Cargo Hold. Broken ones flash "FIX THE ENGINE", "RESTORE SHIELDS", etc. A few
  taps anywhere on the tile repairs them (4 taps). Each broken system hurts: slower engines score less, down
  shields double damage, broken navigation drifts, broken sensors cloak
  obstacles until they're close.
- **Deploy Temporal**: unlocks each time the score crosses a 10,000 multiple.
  Pressing it fixes everything and locks systems for 10 seconds, with a score
  multiplier.
- Hull at 0 isn't game over (it's a 90-second demo, everyone plays to the end):
  hull restores to 25%, no point penalty.
- **Tuning (after first playtest, 2026-09-24):** base 360 points/s, Temporal
  and wormhole bonuses 1.5x. Scripted runs reach 10k at 28-30s and earn 3
  deploys per game. Needs human playtesting. The systems panel keeps the
  bottom-right admin hot corner clear. No engine hum.

### Needs a decision

The brief had two versions of the Temporal button: "locks all systems for the
rest of the game" and "activate for the next 10 seconds". The prototype does
10 seconds of lock-down each time you cross 10k, with a config switch for
"rest of game". My recommendation: 10-second windows. It's more fun, you can
earn it 2-3 times per game, and the message still lands ("with Temporal the
failures stop being your problem").

## The Temporal story

The metaphor is the game itself (things break constantly; Temporal makes the
fixing automatic). The real Temporal use is underneath:

- **Each game is a workflow.** The browser sends telemetry to it every second.
  Staff can reload the page or kill the browser mid-game and the game resumes
  from the workflow's state with a "Recovered by Temporal" banner. This is the
  "game state that survives a crash" idea from the Holodeck notes, and it's a
  great staff trick to show on request.
- **Leaderboard is a long-running entity workflow**: updates to submit scores,
  a query for the top 10, continue-as-new to keep history small.
- Updates validate telemetry (rejects impossible score jumps), which is a
  natural "anti-cheat" line for developers.
- Optional side panel for the big screen: the Temporal UI event history of the
  current game ticking along (shown unmodified, next to the game).

## AgentCore fit: low

The game loop must run in the browser at 60fps; no LLM belongs in it. Options
if we want AgentCore anyway:
- An "AI mission control" voice that comments on your run afterward (one LLM
  call at game over). Fun, cheap, optional.
- AI-generated sector briefings. Not worth the latency.

Recommendation: don't force it. This demo carries the "Temporal keeps state"
message; the photo booth and jukebox carry AgentCore.

## Visual direction

Modern, not 8-bit: three.js cockpit view, warp-stretched starfield, per-sector
nebula colors, bloom glow, 3D rocks and mines, HUD overlay. The Temporal button
uses a placeholder emblem; drop the official logo SVG in once marketing
approves its use in a game.

## Scope

**MVP (prototype built):** game loop, sectors, systems + repairs, Temporal
button, attract mode, initials + email, leaderboard, crash/reload resume,
offline fallback (plays without backend, local leaderboard).

**Before the show:**
- Playtesting for difficulty and the 10k tuning (goal: most players deploy
  Temporal at least once).
- Touch testing on the actual screen (latency, palm rejection, multi-touch).
- Portrait layout tuned for the big vertical display.
- Prize rules (daily top score?) and a daily leaderboard reset from the admin
  panel.
- Sound design (there may be no audio at the booth; the game must work silent).

**Stretch:** two-player co-op (pilot + engineer on one big screen), which suits
a large vertical display and is great for crowds.

## Open questions

- Prize for the top score? Daily or whole-show leaderboard?
- One leaderboard across all stations or per station?
- Is initials-only OK, or do we require email to be on the leaderboard?

## Round 2 decisions (2026-09-24)

- **Layout:** 3 system tiles down each side of the cockpit view; BLASTER
  (bottom left), Deploy Temporal (bottom centre). Laptop: click/Space fires,
  T/Enter deploys.
- **Free flight:** heading persists (no re-centering); hazards spawn along the
  current heading; camera banks into turns.
- **Blaster + enemy fighters:** shoot asteroids for a few points; fighters
  swoop in and shoot back, big bonus for kills.
- **Onboarding ramp:** ship starts slow and reaches full speed at 75s, held for
  the last 15s. First 15s: 1-2 small, slow hazards, no enemies. Hazards come
  one at a time, getting bigger, faster and closer together.
- **Damage caps:** a hit breaks at most 1-2 systems; never more than 3 broken.
- **Repair taps:** 1 tap until 30s, then +1 every 15s.
- **Every game action is a Temporal activity** (collision, repair tap, shot,
  kill, deploy). A typical game runs ~130 activities and ~1,100 history
  events. The end screen shows the counts, retries and the workflow ID.
- **Email is required before launch** (primary lead capture). The leaderboard
  shows the email username only (`BenJones@temporal.io` → `BenJones`);
  blocked usernames get a callsign like `Pilot-4821`.
- **Ties:** scoring has continuous bonuses so ties are rare; the earlier score
  wins a tie.
- **Multi-day leaderboard:** one board for all stations, per Las Vegas day
  (rollover 4am, configurable). Shows today's top 10 plus the top 3 from each
  previous day, also on the attract screen. Staff "new day" override exists
  in the API; add a button to the shared admin panel later.
- **Staff review:** glance at the leaderboard daily; the username blocklist is
  basic.
