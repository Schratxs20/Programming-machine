"""Tests for the sync engine."""

from __future__ import annotations

import pytest
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

from calendar_sync.models import CalendarEvent
from calendar_sync.config import SyncRule
from calendar_sync.sync.engine import SyncEngine
from calendar_sync.providers.base import CalendarProvider


def make_event(uid: str, title: str = "Test Event", provider: str = "google") -> CalendarEvent:
    return CalendarEvent(
        uid=uid,
        title=title,
        start=datetime(2026, 3, 19, 9, 0, tzinfo=timezone.utc),
        end=datetime(2026, 3, 19, 9, 30, tzinfo=timezone.utc),
        provider=provider,
        calendar_id="primary",
        provider_id=f"{provider}-{uid}",
    )


class FakeProvider(CalendarProvider):
    def __init__(self, name_: str, events: list[CalendarEvent]):
        self._name = name_
        self._events = list(events)
        self.created = []
        self.updated = []
        self.deleted = []

    @property
    def name(self) -> str:
        return self._name

    def list_calendars(self):
        return [{"id": "primary", "name": "Primary"}]

    def get_events(self, calendar_id, start, end):
        return list(self._events)

    def create_event(self, calendar_id, event):
        self.created.append(event)
        event.provider_id = f"{self._name}-new-{event.uid}"
        return event

    def update_event(self, calendar_id, event):
        self.updated.append(event)
        return event

    def delete_event(self, calendar_id, provider_id):
        self.deleted.append(provider_id)


def make_rule(**kwargs) -> SyncRule:
    defaults = dict(
        name="test-rule",
        source="src:primary",
        target="tgt:primary",
        direction="source_to_target",
        lookback_days=7,
        lookahead_days=90,
        conflict_strategy="newer_wins",
    )
    defaults.update(kwargs)
    return SyncRule(**defaults)


class TestSyncEngine:
    def _make_engine(self, src_events, tgt_events, dry_run=False):
        src = FakeProvider("src", src_events)
        tgt = FakeProvider("tgt", tgt_events)
        engine = SyncEngine(
            providers={"src": src, "tgt": tgt},
            state_file="/tmp/test_state.json",
            dry_run=dry_run,
        )
        return engine, src, tgt

    def test_creates_new_event_in_target(self):
        src_event = make_event("uid-1")
        engine, src, tgt = self._make_engine([src_event], [])

        result = engine.sync_rule(make_rule())

        assert result.created == 1
        assert result.updated == 0
        assert result.deleted == 0
        assert len(tgt.created) == 1
        assert tgt.created[0].uid == "uid-1"

    def test_updates_changed_event_in_target(self):
        src_event = make_event("uid-1", title="New Title")
        tgt_event = make_event("uid-1", title="Old Title")
        tgt_event.provider = "tgt"
        engine, src, tgt = self._make_engine([src_event], [tgt_event])

        result = engine.sync_rule(make_rule())

        assert result.updated == 1
        assert len(tgt.updated) == 1

    def test_deletes_removed_event_from_target(self):
        tgt_event = make_event("uid-1", provider="tgt")
        engine, src, tgt = self._make_engine([], [tgt_event])

        result = engine.sync_rule(make_rule())

        assert result.deleted == 1
        assert len(tgt.deleted) == 1

    def test_skips_unchanged_events(self):
        event = make_event("uid-1", title="Same")
        tgt_event = make_event("uid-1", title="Same")
        tgt_event.provider = "tgt"
        engine, src, tgt = self._make_engine([event], [tgt_event])

        result = engine.sync_rule(make_rule())

        assert result.skipped == 1
        assert result.created == 0
        assert result.updated == 0

    def test_dry_run_does_not_modify_target(self):
        src_event = make_event("uid-1")
        engine, src, tgt = self._make_engine([src_event], [], dry_run=True)

        result = engine.sync_rule(make_rule())

        assert result.created == 1
        assert len(tgt.created) == 0  # No actual changes

    def test_missing_provider_returns_error(self):
        engine = SyncEngine(providers={}, state_file="/tmp/test_state.json")
        result = engine.sync_rule(make_rule())
        assert len(result.errors) > 0

    def test_bidirectional_sync(self):
        src_event = make_event("uid-1", title="From source")
        tgt_event = make_event("uid-2", title="From target", provider="tgt")
        engine, src, tgt = self._make_engine([src_event], [tgt_event])

        rule = make_rule(direction="bidirectional")
        result = engine.sync_rule(rule)

        # source→target creates uid-1, target→source creates uid-2
        assert result.created == 2
