"""Command-line interface for calendar sync."""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Optional

import click

from .config import load_config
from .providers import GoogleCalendarProvider, OutlookCalendarProvider, CalDAVProvider, ICalProvider
from .sync.engine import SyncEngine


def setup_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )


def build_providers(config) -> dict:
    providers = {}

    google = config.get_google()
    if google:
        providers["google"] = GoogleCalendarProvider(
            credentials_file=google.credentials_file,
            token_file=google.token_file,
        )

    outlook = config.get_outlook()
    if outlook:
        providers["outlook"] = OutlookCalendarProvider(
            client_id=outlook.client_id,
            client_secret=outlook.client_secret,
            tenant_id=outlook.tenant_id,
        )

    caldav = config.get_caldav()
    if caldav:
        providers["caldav"] = CalDAVProvider(
            url=caldav.url,
            username=caldav.username,
            password=caldav.password,
            calendar_paths=caldav.calendar_paths,
        )

    ical = config.get_ical()
    if ical:
        providers["ical"] = ICalProvider(
            feeds=[{"name": f.name, "url": f.url} for f in ical.feeds],
        )

    return providers


@click.group()
@click.option("--config", "-c", default="config.yaml", help="Path to configuration file")
@click.option("--dry-run", is_flag=True, help="Preview changes without applying them")
@click.pass_context
def cli(ctx, config: str, dry_run: bool):
    """Calendar Sync Integration - synchronize events across calendar providers."""
    ctx.ensure_object(dict)
    ctx.obj["config_path"] = config
    ctx.obj["dry_run"] = dry_run


@cli.command()
@click.option("--rule", "-r", multiple=True, help="Run only specific rule(s) by name")
@click.pass_context
def sync(ctx, rule):
    """Synchronize calendars according to configured rules."""
    config_path = ctx.obj["config_path"]
    dry_run = ctx.obj["dry_run"]

    try:
        config = load_config(config_path)
    except FileNotFoundError as e:
        click.echo(f"Error: {e}", err=True)
        click.echo("Copy config.example.yaml to config.yaml and fill in your credentials.", err=True)
        sys.exit(1)

    setup_logging(config.options.log_level)

    effective_dry_run = dry_run or config.options.dry_run
    if effective_dry_run:
        click.echo("Running in dry-run mode (no changes will be applied)")

    providers = build_providers(config)
    engine = SyncEngine(
        providers=providers,
        state_file=config.options.state_file,
        dry_run=effective_dry_run,
    )

    rules_to_run = config.sync_rules
    if rule:
        rule_names = set(rule)
        rules_to_run = [r for r in rules_to_run if r.name in rule_names]
        missing = rule_names - {r.name for r in rules_to_run}
        if missing:
            click.echo(f"Warning: Rules not found: {', '.join(missing)}", err=True)

    if not rules_to_run:
        click.echo("No sync rules to run.")
        return

    total_errors = 0
    for sync_rule in rules_to_run:
        click.echo(f"Running rule: {sync_rule.name}")
        result = engine.sync_rule(sync_rule)
        click.echo(f"  {result}")
        total_errors += len(result.errors)

    if total_errors:
        sys.exit(1)


@cli.command(name="list")
@click.pass_context
def list_calendars(ctx):
    """List all configured providers and their available calendars."""
    config_path = ctx.obj["config_path"]

    try:
        config = load_config(config_path)
    except FileNotFoundError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)

    setup_logging("WARNING")
    providers = build_providers(config)

    if not providers:
        click.echo("No providers configured.")
        return

    for name, provider in providers.items():
        click.echo(f"\nProvider: {name}")
        try:
            calendars = provider.list_calendars()
            for cal in calendars:
                click.echo(f"  - {cal['name']} (id: {cal['id']})")
        except Exception as e:
            click.echo(f"  Error listing calendars: {e}")


@cli.command()
@click.option("--interval", "-i", default="15m", help="Sync interval (e.g. 5m, 1h, 30m)")
@click.pass_context
def daemon(ctx, interval: str):
    """Run sync continuously on a schedule."""
    try:
        import schedule
        import time
    except ImportError:
        click.echo("Install the 'schedule' package to use daemon mode: pip install schedule", err=True)
        sys.exit(1)

    seconds = _parse_interval(interval)
    click.echo(f"Starting daemon, syncing every {interval}...")

    def run_sync():
        ctx.invoke(sync)

    run_sync()  # Initial sync
    schedule.every(seconds).seconds.do(run_sync)

    try:
        while True:
            schedule.run_pending()
            import time
            time.sleep(10)
    except KeyboardInterrupt:
        click.echo("\nDaemon stopped.")


def _parse_interval(interval: str) -> int:
    """Parse interval string like '15m', '1h', '30s' into seconds."""
    interval = interval.strip().lower()
    if interval.endswith("h"):
        return int(interval[:-1]) * 3600
    elif interval.endswith("m"):
        return int(interval[:-1]) * 60
    elif interval.endswith("s"):
        return int(interval[:-1])
    else:
        return int(interval)


def main():
    cli(obj={})


if __name__ == "__main__":
    main()
