"""Decide whether a Pages run should refresh prices and send daily notifications."""
import os
from datetime import datetime, time, timezone
from zoneinfo import ZoneInfo

DAILY_SCHEDULE = "25 22 * * 1-5"


def is_market_open(now):
    import exchange_calendars

    calendar = exchange_calendars.get_calendar("XNYS")
    minute = now.astimezone(timezone.utc).replace(second=0, microsecond=0)
    return calendar.is_open_on_minute(minute)


def refresh_plan(event_name, schedule="", now=None):
    now = now or datetime.now(timezone.utc)
    if event_name == "schedule":
        if schedule == DAILY_SCHEDULE:
            return True, True
        return is_market_open(now), False
    # Manual runs and pushes can publish at any time, but daily alerts wait for the close buffer.
    market_time = now.astimezone(ZoneInfo("America/New_York"))
    return True, market_time.time() >= time(17)


def main():
    refresh, notify = refresh_plan(os.environ["GITHUB_EVENT_NAME"], os.environ.get("REFRESH_SCHEDULE", ""))
    print(f"refresh={str(bool(refresh)).lower()}")
    print(f"notify={str(bool(notify)).lower()}")


if __name__ == "__main__":
    main()
