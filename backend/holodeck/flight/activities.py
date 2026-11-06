"""Flight Deck activities.

Every game action is an activity: the browser batches events into the
per-second telemetry Update and the session workflow schedules one activity
per event. They are deliberately tiny and fast; occasionally one fails its
first attempt (FLIGHT_CHAOS_RATE) so the summary can show real retries.
"""

from __future__ import annotations

import os
import random

from temporalio import activity
from temporalio.client import WithStartWorkflowOperation
from temporalio.common import WorkflowIDConflictPolicy

from ..config import settings
from ..temporal_client import get_client
from .models import ActivityReceipt, GameEvent, LeaderboardEntry, LeaderboardInput, SubmitResult

LEADERBOARD_ID = f"{settings.task_queue}-leaderboard"


class ShipComputerGlitch(RuntimeError):
    pass


def chaos_rate() -> float:
    # Low on purpose: a busy game schedules hundreds of these.
    return float(os.getenv("HOLODECK_FLIGHT_CHAOS_RATE", "0.04"))


def _record(ev: GameEvent) -> ActivityReceipt:
    info = activity.info()
    if info.attempt == 1 and random.random() < chaos_rate():
        raise ShipComputerGlitch(f"{info.activity_type}: ship computer glitch (simulated), retrying")
    return ActivityReceipt(type=ev.type, attempt=info.attempt)


@activity.defn
async def record_collision(ev: GameEvent) -> ActivityReceipt:
    return _record(ev)


@activity.defn
async def record_system_failure(ev: GameEvent) -> ActivityReceipt:
    return _record(ev)


@activity.defn
async def repair_tap(ev: GameEvent) -> ActivityReceipt:
    return _record(ev)


@activity.defn
async def fire_blaster(ev: GameEvent) -> ActivityReceipt:
    return _record(ev)


@activity.defn
async def destroy_obstacle(ev: GameEvent) -> ActivityReceipt:
    return _record(ev)


@activity.defn
async def destroy_enemy(ev: GameEvent) -> ActivityReceipt:
    return _record(ev)


@activity.defn
async def award_temporal_charge(ev: GameEvent) -> ActivityReceipt:
    return _record(ev)


@activity.defn
async def deploy_temporal(ev: GameEvent) -> ActivityReceipt:
    return _record(ev)


GAME_ACTIVITIES = {
    "collision": record_collision,
    "system_failure": record_system_failure,
    "repair_tap": repair_tap,
    "fire_blaster": fire_blaster,
    "destroy_obstacle": destroy_obstacle,
    "destroy_enemy": destroy_enemy,
    "temporal_charge": award_temporal_charge,
    "deploy_temporal": deploy_temporal,
}


@activity.defn
async def submit_score(entry: LeaderboardEntry) -> SubmitResult:
    """Update-with-start on the leaderboard entity workflow.

    Creates the leaderboard the first time; the workflow dedupes on
    session_id, so retries of this activity are safe.
    """
    from .workflows import LeaderboardWorkflow

    client = await get_client()
    start_op = WithStartWorkflowOperation(
        LeaderboardWorkflow.run,
        # Staff can move the day boundary (local Las Vegas hour) before the show.
        LeaderboardInput(rollover_hour=int(os.getenv("HOLODECK_FLIGHT_DAY_ROLLOVER_HOUR", "4"))),
        id=LEADERBOARD_ID,
        task_queue=settings.task_queue,
        id_conflict_policy=WorkflowIDConflictPolicy.USE_EXISTING,
    )
    return await client.execute_update_with_start_workflow(
        LeaderboardWorkflow.submit, entry, start_workflow_operation=start_op
    )
