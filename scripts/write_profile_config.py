"""Publish only the public profile API address; credentials stay in secrets."""
import argparse
import json
import os
from pathlib import Path
from urllib.parse import urlsplit


def validate_api_url(value):
    if not value:
        return ""
    url = urlsplit(value)
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ("", "/"):
        raise ValueError("PROFILE_API_URL peab olema HTTPS-teenuse juuraadress.")
    return value.rstrip("/")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    api_url = validate_api_url(os.environ.get("PROFILE_API_URL", "").strip())
    args.output.write_text(json.dumps({"api_url": api_url}) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
