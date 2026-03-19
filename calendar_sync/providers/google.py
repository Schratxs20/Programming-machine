"""Google Calendar provider using the Google Calendar API."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, date, timezone
from typing import Optional

from ..models import CalendarEvent, Attendee
from .base import CalendarProvider

logger = logging.getLogger(__name__)


class GoogleCalendarProvider(CalendarProvider):
    """Integrates with Google Calendar via the Google Calendar API v3."""

    def __init__(self, credentials_file: str = "credentials.json", token_file: str = "token.json"):
        self.credentials_file = credentials_file
        self.token_file = token_file
        self._service = None

    @property
    def name(self) -> str:
        return "google"

    def _get_service(self):
        if self._service is not None:
            return self._service

        try:
            from google.auth.transport.requests import Request
            from google.oauth2.credentials import Credentials
            from google_auth_oauthlib.flow import InstalledAppFlow
            from googleapiclient.discovery import build
        except ImportError as e:
            raise RuntimeError(
                "Google client libraries not installed. Run: pip install google-api-python-client google-auth-oauthlib"
            ) from e

        scopes = ["https://www.googleapis.com/auth/calendar"]
        creds = None

        import os
        if os.path.exists(self.token_file):
            creds = Credentials.from_authorized_user_file(self.token_file, scopes)

        if not creds or not creds.valid:
            if creds and creds.expired and creds.refresh_token:
                creds.refresh(Request())
            else:
                flow = InstalledAppFlow.from_client_secrets_file(self.credentials_file, scopes)
                creds = flow.run_local_server(port=0)
            with open(self.token_file, "w") as token:
                token.write(creds.to_json())

        self._service = build("calendar", "v3", credentials=creds)
        return self._service

    def list_calendars(self) -> list[dict]:
        service = self._get_service()
        result = service.calendarList().list().execute()
        return [
            {"id": item["id"], "name": item.get("summary", item["id"])}
            for item in result.get("items", [])
        ]

    def get_events(self, calendar_id: str, start: datetime, end: datetime) -> list[CalendarEvent]:
        service = self._get_service()
        time_min = start.astimezone(timezone.utc).isoformat()
        time_max = end.astimezone(timezone.utc).isoformat()

        events = []
        page_token = None
        while True:
            response = service.events().list(
                calendarId=calendar_id,
                timeMin=time_min,
                timeMax=time_max,
                singleEvents=True,
                orderBy="startTime",
                pageToken=page_token,
            ).execute()

            for item in response.get("items", []):
                try:
                    events.append(self._parse_event(item, calendar_id))
                except Exception as e:
                    logger.warning("Failed to parse Google event %s: %s", item.get("id"), e)

            page_token = response.get("nextPageToken")
            if not page_token:
                break

        return events

    def create_event(self, calendar_id: str, event: CalendarEvent) -> CalendarEvent:
        service = self._get_service()
        body = self._to_google_event(event)
        result = service.events().insert(calendarId=calendar_id, body=body).execute()
        event.provider_id = result["id"]
        event.provider = self.name
        event.calendar_id = calendar_id
        return event

    def update_event(self, calendar_id: str, event: CalendarEvent) -> CalendarEvent:
        service = self._get_service()
        body = self._to_google_event(event)
        service.events().update(calendarId=calendar_id, eventId=event.provider_id, body=body).execute()
        return event

    def delete_event(self, calendar_id: str, provider_id: str) -> None:
        service = self._get_service()
        service.events().delete(calendarId=calendar_id, eventId=provider_id).execute()

    def _parse_event(self, item: dict, calendar_id: str) -> CalendarEvent:
        start_raw = item["start"]
        end_raw = item["end"]

        all_day = "date" in start_raw and "dateTime" not in start_raw
        if all_day:
            start = date.fromisoformat(start_raw["date"])
            end = date.fromisoformat(end_raw["date"])
        else:
            start = datetime.fromisoformat(start_raw["dateTime"])
            end = datetime.fromisoformat(end_raw["dateTime"])

        uid = item.get("iCalUID") or item["id"]
        attendees = [
            Attendee(
                email=a["email"],
                display_name=a.get("displayName"),
                response_status=a.get("responseStatus"),
            )
            for a in item.get("attendees", [])
        ]

        created_at = None
        if item.get("created"):
            created_at = datetime.fromisoformat(item["created"].replace("Z", "+00:00"))
        updated_at = None
        if item.get("updated"):
            updated_at = datetime.fromisoformat(item["updated"].replace("Z", "+00:00"))

        return CalendarEvent(
            uid=uid,
            title=item.get("summary", "(No title)"),
            start=start,
            end=end,
            provider=self.name,
            calendar_id=calendar_id,
            provider_id=item["id"],
            description=item.get("description"),
            location=item.get("location"),
            all_day=all_day,
            recurrence="\n".join(item.get("recurrence", [])) or None,
            organizer=item.get("organizer", {}).get("email"),
            attendees=attendees,
            status=item.get("status", "confirmed"),
            visibility=item.get("visibility", "default"),
            created_at=created_at,
            updated_at=updated_at,
            url=item.get("htmlLink"),
        )

    def _to_google_event(self, event: CalendarEvent) -> dict:
        if event.all_day:
            start = {"date": event.start.isoformat()[:10]}
            end = {"date": event.end.isoformat()[:10]}
        else:
            start = {"dateTime": event.start.isoformat()}
            end = {"dateTime": event.end.isoformat()}

        body: dict = {
            "summary": event.title,
            "start": start,
            "end": end,
            "iCalUID": event.uid,
        }
        if event.description:
            body["description"] = event.description
        if event.location:
            body["location"] = event.location
        if event.status:
            body["status"] = event.status
        if event.visibility and event.visibility != "default":
            body["visibility"] = event.visibility
        return body
