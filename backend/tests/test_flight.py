"""Flight Deck workflow tests against a local Temporal dev server."""

from __future__ import annotations

import asyncio
import uuid

import pytest
from temporalio.client import WorkflowUpdateFailedError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from holodeck import temporal_client
from holodeck.config import settings
from holodeck.flight.activities import GAME_ACTIVITIES, submit_score
from holodeck.flight.models import GameEvent, LeaderboardEntry, LeaderboardInput, SessionInput, Telemetry
from datetime import datetime, timezone

from holodeck.flight.days import day_key, day_label
from holodeck.flight.names import callsign, display_name, is_offensive
from holodeck.flight.workflows import FlightSessionWorkflow, LeaderboardWorkflow
from holodeck.shared.leads import Lead, save_lead


@pytest.fixture(scope="module")
async def env():
    async with await WorkflowEnvironment.start_local() as env:
        yield env


@pytest.fixture
async def worker(env):
    temporal_client._client = env.client  # activities use the shared client
    async with Worker(
        env.client,
        task_queue=settings.task_queue,
        workflows=[FlightSessionWorkflow, LeaderboardWorkflow],
        activities=[submit_score, save_lead, *GAME_ACTIVITIES.values()],
    ):
        yield env.client


def tel(seq: int, ms: int, score: int, **kw) -> Telemetry:
    return Telemetry(seq=seq, elapsed_ms=ms, score=score, **kw)


async def start_session(client, game_ms=90_000, email="pilot@example.com"):
    sid = uuid.uuid4().hex[:8]
    return await client.start_workflow(
        FlightSessionWorkflow.run,
        SessionInput(session_id=sid, station="test", game_ms=game_ms, email=email, consent_text_version="v1"),
        id=f"test-flight-{sid}",
        task_queue=settings.task_queue,
    )


async def test_session_lifecycle_and_resume_state(worker):
    h = await start_session(worker)
    st = await h.execute_update(FlightSessionWorkflow.telemetry, tel(1, 1000, 300, hull=90, broken=["shields"], events=[GameEvent("collision", 900, "asteroid", 11)]))
    assert st.score == 300 and st.broken == ["shields"]
    # Duplicate batch (client retry) is ignored, not applied twice.
    st = await h.execute_update(FlightSessionWorkflow.telemetry, tel(1, 1000, 300))
    assert st.seq == 1
    await h.execute_update(FlightSessionWorkflow.telemetry, tel(2, 2000, 650, hull=90, deploys=1))

    # A "reloaded browser" only needs the query to resume.
    q = await h.query(FlightSessionWorkflow.state)
    assert (q.status, q.score, q.elapsed_ms, q.deploys, q.hull) == ("playing", 650, 2000, 1, 90)
    assert any("collision:asteroid" in e for e in q.event_log)

    res = await h.execute_update(FlightSessionWorkflow.finish)
    assert res.score == 650 and res.rank is not None
    final = await h.result()
    assert final.status == "finished" and final.name == "pilot"  # email username from launch


async def test_telemetry_rejects_impossible_scores(worker):
    h = await start_session(worker)
    await h.execute_update(FlightSessionWorkflow.telemetry, tel(1, 1000, 300))
    with pytest.raises(WorkflowUpdateFailedError):
        await h.execute_update(FlightSessionWorkflow.telemetry, tel(2, 2000, 90_000))
    with pytest.raises(WorkflowUpdateFailedError):
        await h.execute_update(FlightSessionWorkflow.telemetry, tel(3, 500, 400))  # time backwards
    with pytest.raises(WorkflowUpdateFailedError):
        await h.execute_update(FlightSessionWorkflow.telemetry, tel(4, 1500, 100))  # score went down
    st = await h.query(FlightSessionWorkflow.state)
    assert st.score == 300  # rejected updates never touched state
    await h.terminate()


