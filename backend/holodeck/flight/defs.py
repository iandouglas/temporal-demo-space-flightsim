"""Temporal definitions registered by the worker."""

from .activities import GAME_ACTIVITIES, submit_score
from .workflows import FlightSessionWorkflow, LeaderboardWorkflow

WORKFLOWS: list = [FlightSessionWorkflow, LeaderboardWorkflow]
ACTIVITIES: list = [submit_score, *GAME_ACTIVITIES.values()]
