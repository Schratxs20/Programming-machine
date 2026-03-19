"""Tests for configuration loading."""

import pytest
import yaml
import tempfile
import os
from pathlib import Path

from calendar_sync.config import load_config, Config, SyncRule


def write_config(path: str, data: dict) -> None:
    with open(path, "w") as f:
        yaml.dump(data, f)


class TestLoadConfig:
    def test_loads_minimal_config(self, tmp_path):
        cfg_path = tmp_path / "config.yaml"
        write_config(str(cfg_path), {})
        config = load_config(cfg_path)
        assert isinstance(config, Config)
        assert config.sync_rules == []

    def test_loads_google_provider(self, tmp_path):
        cfg_path = tmp_path / "config.yaml"
        write_config(str(cfg_path), {
            "providers": {
                "google": {
                    "credentials_file": "creds.json",
                    "calendar_ids": ["primary", "work"],
                }
            }
        })
        config = load_config(cfg_path)
        google = config.get_google()
        assert google is not None
        assert google.credentials_file == "creds.json"
        assert "primary" in google.calendar_ids

    def test_loads_sync_rules(self, tmp_path):
        cfg_path = tmp_path / "config.yaml"
        write_config(str(cfg_path), {
            "sync_rules": [{
                "name": "my-sync",
                "source": "google:primary",
                "target": "outlook:Calendar",
                "direction": "bidirectional",
                "lookback_days": 14,
                "lookahead_days": 60,
                "conflict_strategy": "source_wins",
            }]
        })
        config = load_config(cfg_path)
        assert len(config.sync_rules) == 1
        rule = config.sync_rules[0]
        assert rule.name == "my-sync"
        assert rule.source_provider() == "google"
        assert rule.source_calendar() == "primary"
        assert rule.target_provider() == "outlook"
        assert rule.target_calendar() == "Calendar"
        assert rule.direction == "bidirectional"
        assert rule.lookback_days == 14
        assert rule.conflict_strategy == "source_wins"

    def test_file_not_found_raises(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            load_config(tmp_path / "nonexistent.yaml")

    def test_expands_env_vars(self, tmp_path, monkeypatch):
        monkeypatch.setenv("MY_CLIENT_ID", "abc-123")
        cfg_path = tmp_path / "config.yaml"
        write_config(str(cfg_path), {
            "providers": {
                "outlook": {
                    "client_id": "$MY_CLIENT_ID",
                    "client_secret": "secret",
                }
            }
        })
        config = load_config(cfg_path)
        outlook = config.get_outlook()
        assert outlook.client_id == "abc-123"

    def test_options_defaults(self, tmp_path):
        cfg_path = tmp_path / "config.yaml"
        write_config(str(cfg_path), {})
        config = load_config(cfg_path)
        assert config.options.log_level == "INFO"
        assert config.options.dry_run is False

    def test_no_google_provider_returns_none(self, tmp_path):
        cfg_path = tmp_path / "config.yaml"
        write_config(str(cfg_path), {})
        config = load_config(cfg_path)
        assert config.get_google() is None


class TestSyncRule:
    def test_source_provider_parsing(self):
        rule = SyncRule(name="r", source="google:primary", target="outlook:Calendar")
        assert rule.source_provider() == "google"
        assert rule.source_calendar() == "primary"

    def test_target_provider_parsing(self):
        rule = SyncRule(name="r", source="google:primary", target="caldav:https://dav.example.com/cal/")
        assert rule.target_provider() == "caldav"
        assert rule.target_calendar() == "https://dav.example.com/cal/"
