"""Unified event model for calendar sync."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime, date
from typing import Optional


@dataclass
class Attendee:
    email: str
    display_name: Optional[str] = None
    response_status: Optional[str] = None  # accepted, declined, tentative, needsAction


@dataclass
class CalendarEvent:
    """Unified representation of a calendar event across all providers."""

    uid: str
    title: str
    start: datetime | date
    end: datetime | date
    provider: str
    calendar_id: str
    provider_id: str

    description: Optional[str] = None
    location: Optional[str] = None
    all_day: bool = False
    recurrence: Optional[str] = None
    organizer: Optional[str] = None
    attendees: list[Attendee] = field(default_factory=list)
    status: str = "confirmed"  # confirmed, tentative, cancelled
    visibility: str = "default"  # default, public, private
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    url: Optional[str] = None
    extra: dict = field(default_factory=dict)

    def content_hash(self) -> str:
        """Compute a hash of the event's meaningful content for change detection."""
        content = {
            "title": self.title,
            "start": self.start.isoformat(),
            "end": self.end.isoformat(),
            "description": self.description or "",
            "location": self.location or "",
            "all_day": self.all_day,
            "status": self.status,
        }
        serialized = json.dumps(content, sort_keys=True)
        return hashlib.sha256(serialized.encode()).hexdigest()[:16]

    def to_dict(self) -> dict:
        return {
            "uid": self.uid,
            "title": self.title,
            "start": self.start.isoformat(),
            "end": self.end.isoformat(),
            "provider": self.provider,
            "calendar_id": self.calendar_id,
            "provider_id": self.provider_id,
            "description": self.description,
            "location": self.location,
            "all_day": self.all_day,
            "recurrence": self.recurrence,
            "organizer": self.organizer,
            "status": self.status,
            "visibility": self.visibility,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


@dataclass
class SyncResult:
    """Result of a sync operation."""

    rule_name: str
    created: int = 0
    updated: int = 0
    deleted: int = 0
    skipped: int = 0
    errors: list[str] = field(default_factory=list)

    @property
    def total_changes(self) -> int:
        return self.created + self.updated + self.deleted

    def __str__(self) -> str:
        return (
            f"[{self.rule_name}] "
            f"created={self.created} updated={self.updated} "
            f"deleted={self.deleted} skipped={self.skipped} "
            f"errors={len(self.errors)}"
        )
