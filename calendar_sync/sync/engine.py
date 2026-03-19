"""Core sync engine."""

from __future__ import annotations

import copy
import json
import logging
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

from ..config import SyncRule
from ..models import CalendarEvent, SyncResult
from ..providers.base import CalendarProvider
from .conflict import ConflictResolver
from .diff import compute_diff, ChangeType

logger = logging.getLogger(__name__)


class SyncEngine:
    """Orchestrates calendar synchronization between providers."""

    def __init__(
        self,
        providers: dict[str, CalendarProvider],
        state_file: str = ".calendar_sync_state.json",
        dry_run: bool = False,
    ):
        self.providers = providers
        self.state_file = Path(state_file)
        self.dry_run = dry_run
        self._state = self._load_state()

    def sync_rule(self, rule: SyncRule) -> SyncResult:
        """Execute a single sync rule."""
        result = SyncResult(rule_name=rule.name)
        resolver = ConflictResolver(rule.conflict_strategy)

        now = datetime.now(timezone.utc)
        range_start = now - timedelta(days=rule.lookback_days)
        range_end = now + timedelta(days=rule.lookahead_days)

        src_provider = self.providers.get(rule.source_provider())
        tgt_provider = self.providers.get(rule.target_provider())

        if not src_provider:
            msg = f"Source provider '{rule.source_provider()}' not configured"
            logger.error(msg)
            result.errors.append(msg)
            return result

        if not tgt_provider:
            msg = f"Target provider '{rule.target_provider()}' not configured"
            logger.error(msg)
            result.errors.append(msg)
            return result

        src_calendar = rule.source_calendar()
        tgt_calendar = rule.target_calendar()

        directions = []
        if rule.direction in ("bidirectional", "source_to_target"):
            directions.append(("source→target", src_provider, src_calendar, tgt_provider, tgt_calendar))
        if rule.direction in ("bidirectional", "target_to_source"):
            directions.append(("target→source", tgt_provider, tgt_calendar, src_provider, src_calendar))

        for label, from_p, from_cal, to_p, to_cal in directions:
            logger.info("[%s] Syncing %s", rule.name, label)
            sub = self._sync_one_direction(
                rule, from_p, from_cal, to_p, to_cal, range_start, range_end, resolver
            )
            result.created += sub.created
            result.updated += sub.updated
            result.deleted += sub.deleted
            result.skipped += sub.skipped
            result.errors.extend(sub.errors)

        return result

    def _sync_one_direction(
        self,
        rule: SyncRule,
        from_provider: CalendarProvider,
        from_calendar: str,
        to_provider: CalendarProvider,
        to_calendar: str,
        start: datetime,
        end: datetime,
        resolver: ConflictResolver,
    ) -> SyncResult:
        result = SyncResult(rule_name=rule.name)

        try:
            source_events = from_provider.get_events(from_calendar, start, end)
            logger.debug("Fetched %d events from %s:%s", len(source_events), from_provider.name, from_calendar)
        except Exception as e:
            msg = f"Failed to fetch from {from_provider.name}:{from_calendar}: {e}"
            logger.error(msg)
            result.errors.append(msg)
            return result

        try:
            target_events = to_provider.get_events(to_calendar, start, end)
            logger.debug("Fetched %d events from %s:%s", len(target_events), to_provider.name, to_calendar)
        except Exception as e:
            msg = f"Failed to fetch from {to_provider.name}:{to_calendar}: {e}"
            logger.error(msg)
            result.errors.append(msg)
            return result

        changes = compute_diff(source_events, target_events)

        for change in changes:
            try:
                if change.change_type == ChangeType.CREATE:
                    new_event = copy.deepcopy(change.source_event)
                    if self.dry_run:
                        logger.info("[dry-run] Would CREATE: %s", new_event.title)
                    else:
                        to_provider.create_event(to_calendar, new_event)
                        logger.info("CREATED: %s in %s:%s", new_event.title, to_provider.name, to_calendar)
                    result.created += 1

                elif change.change_type == ChangeType.UPDATE:
                    winner = resolver.resolve(change.source_event, change.target_event)
                    if winner is None:
                        logger.debug("SKIPPED (conflict): %s", change.source_event.title)
                        result.skipped += 1
                        continue

                    updated = copy.deepcopy(winner)
                    updated.provider_id = change.target_event.provider_id
                    if self.dry_run:
                        logger.info("[dry-run] Would UPDATE: %s", updated.title)
                    else:
                        to_provider.update_event(to_calendar, updated)
                        logger.info("UPDATED: %s in %s:%s", updated.title, to_provider.name, to_calendar)
                    result.updated += 1

                elif change.change_type == ChangeType.DELETE:
                    event = change.target_event
                    if self.dry_run:
                        logger.info("[dry-run] Would DELETE: %s", event.title)
                    else:
                        to_provider.delete_event(to_calendar, event.provider_id)
                        logger.info("DELETED: %s from %s:%s", event.title, to_provider.name, to_calendar)
                    result.deleted += 1

                elif change.change_type == ChangeType.NONE:
                    result.skipped += 1

            except Exception as e:
                msg = f"Error applying {change.change_type.value} for '{change.source_event or change.target_event}': {e}"
                logger.error(msg)
                result.errors.append(msg)

        return result

    def _load_state(self) -> dict:
        if self.state_file.exists():
            try:
                return json.loads(self.state_file.read_text())
            except Exception:
                pass
        return {}

    def _save_state(self, state: dict) -> None:
        self.state_file.write_text(json.dumps(state, indent=2))
