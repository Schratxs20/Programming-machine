"""SQLite database helpers for the Programming Machine."""

import json
import os
import sqlite3

DATABASE_PATH = os.environ.get("DATABASE_PATH", "/tmp/programs.db")

DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def get_db():
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = get_db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS clients (
            id    INTEGER PRIMARY KEY AUTOINCREMENT,
            name  TEXT NOT NULL,
            notes TEXT NOT NULL DEFAULT ''
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS workout_days (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            client_id    INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
            day_of_week  INTEGER NOT NULL,  -- 0=Mon … 6=Sun
            exercises    TEXT NOT NULL DEFAULT '[]'
        )
    """)
    conn.commit()
    conn.close()


# ── Clients ──────────────────────────────────────────────────────────────────

def get_all_clients():
    conn = get_db()
    rows = conn.execute("SELECT * FROM clients ORDER BY name").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_client(client_id):
    conn = get_db()
    row = conn.execute("SELECT * FROM clients WHERE id = ?", (client_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def add_client(name, notes=""):
    conn = get_db()
    cur = conn.execute("INSERT INTO clients (name, notes) VALUES (?, ?)", (name, notes))
    conn.commit()
    client_id = cur.lastrowid
    conn.close()
    return client_id


def delete_client(client_id):
    conn = get_db()
    conn.execute("DELETE FROM clients WHERE id = ?", (client_id,))
    conn.commit()
    conn.close()


def update_client(client_id, name, notes):
    conn = get_db()
    conn.execute("UPDATE clients SET name=?, notes=? WHERE id=?", (name, notes, client_id))
    conn.commit()
    conn.close()


# ── Programs ─────────────────────────────────────────────────────────────────

def get_program(client_id):
    """Return a dict keyed by day_of_week (0–6) → list of exercises."""
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM workout_days WHERE client_id = ? ORDER BY day_of_week",
        (client_id,),
    ).fetchall()
    conn.close()
    program = {d: [] for d in range(7)}
    for row in rows:
        program[row["day_of_week"]] = json.loads(row["exercises"])
    return program


def save_day(client_id, day_of_week, exercises):
    """Upsert exercises for one day (list of dicts)."""
    conn = get_db()
    existing = conn.execute(
        "SELECT id FROM workout_days WHERE client_id=? AND day_of_week=?",
        (client_id, day_of_week),
    ).fetchone()
    data = json.dumps(exercises)
    if existing:
        conn.execute(
            "UPDATE workout_days SET exercises=? WHERE id=?",
            (data, existing["id"]),
        )
    else:
        conn.execute(
            "INSERT INTO workout_days (client_id, day_of_week, exercises) VALUES (?,?,?)",
            (client_id, day_of_week, data),
        )
    conn.commit()
    conn.close()


def get_todays_workouts():
    """Return list of {client, exercises} for clients who have a workout today."""
    import datetime
    today_dow = datetime.date.today().weekday()  # 0=Mon
    clients = get_all_clients()
    result = []
    for client in clients:
        program = get_program(client["id"])
        exercises = program.get(today_dow, [])
        if exercises:
            result.append({"client": client, "exercises": exercises, "day": today_dow})
    return result
