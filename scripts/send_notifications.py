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

if __package__:
    from .signals import is_candidate, validate_settings
    from .write_profile_config import validate_api_url
else:
    from signals import is_candidate, validate_settings
    from write_profile_config import validate_api_url

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SITE_URL = "https://karlreispass.github.io/stock-radar/"


def find_signals(data, today=None, settings=None):
    today = today or datetime.now(timezone.utc).date()
    if data.get("mode") != "live" or data.get("rsi_period") != 14:
        raise ValueError("Teavitusteks on vaja pärisandmeid ja RSI perioodi 14.")
    if not isinstance(data.get("stocks"), list) or not data["stocks"]:
        raise ValueError("Aktsiate andmed puuduvad.")
    enabled = settings["events"] if settings else {kind: True for kind in ("watch", "candidate", "target", "oversold", "recovery")}
    targets = settings["targets"] if settings else {}
    events, seen_symbols = [], set()
    for stock in data["stocks"]:
        symbol = stock["symbol"]
        if not isinstance(symbol, str) or not re.fullmatch(r"[A-Za-z0-9._-]+", symbol) or symbol in seen_symbols:
            raise ValueError("Aktsiate sümbolid peavad olema korrektsed ja unikaalsed.")
        seen_symbols.add(symbol)
        history = stock["history"]
        if len(history) < 2:
            raise ValueError("Teavituseks on vaja vähemalt kahte kauplemispäeva.")
        previous_day = None
        for point in history:
            point_day = date.fromisoformat(point["date"])
            if previous_day is not None and point_day <= previous_day:
                raise ValueError("Kauplemispäevad ei ole õiges järjestuses.")
            previous_day = point_day
            price = point["close"]
            rsi = point["rsi"]
            if type(price) not in (int, float) or not math.isfinite(price) or price <= 0:
                raise ValueError("Sulgemishind on vigane.")
            if rsi is not None and (type(rsi) not in (int, float) or not math.isfinite(rsi) or not 0 <= rsi <= 100):
                raise ValueError("RSI väärtus on vigane.")
        previous, latest = history[-2:]
        day = date.fromisoformat(latest["date"])
        if previous["rsi"] is None or latest["rsi"] is None:
            raise ValueError("Viimaste päevade RSI väärtused on vigased.")
        if not 0 <= (today - day).days <= 4:
            continue
        kinds = []
        if previous["rsi"] >= 40 and latest["rsi"] < 40:
            kinds.append("watch")
        if previous["rsi"] >= 30 and latest["rsi"] < 30:
            kinds.append("oversold")
        if previous["rsi"] < 30 and latest["rsi"] >= 30:
            kinds.append("recovery")
        if is_candidate(history, len(history) - 1) and not is_candidate(history, len(history) - 2):
            kinds.append("candidate")
        target = targets.get(symbol)
        previous_quote, quote = previous.get("quote_close"), latest.get("quote_close")
        if target is not None and all(type(value) in (int, float) and math.isfinite(value) and value > 0 for value in (previous_quote, quote)):
            if previous_quote > target >= quote:
                kinds.append("target")
        for kind in kinds:
            if enabled[kind]:
                events.append({
                    "symbol": symbol, "name": stock["name"], "date": day.isoformat(),
                    "close": latest["close"], "quote_close": quote,
                    "previous_rsi": previous["rsi"], "rsi": latest["rsi"], "kind": kind, "target": target,
                })
    return events


def day_marker(day):
    return f"<!-- stock-radar:rsi-day:v1:{day} -->"


def event_marker(event):
    target = f":{event['target']:g}" if event["kind"] == "target" else ""
    profile = ":" + event["profile_id"] if event.get("profile_id") else ""
    return f"<!-- stock-radar:rsi-event:v1:{event['date']}:{event['symbol']}:{event['kind']}{target}{profile} -->"


