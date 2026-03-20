"""SQLite key-value store and iCal helpers for Programming Machine."""

import json
import os
import sqlite3

DATABASE_PATH = os.environ.get("DATABASE_PATH", "/tmp/pm.db")


def get_db():
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS kv (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL DEFAULT 'null'
        )
    """)
    conn.commit()
    conn.close()


def kv_get(key, fallback=None):
    conn = get_db()
    row = conn.execute("SELECT value FROM kv WHERE key = ?", (key,)).fetchone()
    conn.close()
    if row is None:
        return fallback
    try:
        return json.loads(row["value"])
    except Exception:
        return fallback


def kv_set(key, value):
    conn = get_db()
    conn.execute(
        "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, json.dumps(value)),
    )
    conn.commit()
    conn.close()
