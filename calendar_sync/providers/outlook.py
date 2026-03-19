"""Microsoft Outlook / Graph API calendar provider."""

from __future__ import annotations

import logging
from datetime import datetime, date, timezone, timedelta
from typing import Optional

import requests

from ..models import CalendarEvent, Attendee
from .base import CalendarProvider

logger = logging.getLogger(__name__)

GRAPH_BASE = "https://graph.microsoft.com/v1.0"


class OutlookCalendarProvider(CalendarProvider):
    """Integrates with Microsoft Outlook via Microsoft Graph API."""

    def __init__(self, client_id: str, client_secret: str, tenant_id: str = "common"):
        self.client_id = client_id
        self.client_secret = client_secret
        self.tenant_id = tenant_id
        self._token: Optional[str] = None
        self._token_expiry: Optional[datetime] = None

    @property
    def name(self) -> str:
        return "outlook"

    def _get_token(self) -> str:
        now = datetime.now(timezone.utc)
        if self._token and self._token_expiry and self._token_expiry > now:
            return self._token

        try:
            import msal
        except ImportError as e:
            raise RuntimeError("msal not installed. Run: pip install msal") from e

        app = msal.ConfidentialClientApplication(
            self.client_id,
            authority=f"https://login.microsoftonline.com/{self.tenant_id}",
            client_credential=self.client_secret,
        )
        result = app.acquire_token_for_client(["https://graph.microsoft.com/.default"])
        if "access_token" not in result:
            raise RuntimeError(f"Failed to acquire Microsoft Graph token: {result.get('error_description')}")

        self._token = result["access_token"]
        expires_in = result.get("expires_in", 3600)
        self._token_expiry = now + timedelta(seconds=expires_in - 60)
        return self._token

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self._get_token()}",
            "Content-Type": "application/json",
        }

    def _request(self, method: str, path: str, **kwargs) -> dict:
        url = f"{GRAPH_BASE}{path}"
        resp = requests.request(method, url, headers=self._headers(), **kwargs)
        resp.raise_for_status()
        if resp.content:
            return resp.json()
        return {}

    def list_calendars(self) -> list[dict]:
        result = self._request("GET", "/me/calendars")
        return [
            {"id": c["id"], "name": c.get("name", c["id"])}
            for c in result.get("value", [])
        ]

    def get_events(self, calendar_id: str, start: datetime, end: datetime) -> list[CalendarEvent]:
        start_str = start.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        end_str = end.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

        events = []
        url = f"/me/calendars/{calendar_id}/calendarView"
        params = {"startDateTime": start_str, "endDateTime": end_str, "$top": 100}

        while url:
            result = self._request("GET", url, params=params)
            for item in result.get("value", []):
                try:
                    events.append(self._parse_event(item, calendar_id))
                except Exception as e:
                    logger.warning("Failed to parse Outlook event %s: %s", item.get("id"), e)
            url = result.get("@odata.nextLink", "").replace(GRAPH_BASE, "")
            params = {}

        return events

    def create_event(self, calendar_id: str, event: CalendarEvent) -> CalendarEvent:
        body = self._to_graph_event(event)
        result = self._request("POST", f"/me/calendars/{calendar_id}/events", json=body)
        event.provider_id = result["id"]
        event.provider = self.name
        event.calendar_id = calendar_id
        return event

    def update_event(self, calendar_id: str, event: CalendarEvent) -> CalendarEvent:
        body = self._to_graph_event(event)
        self._request("PATCH", f"/me/events/{event.provider_id}", json=body)
        return event

    def delete_event(self, calendar_id: str, provider_id: str) -> None:
        self._request("DELETE", f"/me/events/{provider_id}")

    def _parse_event(self, item: dict, calendar_id: str) -> CalendarEvent:
        all_day = item.get("isAllDay", False)
        start_raw = item["start"]
        end_raw = item["end"]

        if all_day:
            start = date.fromisoformat(start_raw["dateTime"][:10])
            end = date.fromisoformat(end_raw["dateTime"][:10])
        else:
            start = datetime.fromisoformat(start_raw["dateTime"])
            if start_raw.get("timeZone") == "UTC":
                start = start.replace(tzinfo=timezone.utc)
            end = datetime.fromisoformat(end_raw["dateTime"])
            if end_raw.get("timeZone") == "UTC":
                end = end.replace(tzinfo=timezone.utc)

        uid = item.get("iCalUId") or item["id"]
        attendees = [
            Attendee(
                email=a["emailAddress"]["address"],
                display_name=a["emailAddress"].get("name"),
                response_status=a.get("status", {}).get("response"),
            )
            for a in item.get("attendees", [])
        ]

        organizer = item.get("organizer", {}).get("emailAddress", {}).get("address")
        status = "cancelled" if item.get("isCancelled") else "confirmed"
        created_at = None
        if item.get("createdDateTime"):
            created_at = datetime.fromisoformat(item["createdDateTime"].replace("Z", "+00:00"))
        updated_at = None
        if item.get("lastModifiedDateTime"):
            updated_at = datetime.fromisoformat(item["lastModifiedDateTime"].replace("Z", "+00:00"))

        return CalendarEvent(
            uid=uid,
            title=item.get("subject", "(No title)"),
            start=start,
            end=end,
            provider=self.name,
            calendar_id=calendar_id,
            provider_id=item["id"],
            description=item.get("body", {}).get("content"),
            location=item.get("location", {}).get("displayName"),
            all_day=all_day,
            organizer=organizer,
            attendees=attendees,
            status=status,
            created_at=created_at,
            updated_at=updated_at,
        )

    def _to_graph_event(self, event: CalendarEvent) -> dict:
        if event.all_day:
            start = {"dateTime": f"{event.start.isoformat()[:10]}T00:00:00", "timeZone": "UTC"}
            end = {"dateTime": f"{event.end.isoformat()[:10]}T00:00:00", "timeZone": "UTC"}
        else:
            start = {"dateTime": event.start.isoformat(), "timeZone": "UTC"}
            end = {"dateTime": event.end.isoformat(), "timeZone": "UTC"}

        body: dict = {
            "subject": event.title,
            "start": start,
            "end": end,
            "isAllDay": event.all_day,
        }
        if event.description:
            body["body"] = {"contentType": "text", "content": event.description}
        if event.location:
            body["location"] = {"displayName": event.location}
        return body
