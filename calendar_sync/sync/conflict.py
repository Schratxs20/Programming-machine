"""Conflict resolution strategies for calendar sync."""

from __future__ import annotations

from typing import Optional

from ..models import CalendarEvent


class ConflictResolver:
    """Resolves conflicts between source and target events with the same UID."""

    def __init__(self, strategy: str = "newer_wins"):
        self.strategy = strategy

    def resolve(
        self,
        source: CalendarEvent,
        target: CalendarEvent,
    ) -> Optional[CalendarEvent]:
        """Return the event that should be used, or None to skip.

        Returns:
            CalendarEvent: the winning event (from source or target perspective)
            None: skip the conflict (no change applied)
        """
        if self.strategy == "newer_wins":
            return self._newer_wins(source, target)
        elif self.strategy == "source_wins":
            return source
        elif self.strategy == "target_wins":
            return target
        elif self.strategy == "skip":
            return None
        else:
            raise ValueError(f"Unknown conflict strategy: {self.strategy}")

    def _newer_wins(self, source: CalendarEvent, target: CalendarEvent) -> CalendarEvent:
        src_time = source.updated_at or source.created_at
        tgt_time = target.updated_at or target.created_at

        if src_time is None and tgt_time is None:
            return source  # Default to source when no timestamps available

        if src_time is None:
            return target
        if tgt_time is None:
            return source

        return source if src_time >= tgt_time else target