async def test_game_end_blocks_further_telemetry(worker):
    h = await start_session(worker, game_ms=5_000)
    st = await h.execute_update(FlightSessionWorkflow.telemetry, tel(1, 5_200, 900))
    assert st.status == "ended" and st.elapsed_ms == 5_000
    with pytest.raises(WorkflowUpdateFailedError):
        await h.execute_update(FlightSessionWorkflow.telemetry, tel(2, 5_300, 900))
    await h.terminate()


async def test_leaderboard_orders_truncates_and_dedupes(worker):
    lb = await worker.start_workflow(
        LeaderboardWorkflow.run, LeaderboardInput(), id=f"test-lb-{uuid.uuid4().hex[:6]}", task_queue=settings.task_queue
    )
    for i in range(12):
        await lb.execute_update(LeaderboardWorkflow.submit, LeaderboardEntry(session_id=f"s{i}", name="AAA", score=i * 1000, station="t"))
    res = await lb.execute_update(LeaderboardWorkflow.submit, LeaderboardEntry(session_id="s11", name="AAA", score=11_000, station="t"))
    assert res.rank == 1  # resubmission is idempotent
    view = await lb.query(LeaderboardWorkflow.top)
    assert [e.score for e in view.entries] == [i * 1000 for i in range(11, 1, -1)]
    assert view.total_games == 12
    low = await lb.execute_update(LeaderboardWorkflow.submit, LeaderboardEntry(session_id="low", name="ZZZ", score=5, station="t"))
    assert low.rank is None and len(low.top) == 10
    await lb.terminate()


async def test_leaderboard_continue_as_new_keeps_state(worker):
    wid = f"test-lb-can-{uuid.uuid4().hex[:6]}"
    lb = await worker.start_workflow(LeaderboardWorkflow.run, LeaderboardInput(max_submissions=2), id=wid, task_queue=settings.task_queue)
    first_run = lb.result_run_id
    for i in range(5):
        await worker.get_workflow_handle(wid).execute_update(
            LeaderboardWorkflow.submit, LeaderboardEntry(session_id=f"c{i}", name="CAN", score=100 + i, station="t")
        )
    h = worker.get_workflow_handle(wid)
    desc = await h.describe()
    assert desc.run_id != first_run  # continued as new at least once
    view = await h.query(LeaderboardWorkflow.top)
    assert view.total_games == 5 and view.entries[0].score == 104
    await h.terminate()


async def wait_summary(h, total: int):
    """Poll the summary query until the background activities have landed."""
    for _ in range(100):
        sm = await h.query(FlightSessionWorkflow.summary)
        if sm.pending == 0 and sm.total >= total:
            return sm
        await asyncio.sleep(0.1)
    raise AssertionError(f"activities did not finish: {sm}")


async def test_one_activity_per_event_and_summary(worker, monkeypatch):
    monkeypatch.setenv("HOLODECK_FLIGHT_CHAOS_RATE", "0")
    h = await start_session(worker)
    batch1 = [
        GameEvent("collision", 100, "asteroid", 11),
        GameEvent("system_failure", 110, "shields"),
        GameEvent("fire_blaster", 200),
        GameEvent("fire_blaster", 300),
        GameEvent("destroy_obstacle", 320, "asteroid", 50),
        GameEvent("sector", 400, "ion"),  # logged, no activity
    ]
    batch2 = [
        GameEvent("repair_tap", 1100, "shields", 1),
        GameEvent("repair_tap", 1200, "shields", 2),
        GameEvent("destroy_enemy", 1300, "fighter", 500),
        GameEvent("temporal_charge", 1400),
        GameEvent("deploy_temporal", 1500),
    ]
    st = await h.execute_update(FlightSessionWorkflow.telemetry, tel(1, 1000, 300, events=batch1))
    assert st.seq == 1  # the Update returns without waiting for the activities
    await h.execute_update(FlightSessionWorkflow.telemetry, tel(2, 2000, 700, events=batch2))
    # A retried (duplicate) batch must not schedule its activities twice.
    await h.execute_update(FlightSessionWorkflow.telemetry, tel(2, 2000, 700, events=batch2))

    sm = await wait_summary(h, 10)
    assert sm.total == 10 and sm.failed == 0 and sm.total_retries == 0
    assert sm.counts == {
        "collision": 1, "system_failure": 1, "fire_blaster": 2, "destroy_obstacle": 1,
        "repair_tap": 2, "destroy_enemy": 1, "temporal_charge": 1, "deploy_temporal": 1,
    }
    assert sm.workflow_id == h.id and sm.history_events > 30

    # Each activity type really ran as its own activity in history.
    names = [
        e.activity_task_scheduled_event_attributes.activity_type.name
        async for e in h.fetch_history_events()
        if e.HasField("activity_task_scheduled_event_attributes")
    ]
    assert names.count("fire_blaster") == 2 and names.count("repair_tap") == 2
    assert {"record_collision", "record_system_failure", "destroy_enemy", "award_temporal_charge", "deploy_temporal"} <= set(names)

    res = await h.execute_update(FlightSessionWorkflow.finish)
    assert res.score == 700
    final = await h.result()
    assert final.activities_total == 10 and final.activities_pending == 0


