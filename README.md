# Calendar Sync Integration

A Python application to synchronize events across multiple calendar services (Google Calendar, Outlook/Exchange, CalDAV, and iCalendar feeds).

## Features

- **Multi-provider support**: Google Calendar, Microsoft Outlook (Exchange/Graph API), CalDAV, and iCal URL feeds
- **Bidirectional sync**: Push and pull events between calendar providers
- **Conflict resolution**: Configurable strategies for handling event conflicts
- **Filtering**: Sync specific calendars, date ranges, or event categories
- **Dry-run mode**: Preview changes before applying them
- **Scheduling**: Run syncs automatically on a configurable schedule

## Installation

```bash
pip install -r requirements.txt
```

## Configuration

Copy `config.example.yaml` to `config.yaml` and fill in your credentials:

```yaml
providers:
  google:
    credentials_file: credentials.json
    calendar_ids:
      - primary
  outlook:
    client_id: your-client-id
    client_secret: your-client-secret
    calendar_ids:
      - Calendar

sync_rules:
  - source: google:primary
    target: outlook:Calendar
    direction: bidirectional
    lookback_days: 30
    lookahead_days: 90
```

## Usage

```bash
# Run a sync
python -m calendar_sync sync

# Dry run (preview changes only)
python -m calendar_sync sync --dry-run

# Sync a specific rule
python -m calendar_sync sync --rule "google-to-outlook"

# List configured providers and calendars
python -m calendar_sync list

# Run as a daemon with scheduling
python -m calendar_sync daemon --interval 15m
```

## Providers

### Google Calendar
Requires a Google Cloud project with Calendar API enabled. Download `credentials.json` from the Cloud Console.

### Microsoft Outlook (Graph API)
Requires an Azure AD app registration with `Calendars.ReadWrite` permission.

### CalDAV
Works with Nextcloud, Fastmail, iCloud, and any CalDAV-compatible server.

### iCal URL
Read-only sync from public or private `.ics` URLs.

## Architecture

```
calendar_sync/
├── providers/          # Calendar provider integrations
│   ├── base.py         # Abstract base provider
│   ├── google.py       # Google Calendar API
│   ├── outlook.py      # Microsoft Graph API
│   ├── caldav.py       # CalDAV protocol
│   └── ical.py         # iCalendar URL feeds
├── sync/               # Sync engine
│   ├── engine.py       # Core sync logic
│   ├── conflict.py     # Conflict resolution
│   └── diff.py         # Event diff/comparison
├── models.py           # Unified event model
├── config.py           # Configuration loading
└── cli.py              # Command-line interface
```
