"""WSGI entry point for production deployment (gunicorn)."""

import os
import tempfile
from calendar_sync.web.app import create_app

# If CONFIG_YAML env var is set, write it to a temp file so the app can load it.
# This allows configuration on platforms like Render where there is no persistent filesystem.
_config_path = os.environ.get("CONFIG_PATH", "config.yaml")

config_yaml = os.environ.get("CONFIG_YAML", "")
if config_yaml:
    _tmp = tempfile.NamedTemporaryFile(
        mode="w", suffix=".yaml", delete=False, prefix="calendar_sync_config_"
    )
    _tmp.write(config_yaml)
    _tmp.close()
    _config_path = _tmp.name

app = create_app(config_path=_config_path)