def create_issue_body(events, site_url):
    labels = {
        "watch": "RSI langes alla 40 · jälgimisala",
        "oversold": "RSI langes alla 30",
        "recovery": "RSI taastus vähemalt 30 peale",
        "candidate": "Võimalik ostukandidaat · kolm tingimust täidetud",
        "target": "Sihthind saavutatud päeva sulgemisel",
    }
    lines = [
        day_marker(events[0]["date"]), "## Uued aktsiasignaalid", "",
        "| Profiil | Ettevõte | Signaal | RSI (14) | Korrigeeritud hind |",
        "| --- | --- | --- | --- | --- |",
    ]
    for event in events:
        label = labels[event["kind"]]
        if event["kind"] == "target":
            label += f" · siht {event['target']:.2f}, korrigeerimata sulgemishind {event['quote_close']:.2f} USD"
        lines.append(
            f"| {event.get('profile_name', 'Ühine')} | {event['name']} ({event['symbol']}) | {label} | "
            f"{event['previous_rsi']:.2f} → {event['rsi']:.2f} | {event['close']:.2f} USD |"
        )
    lines.extend([
        "", "Kauplemispäev: **" + events[0]["date"] + "**.", "",
        "[Vaata graafikuid](" + site_url + ")", "",
        "Ostukandidaat: RSI oli viimase viie kauplemispäeva jooksul alla 40, RSI on kõrgem kui viis kauplemispäeva tagasi ning hind ületas viimasel päeval 20 päeva keskmise.",
        "Signaal põhineb lõppenud kauplemispäevadel. Sihthind ei tähenda maaklerile saadetud orderit. Madal RSI ei kinnita hinnapõhja ega taga tootlust.", "",
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
            "title": "Aktsiasignaalid · " + day,
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


def notification_credentials():
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    token = os.environ.get("GITHUB_TOKEN", "")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("GITHUB_REPOSITORY peab olema kujul omanik/repo.")
    if not token.strip():
        raise ValueError("GITHUB_TOKEN puudub. Actions annab selle automaatselt.")
    return repository, token


def publish_health(message, fingerprint, repository, token):
    """One persistent health Issue, with each distinct condition reported once."""
    marker = "<!-- stock-radar:health:v1 -->"
    event = "<!-- stock-radar:health-event:" + fingerprint + " -->"
    issue_path = f"/repos/{repository}/issues"
    body = marker + "\n\n" + message + "\n\n" + event
    for issue in github_pages(issue_path, token, {"state": "all"}):
        if "pull_request" in issue or marker not in (issue.get("body") or ""):
            continue
        comment_path = issue_path + f"/{issue['number']}/comments"
        bodies = [issue.get("body") or ""]
        bodies.extend(comment.get("body") or "" for comment in github_pages(comment_path, token))
        if any(event in text for text in bodies):
            return False
        if issue.get("state") == "closed":
            github_request("PATCH", issue_path + f"/{issue['number']}", token, {"state": "open"})
        github_request("POST", comment_path, token, {"body": body})
        return True
    github_request("POST", issue_path, token, {"title": "Stock Radar · andmete ja avaldamise tervis", "body": body})
    return True


def stale_snapshot(data, today=None):
    today = today or datetime.now(timezone.utc).date()
    dates = sorted(stock["history"][-1]["date"] for stock in data["stocks"])
    oldest = date.fromisoformat(dates[0])
    if (today - oldest).days <= 4:
        return None
    fingerprint = "stale-" + oldest.isoformat()
    message = "Päevaandmed võivad olla aegunud. Vanim viimane kauplemispäev: **" + oldest.isoformat() + "**. Uusi ostuteavitusi aegunud andmetest ei saadeta. Kontrolli Actionsi viimast käivitust."
    return message, fingerprint


def load_remote_profiles():
    """No configuration means legacy mode; partial/broken configuration is an error."""
    api_url = os.environ.get("PROFILE_API_URL", "").strip()
    api_token = os.environ.get("PROFILE_API_TOKEN", "").strip()
    if not api_url and not api_token:
        return None
    if not api_url or len(api_token) < 32:
        raise ValueError("Profiiliteenus vajab PROFILE_API_URL muutujat ja vähemalt 32 märgiga PROFILE_API_TOKEN saladust.")
    api_url = validate_api_url(api_url)
    request = Request(api_url + "/v1/profiles", headers={"Authorization": "Bearer " + api_token, "Accept": "application/json", "User-Agent": "stock-radar"})
    try:
        with urlopen(request, timeout=30) as response:
            raw = response.read(65537)
        if len(raw) > 65536:
            raise ValueError("Profiiliteenuse vastus on liiga suur.")
        payload = json.loads(raw)
    except HTTPError as error:
        error.close()
        raise ValueError(f"Profiiliteenus tagastas HTTP {error.code}. Kontrolli teenuse seadistust.") from None
    except (OSError, json.JSONDecodeError):
        raise ValueError("Profiiliteenuse lugemine ebaõnnestus. Vanade valikutega teavitusi ei saadeta.") from None
    profiles = payload.get("profiles") if isinstance(payload, dict) else None
    if not isinstance(profiles, list) or len(profiles) != 3:
        raise ValueError("Profiiliteenuse vastuses peab olema kolm profiili.")
    seen = set()
    for profile in profiles:
        if not isinstance(profile, dict) or profile.get("id") not in {"user-1", "user-2", "user-3"} or profile["id"] in seen or type(profile.get("enabled")) is not bool:
            raise ValueError("Profiiliteenuse profiilid ei sobi.")
        seen.add(profile["id"])
        validate_settings(profile["settings"])
        profile["name"] = "Kasutaja " + profile["id"][-1]
    return profiles


def configured_signals(data, settings):
    profiles = load_remote_profiles()
    if profiles is None:
        return find_signals(data, settings=settings), settings["health_alerts"]
    events = []
    health_alerts = False
    for profile in profiles:
        if not profile["enabled"]:
            continue
        health_alerts = health_alerts or profile["settings"]["health_alerts"]
        for event in find_signals(data, settings=profile["settings"]):
            events.append({**event, "profile_id": profile["id"], "profile_name": profile["name"]})
    return events, health_alerts


def run(data_path, dry_run=False, settings_path=None, failure=False):
    settings_path = settings_path or ROOT / "settings.json"
    settings = validate_settings(json.loads(settings_path.read_text(encoding="utf-8")))
    if failure:
        if not settings["health_alerts"]:
            return
        today = datetime.now(timezone.utc).date().isoformat()
        message = "Andmete uuendamine või lehe avaldamine ebaõnnestus. Veebis võib olla eelmine andmefail. Kontrolli repo Actionsi ebaõnnestunud käivitust."
        if dry_run:
            print(message)
        else:
            repository, token = notification_credentials()
            publish_health(message, "workflow-failure-" + today, repository, token)
        return
    data = json.loads(data_path.read_text(encoding="utf-8"))
    if data.get("mode") == "demo":
        print("Näidisandmetest GitHubi teavitusi ei looda.")
        return
    events, health_enabled = configured_signals(data, settings)
    health = stale_snapshot(data) if health_enabled else None
    if not events and not health:
        print("Uusi signaale ei ole; GitHubi teavitusi ei loodud.")
        return
    site_url = os.environ.get("SITE_URL") or DEFAULT_SITE_URL
    grouped = {}
    for event in events:
        grouped.setdefault(event["date"], []).append(event)
    if dry_run:
        if health:
            print(health[0])
        for day, daily_events in sorted(grouped.items()):
            print("Aktsiasignaalid · " + day)
            print(create_issue_body(daily_events, site_url))
        return
    repository, token = notification_credentials()
    if health:
        publish_health(*health, repository, token)
    for day, daily_events in sorted(grouped.items()):
        changed = publish_day(daily_events, repository, token, site_url)
        print(day + (": teavitus lisatud GitHubi." if changed else ": kõik signaalid on juba avaldatud."))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=ROOT / "data" / "stocks.json")
    parser.add_argument("--settings", type=Path, default=ROOT / "settings.json")
    parser.add_argument("--failure", action="store_true", help="Report a failed refresh or deployment.")
    parser.add_argument("--dry-run", action="store_true", help="Preview without calling GitHub or creating Issues.")
    args = parser.parse_args()
    try:
        run(args.data, args.dry_run, args.settings, args.failure)
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
