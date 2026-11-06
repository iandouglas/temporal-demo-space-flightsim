"""HTTP endpoints for the Flight Deck UI."""

from __future__ import annotations

import dataclasses
import re
import uuid

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, field_validator
from temporalio.client import WorkflowUpdateFailedError
from temporalio.common import WorkflowIDReusePolicy
from temporalio.service import RPCError, RPCStatusCode

from ..config import settings
from ..temporal_client import get_client, wf_id
from .activities import LEADERBOARD_ID
from .names import display_name
from .models import GameEvent, Telemetry
from .workflows import FlightSessionWorkflow, LeaderboardWorkflow, SessionInput

router = APIRouter(prefix="/flight", tags=["flight"])


class EventBody(BaseModel):
    type: str
    t_ms: int = 0
    kind: str = ""
    value: float = 0


class TelemetryBody(BaseModel):
    seq: int
    elapsed_ms: int
    score: int
    distance: float = 0
    hull: float = 100
    broken: list[str] = []
    durable: bool = False
    deploys: int = 0
    repairs: int = 0
    damage_taken: float = 0
    temporal_charges: int = 0
    next_threshold: int = 10_000
    events: list[EventBody] = []


class SessionBody(BaseModel):
    # Required: the booth's lead capture happens before launch.
    email: str
    consent_text_version: str = "unknown"

    @field_validator("email")
    @classmethod
    def _looks_like_email(cls, v: str) -> str:
        v = v.strip()
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]{2,}", v):
            raise ValueError("a valid email is required to fly")
        return v


def _station(x_station: str | None) -> str:
    return (x_station or settings.station)[:16]


def _handle(session_id: str, station: str):
    return wf_id("flight", session_id, station)


@router.post("/sessions")
async def create_session(body: SessionBody, x_station: str | None = Header(default=None)) -> dict:
    station = _station(x_station)
    session_id = uuid.uuid4().hex[:10]
    client = await get_client()
    workflow_id = _handle(session_id, station)
    await client.start_workflow(
        FlightSessionWorkflow.run,
        SessionInput(session_id=session_id, station=station, email=body.email, consent_text_version=body.consent_text_version),
        id=workflow_id,
        task_queue=settings.task_queue,
        id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
    )
    return {"session_id": session_id, "workflow_id": workflow_id, "name": display_name(body.email, session_id)}


@router.post("/sessions/{session_id}/telemetry")
async def telemetry(session_id: str, body: TelemetryBody, x_station: str | None = Header(default=None)) -> dict:
    client = await get_client()
    h = client.get_workflow_handle(_handle(session_id, _station(x_station)))
    try:
        data = body.model_dump()
        data["events"] = [GameEvent(**e) for e in data["events"]]
        state = await h.execute_update(FlightSessionWorkflow.telemetry, Telemetry(**data))
    except WorkflowUpdateFailedError as e:
        raise HTTPException(409, str(e.cause or e))
    except RPCError as e:
        raise HTTPException(404 if e.status == RPCStatusCode.NOT_FOUND else 502, e.message)
    return dataclasses.asdict(state)


@router.get("/sessions/{session_id}")
async def get_session(session_id: str, x_station: str | None = Header(default=None)) -> dict:
    client = await get_client()
    h = client.get_workflow_handle(_handle(session_id, _station(x_station)))
    try:
        state = await h.query(FlightSessionWorkflow.state)
    except RPCError as e:
        raise HTTPException(404 if e.status == RPCStatusCode.NOT_FOUND else 502, e.message)
    return {**dataclasses.asdict(state), "workflow_id": h.id}


@router.get("/sessions/{session_id}/summary")
async def get_summary(session_id: str, x_station: str | None = Header(default=None)) -> dict:
    """Activity counts, retries and history size for the end-of-game payoff screen."""
    client = await get_client()
    h = client.get_workflow_handle(_handle(session_id, _station(x_station)))
    try:
        summary = await h.query(FlightSessionWorkflow.summary)
    except RPCError as e:
        raise HTTPException(404 if e.status == RPCStatusCode.NOT_FOUND else 502, e.message)
    return dataclasses.asdict(summary)


@router.post("/sessions/{session_id}/finish")
async def finish(session_id: str, x_station: str | None = Header(default=None)) -> dict:
    client = await get_client()
    h = client.get_workflow_handle(_handle(session_id, _station(x_station)))
    try:
        res = await h.execute_update(FlightSessionWorkflow.finish)
    except WorkflowUpdateFailedError as e:
        raise HTTPException(409, str(e.cause or e))
    except RPCError as e:
        raise HTTPException(404 if e.status == RPCStatusCode.NOT_FOUND else 502, e.message)
    return dataclasses.asdict(res)


@router.post("/leaderboard/new-day")
async def start_new_day() -> dict:
    """Staff override: archive today's podium and start a fresh board now.
    (Candidate for a button in the shared admin panel.)"""
    client = await get_client()
    try:
        view = await client.get_workflow_handle(LEADERBOARD_ID).execute_update(LeaderboardWorkflow.start_new_day)
    except RPCError as e:
        raise HTTPException(404 if e.status == RPCStatusCode.NOT_FOUND else 502, e.message)
    return dataclasses.asdict(view)


@router.get("/leaderboard")
async def leaderboard() -> dict:
    client = await get_client()
    try:
        view = await client.get_workflow_handle(LEADERBOARD_ID).query(LeaderboardWorkflow.top)
    except RPCError as e:
        if e.status == RPCStatusCode.NOT_FOUND:
            return {"entries": [], "total_games": 0, "day": "", "day_label": "", "champions": []}
        raise HTTPException(502, e.message)
    return dataclasses.asdict(view)