async def test_retries_are_counted(worker, monkeypatch):
    monkeypatch.setenv("HOLODECK_FLIGHT_CHAOS_RATE", "1")  # every first attempt fails
    h = await start_session(worker)
    await h.execute_update(
        FlightSessionWorkflow.telemetry,
        tel(1, 1000, 300, events=[GameEvent("fire_blaster", 10), GameEvent("fire_blaster", 20), GameEvent("collision", 30, "mine", 20)]),
    )
    sm = await wait_summary(h, 3)
    assert sm.total == 3 and sm.total_retries == 3
    assert sm.retries == {"fire_blaster": 2, "collision": 1}
    await h.terminate()


async def test_rejects_unknown_or_flooded_events(worker):
    h = await start_session(worker)
    with pytest.raises(WorkflowUpdateFailedError):
        await h.execute_update(FlightSessionWorkflow.telemetry, tel(1, 1000, 100, events=[GameEvent("hack_score")]))
    with pytest.raises(WorkflowUpdateFailedError):
        await h.execute_update(FlightSessionWorkflow.telemetry, tel(1, 1000, 100, events=[GameEvent("fire_blaster")] * 500))
    sm = await h.query(FlightSessionWorkflow.summary)
    assert sm.total == 0 and sm.pending == 0
    await h.terminate()


def entry(sid: str, score: int, at: str, name: str = "PIL") -> LeaderboardEntry:
    return LeaderboardEntry(session_id=sid, name=name, score=score, station="t", at=at)


async def start_board(client, **kw):
    return await client.start_workflow(
        LeaderboardWorkflow.run, LeaderboardInput(**kw), id=f"test-lb-{uuid.uuid4().hex[:6]}", task_queue=settings.task_queue
    )


async def test_ties_go_to_whoever_scored_first(worker):
    lb = await start_board(worker)
    # Submitted out of time order, with names that would sort the other way alphabetically.
    await lb.execute_update(LeaderboardWorkflow.submit, entry("late", 5000, "2026-12-01T20:00:05+00:00", "Aaron"))
    await lb.execute_update(LeaderboardWorkflow.submit, entry("early", 5000, "2026-12-01T20:00:01+00:00", "Zed"))
    await lb.execute_update(LeaderboardWorkflow.submit, entry("top", 5001, "2026-12-01T20:00:09+00:00", "Mia"))
    view = await lb.query(LeaderboardWorkflow.top)
    assert [e.session_id for e in view.entries] == ["top", "early", "late"]
    await lb.terminate()


