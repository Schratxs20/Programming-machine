"""Tests for the unified event model."""

import pytest
from datetime import datetime, timezone
from calendar_sync.models import CalendarEvent, Attendee, SyncResult


def make_event(**kwargs) -> CalendarEvent:
    defaults = dict(
        uid="test-uid-123",
        title="Team Standup",
        start=datetime(2026, 3, 19, 9, 0, tzinfo=timezone.utc),
        end=datetime(2026, 3, 19, 9, 30, tzinfo=timezone.utc),
        provider="google",
        calendar_id="primary",
        provider_id="google-event-abc",
    )
    defaults.update(kwargs)
    return CalendarEvent(**defaults)


class TestCalendarEvent:
    def test_basic_creation(self):
        event = make_event()
        assert event.uid == "test-uid-123"
        assert event.title == "Team Standup"
        assert event.provider == "google"

    def test_content_hash_is_stable(self):
        event = make_event()
        assert event.content_hash() == event.content_hash()

    def test_content_hash_changes_with_title(self):
        event1 = make_event(title="Meeting A")
        event2 = make_event(title="Meeting B")
        assert event1.content_hash() != event2.content_hash()

    def test_content_hash_changes_with_time(self):
        event1 = make_event(start=datetime(2026, 3, 19, 9, 0, tzinfo=timezone.utc))
        event2 = make_event(start=datetime(2026, 3, 19, 10, 0, tzinfo=timezone.utc))
        assert event1.content_hash() != event2.content_hash()

    def test_content_hash_ignores_provider_id(self):
        event1 = make_event(provider_id="google-abc")
        event2 = make_event(provider_id="outlook-xyz")
        assert event1.content_hash() == event2.content_hash()

    def test_to_dict_includes_required_fields(self):
        event = make_event()
        d = event.to_dict()
        assert d["uid"] == "test-uid-123"
        assert d["title"] == "Team Standup"
        assert "start" in d
        assert "end" in d

    def test_default_status_is_confirmed(self):
        event = make_event()
        assert event.status == "confirmed"

    def test_attendees_default_empty(self):
        event = make_event()
        assert event.attendees == []

    def test_with_attendees(self):
        attendees = [
            Attendee(email="alice@example.com", display_name="Alice", response_status="accepted"),
            Attendee(email="bob@example.com", response_status="needsAction"),
        ]
        event = make_event(attendees=attendees)
        assert len(event.attendees) == 2
        assert event.attendees[0].email == "alice@example.com"


class TestSyncResult:
    def test_total_changes(self):
        result = SyncResult(rule_name="test", created=3, updated=2, deleted=1)
        assert result.total_changes == 6

    def test_str_representation(self):
        result = SyncResult(rule_name="my-rule", created=1, updated=0, deleted=0, skipped=5)
        s = str(result)
        assert "my-rule" in s
        assert "created=1" in s

    def test_errors_default_empty(self):
        result = SyncResult(rule_name="test")
        assert result.errors == []
