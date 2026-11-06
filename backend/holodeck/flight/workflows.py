"""Flight Deck workflows.

FlightSessionWorkflow: the game is a workflow. The browser streams telemetry
to it every second (so a crashed/reloaded tab resumes from workflow state),
and every game action in that batch (collision, repair tap, blaster shot,
kill, Temporal deploy...) becomes its own activity. Gameplay never waits on
them: the Update returns immediately and the activities run in the background.

LeaderboardWorkflow: a long-running entity workflow holding the top 10.
"""

from __future__ import annotations

import asyncio
import json
from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError

with workflow.unsafe.imports_passed_through():
    from ..shared.leads import Lead, save_lead
    from .activities import GAME_ACTIVITIES, submit_score
    from .days import day_key, day_label
    from .names import callsign, display_name
    from .models import (
        MAX_EVENTS_PER_BATCH,
        MAX_POINTS_PER_SEC,
        SCORE_SLACK,
        FinishResult,
        LeaderboardEntry,
        LeaderboardInput,
        LeaderboardView,
        ActivityReceipt,
        ActivitySummary,
        DayPodium,
        GameEvent,
        SessionInput,
        SessionState,
        SubmitResult,
        Telemetry,
    )

TOP_N = 10
EVENT_LOG_MAX = 40
# How long to keep an unfinished session (e.g. the visitor walked away) open.
ABANDON_AFTER = timedelta(minutes=10)
EVENT_TYPES = set(GAME_ACTIVITIES) | {"sector"}
GAME_ACTIVITY_RETRY = RetryPolicy(
    initial_interval=timedelta(milliseconds=200), backoff_coefficient=2, maximum_interval=timedelta(seconds=2), maximum_attempts=6
)


@workflow.defn
class FlightSessionWorkflow:
    @workflow.init
    def __init__(self, inp: SessionInput) -> None:
        # Init from input here (not in run) so updates that arrive in the
        # first workflow task already see the state.
        self.s = SessionState(session_id=inp.session_id, station=inp.station, game_ms=inp.game_ms)
        self.s.name = display_name(inp.email, inp.session_id)
        self.counts: dict[str, int] = {}
        self.retries: dict[str, int] = {}
        self.failed = 0
        self.pending = 0

    @workflow.run
    async def run(self, inp: SessionInput) -> SessionState:
        # The lead is captured at launch, so it's saved even if the visitor
        # walks away mid-game. Telemetry keeps flowing while this runs.
        if inp.email:
            await workflow.execute_activity(
                save_lead,
                Lead(
                    id=str(workflow.uuid4()),
                    email=inp.email,
                    demo="flight",
                    station=inp.station,
                    consent_text_version=inp.consent_text_version,
                    captured_at=workflow.now().isoformat(),
                    extra=json.dumps({"name": self.s.name, "session_id": inp.session_id}),
                ),
                start_to_close_timeout=timedelta(seconds=10),
            )
        try:
            await workflow.wait_condition(lambda: self._state.status == "finished", timeout=ABANDON_AFTER)
        except asyncio.TimeoutError:
            self._state.status = "abandoned"
        # Let in-flight game activities land before the workflow closes.
        await workflow.wait_condition(lambda: self.pending == 0 and workflow.all_handlers_finished())
        return self._view()

    def _schedule(self, ev: GameEvent) -> None:
        """Start one activity for a game event, without blocking the Update."""
        fn = GAME_ACTIVITIES.get(ev.type)
        if fn is None:
            return
        self.pending += 1
        asyncio.create_task(self._run_game_activity(fn, ev))

    async def _run_game_activity(self, fn, ev: GameEvent) -> None:
        try:
            r: ActivityReceipt = await workflow.execute_activity(
                fn, ev, start_to_close_timeout=timedelta(seconds=5), retry_policy=GAME_ACTIVITY_RETRY
            )
            self.counts[ev.type] = self.counts.get(ev.type, 0) + 1
            if r.attempt > 1:
                self.retries[ev.type] = self.retries.get(ev.type, 0) + r.attempt - 1
        except ActivityError:
            self.failed += 1
        finally:
            self.pending -= 1

    @property
    def _state(self) -> SessionState:
        return self.s

    # ---- telemetry ----
    @workflow.update
    def telemetry(self, t: Telemetry) -> SessionState:
        s = self._state
        if t.seq <= s.seq:  # duplicate/late batch (client retry): ignore
            return self._view()
        s.seq = t.seq
        s.elapsed_ms = min(t.elapsed_ms, s.game_ms)
        s.score = t.score
        s.distance = t.distance
        s.hull = t.hull
        s.broken = list(t.broken)
        s.durable = t.durable
        s.deploys = t.deploys
        s.repairs = t.repairs
        s.damage_taken = t.damage_taken
        s.temporal_charges = t.temporal_charges
        s.next_threshold = t.next_threshold
        s.event_log = (s.event_log + [f"{e.t_ms // 1000:>2}s {e.type}{':' + e.kind if e.kind else ''}" for e in t.events])[-EVENT_LOG_MAX:]
        for ev in t.events:
            self._schedule(ev)
        if s.elapsed_ms >= s.game_ms:
            s.status = "ended"
        return self._view()

    @telemetry.validator
    def _validate_telemetry(self, t: Telemetry) -> None:
        s = self._state
        if s.status not in ("playing",):
            raise ApplicationError(f"game is {s.status}", non_retryable=True)
        if t.seq <= s.seq:
            return
        if len(t.events) > MAX_EVENTS_PER_BATCH:
            raise ApplicationError(f"too many events in one batch ({len(t.events)})", non_retryable=True)
        bad = {e.type for e in t.events} - EVENT_TYPES
        if bad:
            raise ApplicationError(f"unknown event types: {sorted(bad)}", non_retryable=True)
        if t.elapsed_ms < s.elapsed_ms:
            raise ApplicationError("time went backwards", non_retryable=True)
        if t.score < s.score:
            raise ApplicationError("score can only go up", non_retryable=True)
        dt = (t.elapsed_ms - s.elapsed_ms) / 1000
        if t.score - s.score > MAX_POINTS_PER_SEC * dt + SCORE_SLACK:
            raise ApplicationError(
                f"impossible score jump: +{t.score - s.score} in {dt:.1f}s", non_retryable=True
            )

    # ---- finish ----
    @workflow.update
    async def finish(self) -> FinishResult:
        """Post the final score to the booth leaderboard (name was set at launch)."""
        s = self._state
        s.status = "finished"
        res: SubmitResult = await workflow.execute_activity(
            submit_score,
            LeaderboardEntry(
                session_id=s.session_id,
                name=s.name or callsign(s.session_id),
                score=s.score,
                station=s.station,
                deploys=s.deploys,
                at=workflow.now().isoformat(),
            ),
            start_to_close_timeout=timedelta(seconds=15),
        )
        s.rank = res.rank
        return FinishResult(rank=res.rank, score=s.score, name=s.name or "", top=res.top)

    @finish.validator
    def _validate_finish(self) -> None:
        if self._state.status == "finished":
            raise ApplicationError("already finished", non_retryable=True)

    @workflow.query
    def state(self) -> SessionState:
        return self._view()

    @workflow.query
    def summary(self) -> ActivitySummary:
        return ActivitySummary(
            workflow_id=workflow.info().workflow_id,
            history_events=workflow.info().get_current_history_length(),
            total=sum(self.counts.values()),
            pending=self.pending,
            failed=self.failed,
            total_retries=sum(self.retries.values()),
            counts=dict(self.counts),
            retries=dict(self.retries),
        )

    def _view(self) -> SessionState:
        self._state.history_events = workflow.info().get_current_history_length()
        self._state.activities_total = sum(self.counts.values())
        self._state.activities_pending = self.pending
        return self._state


