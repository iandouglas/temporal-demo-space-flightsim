"""Data types shared by the Flight Deck workflows, activities and API."""

from __future__ import annotations

from dataclasses import dataclass, field

GAME_MS = 90_000
# Upper bound on legit scoring: base rate x best multipliers, plus blaster
# bonuses (an enemy kill is worth a burst of points).
MAX_POINTS_PER_SEC = 3_200
SCORE_SLACK = 4_000
# Cap on events per telemetry batch (one activity is scheduled per event).
MAX_EVENTS_PER_BATCH = 120

SYSTEMS = ["engines", "shields", "navigation", "sensors", "life_support", "cargo"]


@dataclass
class SessionInput:
    session_id: str
    station: str
    game_ms: int = GAME_MS
    # Collected before launch (required): the lead is saved when the game
    # starts, and the leaderboard name is the email's username.
    email: str = ""
    consent_text_version: str = "unknown"


@dataclass
class GameEvent:
    """One thing that happened in the game. Each becomes one activity."""

    type: str  # a key of EVENT_ACTIVITIES, or "sector" (logged only)
    t_ms: int = 0
    kind: str = ""  # obstacle kind, system id, sector id...
    value: float = 0.0  # damage, points, repair progress...


@dataclass
class ActivityReceipt:
    type: str
    attempt: int


@dataclass
class Telemetry:
    seq: int
    elapsed_ms: int
    score: int
    distance: float = 0.0
    hull: float = 100.0
    broken: list[str] = field(default_factory=list)
    durable: bool = False
    deploys: int = 0
    repairs: int = 0
    damage_taken: float = 0.0
    temporal_charges: int = 0
    next_threshold: int = 10_000
    events: list[GameEvent] = field(default_factory=list)


@dataclass
class ActivitySummary:
    """End-of-game payoff: what Temporal did for this flight."""

    workflow_id: str
    history_events: int
    total: int
    pending: int
    failed: int
    total_retries: int
    counts: dict[str, int] = field(default_factory=dict)
    retries: dict[str, int] = field(default_factory=dict)


@dataclass
class SessionState:
    session_id: str
    station: str
    status: str = "playing"  # playing | ended | finished | abandoned
    game_ms: int = GAME_MS
    seq: int = 0
    elapsed_ms: int = 0
    score: int = 0
    distance: float = 0.0
    hull: float = 100.0
    broken: list[str] = field(default_factory=list)
    durable: bool = False
    deploys: int = 0
    repairs: int = 0
    damage_taken: float = 0.0
    temporal_charges: int = 0
    next_threshold: int = 10_000
    event_log: list[str] = field(default_factory=list)
    history_events: int = 0
    activities_total: int = 0
    activities_pending: int = 0
    rank: int | None = None
    name: str | None = None  # leaderboard display name (never the email)


@dataclass
class FinishResult:
    rank: int | None
    score: int
    name: str
    top: list["LeaderboardEntry"]


@dataclass
class LeaderboardEntry:
    session_id: str
    name: str  # email username (or a callsign); never the full email
    score: int
    station: str
    deploys: int = 0
    at: str = ""  # ISO time the score was set; earlier wins ties


@dataclass
class DayPodium:
    day: str  # YYYY-MM-DD event day (Las Vegas time)
    label: str  # "Day 1 · Tue Dec 1"
    top: list[LeaderboardEntry] = field(default_factory=list)


@dataclass
class LeaderboardInput:
    entries: list[LeaderboardEntry] = field(default_factory=list)
    total_games: int = 0
    seen: list[str] = field(default_factory=list)
    # Continue-as-new after this many submissions to keep history small.
    max_submissions: int = 250
    current_day: str = ""
    champions: list[DayPodium] = field(default_factory=list)
    # Local hour (Las Vegas) when a new event day starts.
    rollover_hour: int = 4
    day_offset: int = 0  # bumped by the staff "start new day" override


@dataclass
class LeaderboardView:
    entries: list[LeaderboardEntry]
    total_games: int
    day: str = ""
    day_label: str = ""
    champions: list[DayPodium] = field(default_factory=list)


@dataclass
class SubmitResult:
    rank: int | None
    top: list[LeaderboardEntry]
