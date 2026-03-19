"""Flask web interface for Calendar Sync Integration."""

from __future__ import annotations

import functools
import hashlib
import json
import logging
import os
import secrets
from datetime import datetime, timedelta
from pathlib import Path

from flask import Flask, render_template, request, redirect, url_for, flash, jsonify, session

from ..config import load_config, Config
from ..cli import build_providers
from ..sync.engine import SyncEngine

logger = logging.getLogger(__name__)

_config_path: str = "config.yaml"
_sync_history: list[dict] = []


def _check_credentials(username: str, password: str) -> bool:
    expected_user = os.environ.get("DASHBOARD_USERNAME", "admin")
    expected_pass = os.environ.get("DASHBOARD_PASSWORD", "changeme")
    user_ok = secrets.compare_digest(username, expected_user)
    pass_ok = secrets.compare_digest(
        hashlib.sha256(password.encode()).hexdigest(),
        hashlib.sha256(expected_pass.encode()).hexdigest(),
    )
    return user_ok and pass_ok


def create_app(config_path: str = "config.yaml") -> Flask:
    global _config_path
    _config_path = config_path

    app = Flask(__name__)
    app.secret_key = os.environ.get("FLASK_SECRET_KEY", "calendar-sync-dev-key")

    def login_required(f):
        @functools.wraps(f)
        def decorated(*args, **kwargs):
            if not session.get("logged_in"):
                return redirect(url_for("login"))
            return f(*args, **kwargs)
        return decorated

    def load_cfg() -> tuple[Config | None, str | None]:
        try:
            return load_config(_config_path), None
        except FileNotFoundError:
            return None, f"Config file not found: {_config_path}"
        except Exception as e:
            return None, str(e)

    @app.route("/login", methods=["GET", "POST"])
    def login():
        if session.get("logged_in"):
            return redirect(url_for("dashboard"))
        if request.method == "POST":
            username = request.form.get("username", "")
            password = request.form.get("password", "")
            if _check_credentials(username, password):
                session["logged_in"] = True
                session["username"] = username
                return redirect(url_for("dashboard"))
            flash("Invalid username or password.", "danger")
        return render_template("login.html")

    @app.route("/logout")
    def logout():
        session.clear()
        flash("You have been logged out.", "info")
        return redirect(url_for("login"))

    @app.route("/")
    @login_required
    def dashboard():
        cfg, err = load_cfg()
        rules = cfg.sync_rules if cfg else []
        providers_configured = []
        if cfg:
            if cfg.get_google():
                providers_configured.append("Google Calendar")
            if cfg.get_outlook():
                providers_configured.append("Outlook")
            if cfg.get_caldav():
                providers_configured.append("CalDAV")
            if cfg.get_ical():
                providers_configured.append("iCal Feeds")
        return render_template(
            "index.html",
            config_error=err,
            rules=rules,
            providers=providers_configured,
            history=list(reversed(_sync_history[-20:])),
            config_path=_config_path,
        )

    @app.route("/sync", methods=["POST"])
    @login_required
    def run_sync():
        dry_run = request.form.get("dry_run") == "on"
        rule_name = request.form.get("rule") or None

        cfg, err = load_cfg()
        if err:
            flash(f"Config error: {err}", "danger")
            return redirect(url_for("dashboard"))

        providers = build_providers(cfg)
        engine = SyncEngine(
            providers=providers,
            state_file=cfg.options.state_file,
            dry_run=dry_run,
        )

        rules_to_run = cfg.sync_rules
        if rule_name:
            rules_to_run = [r for r in rules_to_run if r.name == rule_name]

        results = []
        for rule in rules_to_run:
            try:
                result = engine.sync_rule(rule)
                results.append({
                    "rule": rule.name,
                    "created": result.created,
                    "updated": result.updated,
                    "deleted": result.deleted,
                    "skipped": result.skipped,
                    "errors": result.errors,
                    "dry_run": dry_run,
                })
            except Exception as e:
                results.append({
                    "rule": rule.name,
                    "error": str(e),
                    "dry_run": dry_run,
                })

        entry = {
            "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "dry_run": dry_run,
            "results": results,
        }
        _sync_history.append(entry)

        if dry_run:
            flash("Dry-run complete — no changes were applied.", "info")
        else:
            flash("Sync complete.", "success")

        return redirect(url_for("dashboard"))

    @app.route("/calendars")
    @login_required
    def calendars():
        cfg, err = load_cfg()
        if err:
            flash(f"Config error: {err}", "danger")
            return render_template("calendars.html", providers_data={}, config_error=err)

        providers = build_providers(cfg)
        providers_data = {}
        for name, provider in providers.items():
            try:
                cals = provider.list_calendars()
                providers_data[name] = {"calendars": cals, "error": None}
            except Exception as e:
                providers_data[name] = {"calendars": [], "error": str(e)}

        return render_template("calendars.html", providers_data=providers_data, config_error=None)

    @app.route("/events")
    @login_required
    def events():
        cfg, err = load_cfg()
        if err:
            flash(f"Config error: {err}", "danger")
            return render_template("events.html", events_data=[], config_error=err,
                                   provider_name="", calendar_id="", providers=[])

        providers_obj = build_providers(cfg)
        provider_name = request.args.get("provider", "")
        calendar_id = request.args.get("calendar_id", "")
        days_back = int(request.args.get("days_back", 7))
        days_ahead = int(request.args.get("days_ahead", 30))

        events_data = []
        if provider_name and calendar_id and provider_name in providers_obj:
            start = datetime.now() - timedelta(days=days_back)
            end = datetime.now() + timedelta(days=days_ahead)
            try:
                raw = providers_obj[provider_name].get_events(calendar_id, start, end)
                events_data = sorted(
                    [e.to_dict() for e in raw],
                    key=lambda e: e.get("start") or "",
                )
            except Exception as ex:
                flash(f"Error fetching events: {ex}", "danger")

        # Build list of (provider, calendar_id, calendar_name) for the dropdown
        provider_calendars = []
        for p_name, provider in providers_obj.items():
            try:
                for cal in provider.list_calendars():
                    provider_calendars.append((p_name, cal["id"], cal["name"]))
            except Exception:
                pass

        return render_template(
            "events.html",
            events_data=events_data,
            config_error=None,
            provider_name=provider_name,
            calendar_id=calendar_id,
            providers=provider_calendars,
            days_back=days_back,
            days_ahead=days_ahead,
        )

    @app.route("/config")
    @login_required
    def config_view():
        cfg, err = load_cfg()
        config_text = ""
        try:
            config_text = Path(_config_path).read_text()
        except FileNotFoundError:
            pass
        return render_template(
            "config.html",
            config_error=err,
            config_text=config_text,
            config_path=_config_path,
            rules=cfg.sync_rules if cfg else [],
            options=cfg.options if cfg else None,
        )

    @app.route("/api/status")
    @login_required
    def api_status():
        cfg, err = load_cfg()
        return jsonify({
            "config_ok": err is None,
            "config_error": err,
            "history_count": len(_sync_history),
            "last_sync": _sync_history[-1]["timestamp"] if _sync_history else None,
        })

    return app
