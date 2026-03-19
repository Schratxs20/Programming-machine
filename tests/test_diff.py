"""Tests for event diff computation."""

import pytest
from datetime import datetime, timezone
from calendar_sync.models import CalendarEvent
from calendar_sync.sync.diff import compute_diff, ChangeType


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


class TestComputeDiff:
    def test_create_when_source_not_in_target(self):
        source = [make_event("uid-1")]
        target = []
        changes = compute_diff(source, target)
        assert len(changes) == 1
        assert changes[0].change_type == ChangeType.CREATE
        assert changes[0].source_event.uid == "uid-1"

    def test_delete_when_target_not_in_source(self):
        source = []
        target = [make_event("uid-1")]
        changes = compute_diff(source, target)
        assert len(changes) == 1
        assert changes[0].change_type == ChangeType.DELETE
        assert changes[0].target_event.uid == "uid-1"

    def test_no_change_when_events_identical(self):
        event = make_event("uid-1", title="Same title")
        source = [event]
        target = [make_event("uid-1", title="Same title")]
        changes = compute_diff(source, target)
        assert len(changes) == 1
        assert changes[0].change_type == ChangeType.NONE

    def test_update_when_events_differ(self):
        source = [make_event("uid-1", title="Updated title")]
        target = [make_event("uid-1", title="Original title")]
        changes = compute_diff(source, target)
        assert len(changes) == 1
        assert changes[0].change_type == ChangeType.UPDATE
        assert changes[0].source_event.title == "Updated title"
        assert changes[0].target_event.title == "Original title"

    def test_multiple_changes_mixed(self):
        source = [
            make_event("uid-1", title="Unchanged"),
            make_event("uid-2", title="Changed"),
            make_event("uid-3", title="New event"),
        ]
        target = [
            make_event("uid-1", title="Unchanged"),
            make_event("uid-2", title="Old"),
            make_event("uid-4", title="To be deleted"),
        ]
        changes = compute_diff(source, target)
        by_type = {c.change_type: c for c in changes if c.change_type != ChangeType.NONE}
        none_count = sum(1 for c in changes if c.change_type == ChangeType.NONE)

        assert none_count == 1  # uid-1
        assert ChangeType.CREATE in by_type
        assert ChangeType.UPDATE in by_type
        assert ChangeType.DELETE in by_type

    def test_empty_both_sides(self):
        changes = compute_diff([], [])
        assert changes == []
