"""Flask app — Programming Machine REST API + static serving."""

from __future__ import annotations

import json
import os
from datetime import date, datetime, timedelta
from pathlib import Path

import requests
from flask import Flask, jsonify, request, send_from_directory

from ..database import init_db, kv_get, kv_set

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
STATIC_DIR = Path(__file__).parent / "static" / "dist"


def create_app():
    app = Flask(__name__, static_folder=None)
    app.secret_key = os.environ.get("FLASK_SECRET_KEY", "pm-dev-secret-key")

    init_db()

    # ── Key-value storage (React app stores all state here) ──────────────────

    @app.route("/api/storage/<key>", methods=["GET"])
    def storage_get(key):
        value = kv_get(key)
        return jsonify({"value": value})

    @app.route("/api/storage/<key>", methods=["PUT"])
    def storage_set(key):
        body = request.get_json(silent=True) or {}
        kv_set(key, body.get("value"))
        return jsonify({"ok": True})

    # ── Claude API proxy (keeps API key on server) ────────────────────────────

    @app.route("/api/claude", methods=["POST"])
    def claude_proxy():
        if not ANTHROPIC_API_KEY:
            return jsonify({"error": "ANTHROPIC_API_KEY not set on server"}), 500
        body = request.get_json(silent=True) or {}
        payload = {
            "model":      body.get("model", "claude-sonnet-4-20250514"),
            "max_tokens": body.get("max_tokens", 4096),
            "messages":   body.get("messages", []),
        }
        if body.get("system"):
            payload["system"] = body["system"]
        try:
            r = requests.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "Content-Type":    "application/json",
                    "x-api-key":       ANTHROPIC_API_KEY,
                    "anthropic-version": "2023-06-01",
                },
                json=payload,
                timeout=120,
            )
            return jsonify(r.json()), r.status_code
        except requests.RequestException as e:
            return jsonify({"error": str(e)}), 502

    # ── iCal calendar fetch ───────────────────────────────────────────────────

    @app.route("/api/ical")
    def ical_fetch():
        url = request.args.get("url", "").strip()
        if not url:
            return jsonify([])
        try:
            from icalendar import Calendar
            import recurring_ical_events
            import pytz

            resp = requests.get(url, timeout=10)
            resp.raise_for_status()
            cal = Calendar.from_ical(resp.content)
            today = date.today()
            start = datetime(today.year, today.month, today.day)
            end   = start + timedelta(days=1)
            raw   = recurring_ical_events.of(cal).between(start, end)
            events = []
            for e in raw:
                dtstart = e.get("DTSTART").dt
                if hasattr(dtstart, "date"):
                    time_str = dtstart.strftime("%-I:%M %p")
                else:
                    time_str = "All day"
                events.append({
                    "title":    str(e.get("SUMMARY", "(no title)")),
                    "time":     time_str,
                    "rawTitle": str(e.get("SUMMARY", "")),
                })
            return jsonify(sorted(events, key=lambda x: x["time"]))
        except Exception as exc:
            return jsonify({"error": str(exc)}), 500

    # ── Serve React build (catch-all) ─────────────────────────────────────────

    @app.route("/", defaults={"path": ""})
    @app.route("/<path:path>")
    def serve_react(path):
        if path and (STATIC_DIR / path).exists():
            return send_from_directory(str(STATIC_DIR), path)
        index = STATIC_DIR / "index.html"
        if index.exists():
            return send_from_directory(str(STATIC_DIR), "index.html")
        # Dev fallback when React isn't built yet
        return (
            "<h2 style='font-family:monospace;padding:40px'>Run "
            "<code>cd frontend && npm run build</code> to build the UI.</h2>",
            200,
        )

    return app
