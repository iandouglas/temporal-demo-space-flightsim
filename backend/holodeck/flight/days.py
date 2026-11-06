"""Event-day keys for the multi-day leaderboard (Las Vegas time)."""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

LAS_VEGAS = ZoneInfo("America/Los_Angeles")


def day_key(now: datetime, rollover_hour: int = 4) -> str:
    """YYYY-MM-DD of the event day `now` falls in.

    A day runs from `rollover_hour` local time to the same hour the next day,
    so a 1am after-party score still counts for the evening before.
    """
    local = now.astimezone(LAS_VEGAS) - timedelta(hours=rollover_hour)
    return local.date().isoformat()


def day_label(key: str, day_number: int) -> str:
    d = datetime.fromisoformat(key)
    return f"Day {day_number} · {d.strftime('%a %b')} {d.day}"