async def test_new_day_keeps_previous_top3_and_survives_continue_as_new(worker):
    lb = await start_board(worker, max_submissions=3)
    wid = lb.id
    for i, sc in enumerate([900, 4000, 2500, 7000, 100]):
        await worker.get_workflow_handle(wid).execute_update(LeaderboardWorkflow.submit, entry(f"d1-{i}", sc, f"2026-12-01T20:00:0{i}+00:00"))
    h = worker.get_workflow_handle(wid)
    day1 = (await h.query(LeaderboardWorkflow.top)).day
    # Staff override stands in for the clock passing 4am in Las Vegas.
    view = await h.execute_update(LeaderboardWorkflow.start_new_day)
    assert view.entries == [] and len(view.champions) == 1
    podium = view.champions[0]
    assert podium.day == day1 and podium.label.startswith("Day 1")
    assert [e.score for e in podium.top] == [7000, 4000, 2500]

    # Day 2 plays enough games to force continue-as-new; the podium must survive it.
    for i, sc in enumerate([300, 800, 650, 50]):
        await worker.get_workflow_handle(wid).execute_update(LeaderboardWorkflow.submit, entry(f"d2-{i}", sc, f"2026-12-02T20:00:0{i}+00:00"))
    desc = await h.describe()
    assert desc.run_id != lb.result_run_id  # continued as new
    view = await h.query(LeaderboardWorkflow.top)
    assert [e.score for e in view.champions[0].top] == [7000, 4000, 2500]
    assert [e.score for e in view.entries] == [800, 650, 300, 50]
    assert view.day_label.startswith("Day 2") and view.total_games == 9
    await h.terminate()


def test_day_key_uses_las_vegas_time_and_rollover_hour():
    # 2026-12-02 11:30 UTC = 03:30 PST: still "Dec 1" with a 4am rollover.
    t = datetime(2026, 12, 2, 11, 30, tzinfo=timezone.utc)
    assert day_key(t, rollover_hour=4) == "2026-12-01"
    assert day_key(t, rollover_hour=0) == "2026-12-02"
    assert day_label("2026-12-01", 1) == "Day 1 · Tue Dec 1"


def test_display_name_is_email_username_never_the_address():
    assert display_name("BenJones@temporal.io", "s1") == "BenJones"
    assert display_name("ben.jones+reinvent@temporal.io", "s1") == "ben.jones"
    assert display_name("averyveryverylongusername@x.com", "s1") == "averyveryverylon"  # capped at 16
    assert display_name("sh1thead@x.com", "abc123") == callsign("abc123")  # blocked -> neutral callsign
    assert callsign("abc123").startswith("Pilot-") and callsign("abc123") == callsign("abc123")
    for ok in ["analytics", "Hancock", "Sussex", "document", "Cassandra"]:
        assert not is_offensive(ok), ok


async def test_lead_saved_at_launch_and_name_from_email(worker, monkeypatch):
    saved = []

    from temporalio import activity as act

    @act.defn(name="save_lead")
    async def fake_save_lead(lead: Lead) -> str:
        saved.append(lead)
        return lead.id

    # A private worker on its own queue so we can observe save_lead.
    q = f"lead-{uuid.uuid4().hex[:6]}"
    async with Worker(worker, task_queue=q, workflows=[FlightSessionWorkflow], activities=[fake_save_lead, submit_score, *GAME_ACTIVITIES.values()]):
        h = await worker.start_workflow(
            FlightSessionWorkflow.run,
            SessionInput(session_id="lead1", station="test", email="Ben.Jones+rv@temporal.io", consent_text_version="v1"),
            id=f"test-flight-lead-{uuid.uuid4().hex[:6]}", task_queue=q,
        )
        for _ in range(50):
            if saved:
                break
            await asyncio.sleep(0.1)
        # Saved at launch, before any gameplay or finish.
        assert len(saved) == 1 and saved[0].email == "Ben.Jones+rv@temporal.io" and saved[0].demo == "flight"
        st = await h.query(FlightSessionWorkflow.state)
        assert st.name == "Ben.Jones"
        await h.terminate()


async def test_blocked_username_gets_callsign_on_the_board(worker):
    h = await start_session(worker, email="b1tch@x.com")
    await h.execute_update(FlightSessionWorkflow.telemetry, tel(1, 1000, 321))
    res = await h.execute_update(FlightSessionWorkflow.finish)
    assert res.name.startswith("Pilot-") and all("@" not in e.name for e in res.top)
