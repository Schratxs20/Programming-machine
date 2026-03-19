"""CalDAV calendar provider."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, date, timezone
from typing import Optional

from ..models import CalendarEvent, Attendee
from .base import CalendarProvider

logger = logging.getLogger(__name__)


class CalDAVProvider(CalendarProvider):
    """Integrates with CalDAV servers (Nextcloud, iCloud, Fastmail, etc.)."""

    def __init__(self, url: str, username: str, password: str, calendar_paths: list[str] = None):
        self.url = url
        self.username = username
        self.password = password
        self.calendar_paths = calendar_paths or []
        self._client = None

    @property
    def name(self) -> str:
        return "caldav"

    def _get_client(self):
        if self._client is not None:
            return self._client
        try:
            import caldav
        except ImportError as e:
            raise RuntimeError("caldav not installed. Run: pip install caldav") from e

        self._client = caldav.DAVClient(url=self.url, username=self.username, password=self.password)
        return self._client

    def _get_calendar(self, calendar_id: str):
        client = self._get_client()
        import caldav
        return caldav.Calendar(client=client, url=calendar_id)

    def list_calendars(self) -> list[dict]:
        client = self._get_client()
        principal = client.principal()
        calendars = principal.calendars()
        return [{"id": str(cal.url), "name": cal.name or str(cal.url)} for cal in calendars]

    def get_events(self, calendar_id: str, start: datetime, end: datetime) -> list[CalendarEvent]:
        calendar = self._get_calendar(calendar_id)
        cal_events = calendar.date_search(start=start, end=end, expand=True)

        events = []
        for cal_event in cal_events:
            try:
                events.extend(self._parse_vevent(cal_event, calendar_id))
            except Exception as e:
                logger.warning("Failed to parse CalDAV event: %s", e)
        return events

    def create_event(self, calendar_id: str, event: CalendarEvent) -> CalendarEvent:
        calendar = self._get_calendar(calendar_id)
        ical_str = self._to_ical(event)
        result = calendar.save_event(ical_str)
        event.provider_id = str(result.url)
        event.provider = self.name
        event.calendar_id = calendar_id
        return event

    def update_event(self, calendar_id: str, event: CalendarEvent) -> CalendarEvent:
        client = self._get_client()
        import caldav
        cal_event = caldav.Event(client=client, url=event.provider_id)
        cal_event.data = self._to_ical(event)
        cal_event.save()
        return event

    def delete_event(self, calendar_id: str, provider_id: str) -> None:
        client = self._get_client()
        import caldav
        cal_event = caldav.Event(client=client, url=provider_id)
        cal_event.delete()

    def _parse_vevent(self, cal_event, calendar_id: str) -> list[CalendarEvent]:
        try:
            from icalendar import Calendar as ICalendar
        except ImportError as e:
            raise RuntimeError("icalendar not installed. Run: pip install icalendar") from e

        try:
            data = cal_event.data
            if isinstance(data, str):
                data = data.encode()
            ical = ICalendar.from_ical(data)
        except Exception as e:
            logger.warning("Failed to parse iCal data: %s", e)
            return []

        events = []
        for component in ical.walk():
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
                    provider_id=str(cal_event.url),
                    description=description,
                    location=location,
                    all_day=all_day,
                ))
            except Exception as e:
                logger.warning("Error parsing VEVENT component: %s", e)

        return events

    def _to_ical(self, event: CalendarEvent) -> str:
        try:
            from icalendar import Calendar as ICalendar, Event as ICalEvent
        except ImportError as e:
            raise RuntimeError("icalendar not installed. Run: pip install icalendar") from e

        cal = ICalendar()
        cal.add("prodid", "-//Calendar Sync Integration//EN")
        cal.add("version", "2.0")

        vevent = ICalEvent()
        vevent.add("uid", event.uid)
        vevent.add("summary", event.title)
        vevent.add("dtstart", event.start)
        vevent.add("dtend", event.end)
        if event.description:
            vevent.add("description", event.description)
        if event.location:
            vevent.add("location", event.location)
        if event.status:
            vevent.add("status", event.status.upper())

        cal.add_component(vevent)
        return cal.to_ical().decode()
