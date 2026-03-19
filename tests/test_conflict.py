"""Tests for conflict resolution strategies."""

import pytest
from datetime import datetime, timezone
from calendar_sync.models import CalendarEvent
from calendar_sync.sync.conflict import ConflictResolver


def make_event(uid: str, updated_at: datetime | None = None) -> CalendarEvent:
    return CalendarEvent(
        uid=uid,
        title="Test Event",
        start=datetime(2026, 3, 19, 9, 0, tzinfo=timezone.utc),
        end=datetime(2026, 3, 19, 9, 30, tzinfo=timezone.utc),
        provider="google",
        calendar_id="primary",
        provider_id=f"google-{uid}",
        updated_at=updated_at,
    )


OLDER = datetime(2026, 3, 1, 0, 0, tzinfo=timezone.utc)
NEWER = datetime(2026, 3, 19, 0, 0, tzinfo=timezone.utc)


class TestConflictResolver:
    def test_newer_wins_returns_newer_source(self):
        resolver = ConflictResolver("newer_wins")
        source = make_event("uid-1", updated_at=NEWER)
        target = make_event("uid-1", updated_at=OLDER)
        winner = resolver.resolve(source, target)
        assert winner is source

    def test_newer_wins_returns_newer_target(self):
        resolver = ConflictResolver("newer_wins")
        source = make_event("uid-1", updated_at=OLDER)
        target = make_event("uid-1", updated_at=NEWER)
        winner = resolver.resolve(source, target)
        assert winner is target

    def test_source_wins_always_returns_source(self):
        resolver = ConflictResolver("source_wins")
        source = make_event("uid-1", updated_at=OLDER)
        target = make_event("uid-1", updated_at=NEWER)
        winner = resolver.resolve(source, target)
        assert winner is source

    def test_target_wins_always_returns_target(self):
        resolver = ConflictResolver("target_wins")
        source = make_event("uid-1", updated_at=NEWER)
        target = make_event("uid-1", updated_at=OLDER)
        winner = resolver.resolve(source, target)
        assert winner is target

    def test_skip_returns_none(self):
        resolver = ConflictResolver("skip")
        source = make_event("uid-1")
        target = make_event("uid-1")
        assert resolver.resolve(source, target) is None

    def test_newer_wins_defaults_to_source_when_no_timestamps(self):
        resolver = ConflictResolver("newer_wins")
        source = make_event("uid-1", updated_at=None)
        target = make_event("uid-1", updated_at=None)
        winner = resolver.resolve(source, target)
        assert winner is source

    def test_invalid_strategy_raises(self):
        resolver = ConflictResolver("invalid_strategy")
        source = make_event("uid-1")
        target = make_event("uid-1")
        with pytest.raises(ValueError):
            resolver.resolve(source, target)
