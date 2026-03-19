"""iCalendar URL feed provider (read-only)."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, date, timezone
from typing import Optional

import requests

from ..models import CalendarEvent
from .base import CalendarProvider

logger = logging.getLogger(__name__)


class ICalProvider(CalendarProvider):
    """Read-only provider for iCalendar (.ics) URL feeds."""

    def __init__(self, feeds: list[dict]):
        self._feeds = {f["name"]: f["url"] for f in feeds}

    @property
    def name(self) -> str:
        return "ical"

    def list_calendars(self) -> list[dict]:
        return [{"id": name, "name": name} for name in self._feeds]

    def get_events(self, calendar_id: str, start: datetime, end: datetime) -> list[CalendarEvent]:
        if calendar_id not in self._feeds:
            raise ValueError(f"Unknown iCal feed: {calendar_id}")

        url = self._feeds[calendar_id]
        try:
            resp = requests.get(url, timeout=30)
            resp.raise_for_status()
            ical_data = resp.content
        except Exception as e:
            logger.error("Failed to fetch iCal feed %s: %s", url, e)
            return []

        return self._parse_ical(ical_data, calendar_id, start, end)

    def _parse_ical(self, data: bytes, calendar_id: str, start: datetime, end: datetime) -> list[CalendarEvent]:
        try:
            from icalendar import Calendar as ICalendar
            import recurring_ical_events
        except ImportError as e:
            raise RuntimeError(
                "icalendar and recurring-ical-events required. Run: pip install icalendar recurring-ical-events"
            ) from e

        try:
            cal = ICalendar.from_ical(data)
        except Exception as e:
            logger.error("Failed to parse iCal data: %s", e)
            return []

        components = recurring_ical_events.of(cal).between(start, end)
        events = []
        for component in components:
            if component.name != "VEVENT":
                continue
            try:
                uid = str(component.get("uid", uuid.uuid4()))
                title = str(component.get("summary", "(No title)"))
                description = str(component.get("description", "")) or None
                location = str(component.get("location", "")) or None

                dtstart = component.get("dtstart").dt
                dtend = component.get("dtend").dt if component.get("dtend") else None
                if dtend is None:
                    from datetime import timedelta
                    dtend = dtstart + (timedelta(days=1) if isinstance(dtstart, date) else timedelta(hours=1))

                all_day = isinstance(dtstart, date) and not isinstance(dtstart, datetime)

                events.append(CalendarEvent(
                    uid=uid,
                    title=title,
                    start=dtstart,
                    end=dtend,
                    provider=self.name,
                    calendar_id=calendar_id,
                    provider_id=uid,
                    description=description,
                    location=location,
                    all_day=all_day,
                ))
            except Exception as e:
                logger.warning("Error parsing VEVENT: %s", e)

        return events

    def create_event(self, calendar_id: str, event: CalendarEvent) -> CalendarEvent:
        raise NotImplementedError("iCal URL feeds are read-only")

    def update_event(self, calendar_id: str, event: CalendarEvent) -> CalendarEvent:
        raise NotImplementedError("iCal URL feeds are read-only")

    def delete_event(self, calendar_id: str, provider_id: str) -> None:
        raise NotImplementedError("iCal URL feeds are read-only")
