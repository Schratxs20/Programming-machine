"""WSGI entry point for production deployment (gunicorn)."""

import os
from calendar_sync.web.app import create_app

app = create_app(config_path=os.environ.get("CONFIG_PATH", "config.yaml"))
