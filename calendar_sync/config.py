"""Configuration loading and validation."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import yaml


@dataclass
class GoogleConfig:
    credentials_file: str = "credentials.json"
    token_file: str = "token.json"
    calendar_ids: list[str] = field(default_factory=lambda: ["primary"])


@dataclass
class OutlookConfig:
    client_id: str = ""
    client_secret: str = ""
    tenant_id: str = "common"
    calendar_ids: list[str] = field(default_factory=lambda: ["Calendar"])


@dataclass
class CalDAVConfig:
    url: str = ""
    username: str = ""
    password: str = ""
    calendar_paths: list[str] = field(default_factory=list)


@dataclass
class ICalFeed:
    name: str
    url: str


@dataclass
class ICalConfig:
    feeds: list[ICalFeed] = field(default_factory=list)


@dataclass
class SyncRule:
    name: str
    source: str
    target: str
    direction: str = "bidirectional"  # bidirectional, source_to_target, target_to_source
    lookback_days: int = 7
    lookahead_days: int = 90
    conflict_strategy: str = "newer_wins"  # newer_wins, source_wins, target_wins, skip

    def source_provider(self) -> str:
        return self.source.split(":")[0]

    def source_calendar(self) -> str:
        parts = self.source.split(":", 1)
        return parts[1] if len(parts) > 1 else "primary"

    def target_provider(self) -> str:
        return self.target.split(":")[0]

    def target_calendar(self) -> str:
        parts = self.target.split(":", 1)
        return parts[1] if len(parts) > 1 else "primary"


@dataclass
class Options:
    log_level: str = "INFO"
    state_file: str = ".calendar_sync_state.json"
    dry_run: bool = False


@dataclass
class Config:
    providers: dict = field(default_factory=dict)
    sync_rules: list[SyncRule] = field(default_factory=list)
    options: Options = field(default_factory=Options)

    def get_google(self) -> Optional[GoogleConfig]:
        if "google" not in self.providers:
            return None
        data = self.providers["google"]
        return GoogleConfig(**{k: v for k, v in data.items() if k in GoogleConfig.__dataclass_fields__})

    def get_outlook(self) -> Optional[OutlookConfig]:
        if "outlook" not in self.providers:
            return None
        data = self.providers["outlook"]
        return OutlookConfig(**{k: v for k, v in data.items() if k in OutlookConfig.__dataclass_fields__})

    def get_caldav(self) -> Optional[CalDAVConfig]:
        if "caldav" not in self.providers:
            return None
        data = self.providers["caldav"]
        return CalDAVConfig(**{k: v for k, v in data.items() if k in CalDAVConfig.__dataclass_fields__})

    def get_ical(self) -> Optional[ICalConfig]:
        if "ical" not in self.providers:
            return None
        data = self.providers["ical"]
        feeds = [ICalFeed(**f) for f in data.get("feeds", [])]
        return ICalConfig(feeds=feeds)


def load_config(path: str | Path = "config.yaml") -> Config:
    """Load configuration from a YAML file."""
    config_path = Path(path)
    if not config_path.exists():
        raise FileNotFoundError(f"Config file not found: {config_path}")

    with open(config_path) as f:
        raw = yaml.safe_load(f)

    raw = raw or {}

    # Expand environment variables in string values
    raw = _expand_env(raw)

    sync_rules = [
        SyncRule(**{k: v for k, v in rule.items() if k in SyncRule.__dataclass_fields__})
        for rule in raw.get("sync_rules", [])
    ]

    options_data = raw.get("options", {})
    options = Options(**{k: v for k, v in options_data.items() if k in Options.__dataclass_fields__})

    return Config(
        providers=raw.get("providers", {}),
        sync_rules=sync_rules,
        options=options,
    )


def _expand_env(obj):
    """Recursively expand environment variables in config values."""
    if isinstance(obj, str):
        return os.path.expandvars(obj)
    if isinstance(obj, dict):
        return {k: _expand_env(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_expand_env(item) for item in obj]
    return obj
