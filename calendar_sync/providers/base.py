"""Abstract base class for calendar providers."""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime
from typing import Optional

from ..models import CalendarEvent


class CalendarProvider(ABC):
    """Abstract base for all calendar provider integrations."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Provider identifier (e.g. 'google', 'outlook')."""

    @abstractmethod
    def list_calendars(self) -> list[dict]:
        """Return a list of available calendars as dicts with 'id' and 'name'."""

    @abstractmethod
    def get_events(
        self,
        calendar_id: str,
        start: datetime,
        end: datetime,
    ) -> list[CalendarEvent]:
        """Fetch events from a calendar within the given date range."""

    @abstractmethod
    def create_event(self, calendar_id: str, event: CalendarEvent) -> CalendarEvent:
        """Create a new event and return it with the provider-assigned ID."""

    @abstractmethod
    def update_event(self, calendar_id: str, event: CalendarEvent) -> CalendarEvent:
        """Update an existing event in place."""

    @abstractmethod
    def delete_event(self, calendar_id: str, provider_id: str) -> None:
        """Delete an event by its provider-specific ID."""

    def find_event_by_uid(
        self, calendar_id: str, uid: str, start: datetime, end: datetime
    ) -> Optional[CalendarEvent]:
        """Find an event by its UID. Default implementation scans all events."""
        for event in self.get_events(calendar_id, start, end):
            if event.uid == uid:
                return event
        return None
