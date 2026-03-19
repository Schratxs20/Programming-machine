"""Flask app — Programming Machine coaching dashboard."""

from __future__ import annotations

import functools
import hashlib
import json
import os
import secrets
from datetime import date, datetime, timedelta

import requests
from flask import Flask, render_template, request, redirect, url_for, flash, session

from ..database import (
    init_db, get_all_clients, get_client, add_client, delete_client,
    update_client, get_program, save_day, get_todays_workouts, DAYS,
)

COACH_USER = os.environ.get("DASHBOARD_USERNAME", "admin")
COACH_PASS = os.environ.get("DASHBOARD_PASSWORD", "changeme")
ICAL_URL   = os.environ.get("ICAL_FEED_URL", "")  # optional iCal feed URL


def _check_credentials(username, password):
    ok_user = secrets.compare_digest(username, COACH_USER)
    ok_pass = secrets.compare_digest(
        hashlib.sha256(password.encode()).hexdigest(),
        hashlib.sha256(COACH_PASS.encode()).hexdigest(),
    )
    return ok_user and ok_pass


def _get_calendar_events():
    """Fetch today's events from the iCal feed URL (if configured)."""
    if not ICAL_URL:
        return []
    try:
        from icalendar import Calendar
        import recurring_ical_events
        import pytz

        resp = requests.get(ICAL_URL, timeout=8)
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
                "location": str(e.get("LOCATION", "")),
            })
        return sorted(events, key=lambda x: x["time"])
    except Exception:
        return []


def create_app():
    app = Flask(__name__)
    app.secret_key = os.environ.get("FLASK_SECRET_KEY", "pm-dev-secret-key")

    init_db()
    app.jinja_env.filters["enumerate"] = enumerate

    def login_required(f):
        @functools.wraps(f)
        def decorated(*args, **kwargs):
            if not session.get("logged_in"):
                return redirect(url_for("login"))
            return f(*args, **kwargs)
        return decorated

    # ── Auth ─────────────────────────────────────────────────────────────────

    @app.route("/login", methods=["GET", "POST"])
    def login():
        if session.get("logged_in"):
            return redirect(url_for("dashboard"))
        if request.method == "POST":
            if _check_credentials(
                request.form.get("username", ""),
                request.form.get("password", ""),
            ):
                session["logged_in"] = True
                return redirect(url_for("dashboard"))
            flash("Incorrect username or password.", "danger")
        return render_template("login.html")

    @app.route("/logout")
    def logout():
        session.clear()
        return redirect(url_for("login"))

    # ── Daily dashboard ───────────────────────────────────────────────────────

    @app.route("/")
    @login_required
    def dashboard():
        today     = date.today()
        day_name  = DAYS[today.weekday()]
        workouts  = get_todays_workouts()
        cal_events = _get_calendar_events()
        return render_template(
            "index.html",
            today=today,
            day_name=day_name,
            workouts=workouts,
            cal_events=cal_events,
            ical_configured=bool(ICAL_URL),
        )

    # ── Clients ───────────────────────────────────────────────────────────────

    @app.route("/clients")
    @login_required
    def clients():
        all_clients = get_all_clients()
        return render_template("clients.html", clients=all_clients)

    @app.route("/clients/add", methods=["POST"])
    @login_required
    def client_add():
        name = request.form.get("name", "").strip()
        if not name:
            flash("Client name is required.", "danger")
            return redirect(url_for("clients"))
        add_client(name, request.form.get("notes", "").strip())
        flash(f"{name} added.", "success")
        return redirect(url_for("clients"))

    @app.route("/clients/<int:client_id>/delete", methods=["POST"])
    @login_required
    def client_delete(client_id):
        client = get_client(client_id)
        if client:
            delete_client(client_id)
            flash(f"{client['name']} removed.", "info")
        return redirect(url_for("clients"))

    # ── Program editor ────────────────────────────────────────────────────────

    @app.route("/clients/<int:client_id>/program")
    @login_required
    def program_view(client_id):
        client  = get_client(client_id)
        if not client:
            flash("Client not found.", "danger")
            return redirect(url_for("clients"))
        program = get_program(client_id)
        return render_template("program.html", client=client, program=program, days=DAYS)

    @app.route("/clients/<int:client_id>/program/<int:day>", methods=["POST"])
    @login_required
    def program_save_day(client_id, day):
        if not get_client(client_id):
            flash("Client not found.", "danger")
            return redirect(url_for("clients"))
        # Exercises arrive as parallel arrays from the form
        names  = request.form.getlist("name[]")
        sets   = request.form.getlist("sets[]")
        reps   = request.form.getlist("reps[]")
        loads  = request.form.getlist("load[]")
        notes  = request.form.getlist("notes[]")
        exercises = [
            {"name": n, "sets": s, "reps": r, "load": l, "notes": nt}
            for n, s, r, l, nt in zip(names, sets, reps, loads, notes)
            if n.strip()
        ]
        save_day(client_id, day, exercises)
        flash(f"{DAYS[day]} saved.", "success")
        return redirect(url_for("program_view", client_id=client_id))

    return app
