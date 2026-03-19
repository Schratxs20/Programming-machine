"""Event diff and comparison utilities."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Optional

from ..models import CalendarEvent


class ChangeType(Enum):
    CREATE = "create"
    UPDATE = "update"
    DELETE = "delete"
    NONE = "none"


@dataclass
class EventChange:
    change_type: ChangeType
    source_event: Optional[CalendarEvent]
    target_event: Optional[CalendarEvent]

    @classmethod
    def create(cls, event: CalendarEvent) -> "EventChange":
        return cls(ChangeType.CREATE, source_event=event, target_event=None)

    @classmethod
    def update(cls, source: CalendarEvent, target: CalendarEvent) -> "EventChange":
        return cls(ChangeType.UPDATE, source_event=source, target_event=target)

    @classmethod
    def delete(cls, event: CalendarEvent) -> "EventChange":
        return cls(ChangeType.DELETE, source_event=None, target_event=event)

    @classmethod
    def none(cls, event: CalendarEvent) -> "EventChange":
        return cls(ChangeType.NONE, source_event=event, target_event=event)


def compute_diff(
    source_events: list[CalendarEvent],
    target_events: list[CalendarEvent],
) -> list[EventChange]:
    """Compute the diff between source and target event lists.

    Returns a list of changes needed to bring the target in sync with the source.
    Events are matched by UID.
    """
    source_by_uid = {e.uid: e for e in source_events}
    target_by_uid = {e.uid: e for e in target_events}

    changes: list[EventChange] = []

    # Events in source but not in target → CREATE
    for uid, src_event in source_by_uid.items():
        if uid not in target_by_uid:
            changes.append(EventChange.create(src_event))
        else:
            tgt_event = target_by_uid[uid]
            if src_event.content_hash() != tgt_event.content_hash():
                changes.append(EventChange.update(src_event, tgt_event))
            else:
                changes.append(EventChange.none(src_event))

    # Events in target but not in source → DELETE
    for uid, tgt_event in target_by_uid.items():
        if uid not in source_by_uid:
            changes.append(EventChange.delete(tgt_event))

    return changes
