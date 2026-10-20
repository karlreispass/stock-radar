"""Publish new RSI crossings as daily GitHub Issues using the Actions token."""
import argparse
import json
import math
import os
import re
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SITE_URL = "https://karlreispass.github.io/stock-radar/"


def find_signals(data, today=None):
    today = today or datetime.now(timezone.utc).date()
    if data.get("mode") != "live" or data.get("rsi_period") != 14:
        raise ValueError("Teavitusteks on vaja pärisandmeid ja RSI perioodi 14.")
    if not isinstance(data.get("stocks"), list) or not data["stocks"]:
        raise ValueError("Aktsiate andmed puuduvad.")
    events = []
    seen_symbols = set()
    for stock in data["stocks"]:
        symbol = stock["symbol"]
        if not isinstance(symbol, str) or not re.fullmatch(r"[A-Za-z0-9._-]+", symbol) or symbol in seen_symbols:
            raise ValueError("Aktsiate sümbolid peavad olema korrektsed ja unikaalsed.")
        seen_symbols.add(symbol)
        if len(stock["history"]) < 2:
            raise ValueError("Teavituseks on vaja vähemalt kahte kauplemispäeva.")
        previous, latest = stock["history"][-2:]
        day = date.fromisoformat(latest["date"])
        if date.fromisoformat(previous["date"]) >= day:
            raise ValueError("Kauplemispäevad ei ole õiges järjestuses.")
        for value in [previous["rsi"], latest["rsi"]]:
            if not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 100:
                raise ValueError("Viimaste päevade RSI väärtused on vigased.")
        if not isinstance(latest["close"], (int, float)) or not math.isfinite(latest["close"]) or latest["close"] <= 0:
            raise ValueError("Viimane sulgemishind on vigane.")
        if not 0 <= (today - day).days <= 4:
            continue
        if previous["rsi"] >= 30 and latest["rsi"] < 30:
            kind = "oversold"
        elif previous["rsi"] < 30 and latest["rsi"] >= 30:
            kind = "recovery"
        else:
            continue
        events.append({
            "symbol": symbol, "name": stock["name"], "date": day.isoformat(),
            "close": latest["close"], "previous_rsi": previous["rsi"], "rsi": latest["rsi"], "kind": kind,
        })
    return events


def day_marker(day):
    return f"<!-- stock-radar:rsi-day:v1:{day} -->"


def event_marker(event):
    return f"<!-- stock-radar:rsi-event:v1:{event['date']}:{event['symbol']}:{event['kind']} -->"


def create_issue_body(events, site_url):
    lines = [
        day_marker(events[0]["date"]),
        "## Uued RSI-signaalid",
        "",
        "| Ettevõte | Signaal | RSI (14) | Korrigeeritud hind |",
        "| --- | --- | --- | --- |",
    ]
    for event in events:
        label = "RSI langes alla 30" if event["kind"] == "oversold" else "RSI taastus vähemalt 30 peale"
        lines.append(
            f"| {event['name']} ({event['symbol']}) | {label} | "
            f"{event['previous_rsi']:.2f} → {event['rsi']:.2f} | {event['close']:.2f} USD |"
        )
    lines.extend([
        "",
        "Kauplemispäev: **" + events[0]["date"] + "**.",
        "",
        "[Vaata graafikuid](" + site_url + ")",
        "",
        "Signaal põhineb lõppenud kauplemispäevadel. Madal RSI ei kinnita hinnapõhja ega taga tootlust.",
        "",
    ])
    lines.extend(event_marker(event) for event in events)
    return "\n".join(lines)


def github_request(method, path, token, payload=None):
    api_url = (os.environ.get("GITHUB_API_URL") or "https://api.github.com").rstrip("/")
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": "Bearer " + token,
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "stock-radar",
    }
    body = None
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = Request(api_url + path, data=body, headers=headers, method=method)
    with urlopen(request, timeout=30) as response:
        return json.load(response)


def github_pages(path, token, parameters=None):
    page = 1
    while True:
        query = {**(parameters or {}), "per_page": 100, "page": page}
        items = github_request("GET", path + "?" + urlencode(query), token)
        if not isinstance(items, list):
            raise ValueError("GitHubi loendipäringu vastus on vigane.")
        yield from items
        if len(items) < 100:
            return
        page += 1


def publish_day(events, repository, token, site_url):
    day = events[0]["date"]
    issue_path = f"/repos/{repository}/issues"
    existing = None
    # Include closed Issues so closing an alert does not create a duplicate.
    for issue in github_pages(issue_path, token, {"state": "all", "since": day + "T00:00:00Z"}):
        if "pull_request" not in issue and day_marker(day) in (issue.get("body") or ""):
            existing = issue
            break
    if existing is None:
        github_request("POST", issue_path, token, {
            "title": "RSI-signaalid · " + day,
            "body": create_issue_body(events, site_url),
        })
        return True
    comment_path = issue_path + f"/{existing['number']}/comments"
    known_bodies = [existing.get("body") or ""]
    for comment in github_pages(comment_path, token):
        known_bodies.append(comment.get("body") or "")
    history = "\n".join(known_bodies)
    pending = [event for event in events if event_marker(event) not in history]
    if not pending:
        return False
    # New same-day signals are comments: watchers can receive a new notification.
    github_request("POST", comment_path, token, {"body": create_issue_body(pending, site_url)})
    return True


def run(data_path, dry_run=False):
    data = json.loads(data_path.read_text(encoding="utf-8"))
    if data.get("mode") == "demo":
        print("Näidisandmetest GitHubi teavitusi ei looda.")
        return
    events = find_signals(data)
    if not events:
        print("Uusi RSI-signaale ei ole; GitHubi teavitusi ei loodud.")
        return
    site_url = os.environ.get("SITE_URL") or DEFAULT_SITE_URL
    grouped = {}
    for event in events:
        grouped.setdefault(event["date"], []).append(event)
    if dry_run:
        for day, daily_events in sorted(grouped.items()):
            print("RSI-signaalid · " + day)
            print(create_issue_body(daily_events, site_url))
        return
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    token = os.environ.get("GITHUB_TOKEN", "")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("GITHUB_REPOSITORY peab olema kujul omanik/repo.")
    if not token.strip():
        raise ValueError("GITHUB_TOKEN puudub. Actions annab selle automaatselt.")
    for day, daily_events in sorted(grouped.items()):
        changed = publish_day(daily_events, repository, token, site_url)
        print(day + (": teavitus lisatud GitHubi." if changed else ": kõik signaalid on juba avaldatud."))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=ROOT / "data" / "stocks.json")
    parser.add_argument("--dry-run", action="store_true", help="Preview without calling GitHub or creating Issues.")
    args = parser.parse_args()
    try:
        run(args.data, args.dry_run)
    except HTTPError as error:
        error.close()
        print(
            f"GitHubi teavitused ebaõnnestusid (HTTP {error.code}). "
            "Kontrolli, et repos oleks Issues lubatud ja notify tööl issues: write õigus.",
            file=sys.stderr,
        )
        return 1
    except ValueError as error:
        print(f"GitHubi teavituste viga: {error}", file=sys.stderr)
        return 1
    except (OSError, KeyError, TypeError) as error:
        # Do not log tokens, request headers, or private API response bodies.
        print(f"GitHubi teavitused ebaõnnestusid ({type(error).__name__}).", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