@workflow.defn
class LeaderboardWorkflow:
    """Booth-wide leaderboard shared by every station, one board per event day.

    Days are Las Vegas days starting at `rollover_hour` (computed from
    workflow.now(), so replay is deterministic). When a new day starts, the old
    day's top 3 move to `champions` so day-2 visitors see yesterday's podium.
    """

    @workflow.init
    def __init__(self, inp: LeaderboardInput) -> None:
        self.entries: list[LeaderboardEntry] = list(inp.entries)
        self.total = inp.total_games
        self.seen: list[str] = list(inp.seen)
        self.submissions = 0
        self.max_submissions = inp.max_submissions
        self.current_day = inp.current_day
        self.champions: list[DayPodium] = list(inp.champions)
        self.rollover_hour = inp.rollover_hour
        self.forced_days = inp.day_offset

    @workflow.run
    async def run(self, inp: LeaderboardInput) -> None:
        await workflow.wait_condition(
            lambda: (self.submissions >= self.max_submissions or workflow.info().is_continue_as_new_suggested())
            and workflow.all_handlers_finished()
        )
        workflow.continue_as_new(
            LeaderboardInput(
                entries=self.entries,
                total_games=self.total,
                seen=self.seen[-500:],
                max_submissions=self.max_submissions,
                current_day=self.current_day,
                champions=self.champions,
                rollover_hour=self.rollover_hour,
                day_offset=self.forced_days,
            )
        )

    # ---- day handling ----
    def _today(self) -> str:
        return day_key(workflow.now(), self.rollover_hour)

    def _is_new_day(self) -> bool:
        return bool(self.current_day) and self._today() > self.current_day.split("#")[0]

    def _podium(self) -> DayPodium:
        return DayPodium(day=self.current_day, label=day_label(self.current_day.split("#")[0], len(self.champions) + 1), top=self.entries[:3])

    def _roll_to(self, new_day: str) -> None:
        if self.current_day and self.entries:
            self.champions.append(self._podium())
        self.current_day = new_day
        self.entries = []

    def _ensure_today(self) -> None:
        if not self.current_day:
            self.current_day = self._today()
        elif self._is_new_day():
            self._roll_to(self._today())

    @workflow.update
    def submit(self, e: LeaderboardEntry) -> SubmitResult:
        self._ensure_today()
        if e.session_id not in self.seen:
            self.seen.append(e.session_id)
            self.total += 1
            self.submissions += 1
            self.entries.append(e)
            # Higher score first; on a tie, whoever set it first ranks higher.
            self.entries.sort(key=lambda x: (-x.score, x.at))
            self.entries = self.entries[:TOP_N]
        rank = next((i + 1 for i, x in enumerate(self.entries) if x.session_id == e.session_id), None)
        return SubmitResult(rank=rank, top=list(self.entries))

    @workflow.update
    def start_new_day(self) -> LeaderboardView:
        """Staff override (future admin-panel button): archive today's podium now."""
        self._ensure_today()
        self.forced_days += 1
        self._roll_to(f"{self._today()}#{self.forced_days}")
        return self.top()

    @workflow.query
    def top(self) -> LeaderboardView:
        # Queries can't change state, so if the day rolled over and nobody has
        # played yet, present yesterday as a podium without mutating anything.
        if self._is_new_day():
            champs = self.champions + ([self._podium()] if self.entries else [])
            today = self._today()
            return LeaderboardView(entries=[], total_games=self.total, day=today, day_label=day_label(today, len(champs) + 1), champions=champs)
        day = self.current_day or self._today()
        return LeaderboardView(
            entries=list(self.entries), total_games=self.total, day=day,
            day_label=day_label(day.split("#")[0], len(self.champions) + 1), champions=list(self.champions),
        )
