"""WSGI entry point for production deployment (gunicorn)."""

from programming_machine.web.app import create_app

app = create_app()
