"""Leaderboard display names: the email's username, never the full address.

`BenJones+reinvent@temporal.io` -> `BenJones`. Offensive usernames fall back
to a neutral callsign like `Pilot-4821`. The blocklist is deliberately basic; booth staff
should still glance at the board (see the Flight Deck notes).
"""

from __future__ import annotations

import re

MAX_NAME = 16

# Always-bad fragments, matched anywhere after undoing common l33t swaps.
BAD_SUBSTRINGS = (
    "fuck", "shit", "cunt", "bitch", "nigg", "faggot", "retard", "whore", "slut", "asshole",
    "pussy", "penis", "vagina", "nazi", "hitler", "porn", "jizz", "wank", "twat", "tranny", "kike",
)
# Short words that hide inside real names (analytics, document, Hancock, Sussex),
# so these only match as a whole word/camelCase part.
BAD_WORDS = frozenset({
    "dick", "cock", "sex", "cum", "anal", "arse", "tits", "boob", "boobs", "spic", "chink",
    "gook", "dyke", "fag", "rape", "milf", "kkk", "ass", "butt", "poop", "piss", "crap",
})
_LEET = str.maketrans({"0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i"})


def username_from_email(email: str) -> str:
    """Local part of the email with any +tag removed, cleaned and capped."""
    local = email.strip().split("@", 1)[0].split("+", 1)[0]
    local = re.sub(r"[^A-Za-z0-9._-]", "", local).strip("._-")
    return local[:MAX_NAME]


def is_offensive(name: str) -> bool:
    flat = re.sub(r"[^a-z]", "", name.lower().translate(_LEET))
    if any(bad in flat for bad in BAD_SUBSTRINGS):
        return True
    # Words: split on separators/digits and camelCase ("BigCock_99" -> big, cock).
    words = re.findall(r"[A-Z]?[a-z]+|[A-Z]+(?![a-z])", name.translate(_LEET))
    return any(w.lower() in BAD_WORDS for w in words) or flat in BAD_WORDS


def callsign(seed: str) -> str:
    """Neutral fallback name, stable for a given session id (e.g. "Pilot-4821")."""
    n = sum((i + 1) * ord(c) for i, c in enumerate(seed)) % 9000 + 1000
    return f"Pilot-{n}"


def display_name(email: str, seed: str) -> str:
    """Name to show on the board: the email username, or a callsign if it's blocked/empty."""
    name = username_from_email(email or "")
    return name if name and not is_offensive(name) else callsign(seed)
