"""Prepare completed daily prices and Wilder RSI for the static dashboard."""
import argparse
import json
import math
import random
import sys
import time
from datetime import date, datetime, time as clock_time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
STOCKS = [
    ("KO", "Coca-Cola", "Tarbekaubad"),
    ("PEP", "PepsiCo", "Tarbekaubad"),
    ("JNJ", "Johnson & Johnson", "Tervishoid"),
    ("PG", "Procter & Gamble", "Tarbekaubad"),
    ("CL", "Colgate-Palmolive", "Tarbekaubad"),
]


def calculate_rsi(prices, period=14):
    """Seed with simple averages, then apply Wilder's recursive smoothing."""
    if period < 1:
        raise ValueError("Period must be positive.")
    if any(not math.isfinite(price) or price <= 0 for price in prices):
        raise ValueError("Prices must be finite and positive.")
    result = [None] * len(prices)
    if len(prices) <= period:
        return result
    changes = [prices[index] - prices[index - 1] for index in range(1, len(prices))]
    average_gain = sum(max(change, 0) for change in changes[:period]) / period
    average_loss = sum(max(-change, 0) for change in changes[:period]) / period

    def value():
        if average_gain == 0 and average_loss == 0:
            return 50.0
        if average_loss == 0:
            return 100.0
        return 100 - 100 / (1 + average_gain / average_loss)

    result[period] = value()
    for index in range(period + 1, len(prices)):
        change = changes[index - 1]
        average_gain = (average_gain * (period - 1) + max(change, 0)) / period
        average_loss = (average_loss * (period - 1) + max(-change, 0)) / period
        result[index] = value()
    return result


def latest_completed_date(now=None):
    """Wait until 17:00 New York time, including a buffer after the close."""
    market_time = (now or datetime.now(timezone.utc)).astimezone(ZoneInfo("America/New_York"))
    if market_time.time() < clock_time(17):
        return market_time.date() - timedelta(days=1)
    return market_time.date()


def make_history(rows):
    rows = sorted(rows, key=lambda row: row[0])
    if len(rows) < 200:
        raise ValueError("At least 200 daily observations are required.")
    if len({row[0] for row in rows}) != len(rows):
        raise ValueError("Duplicate trading dates.")
    if any(len(row) > 2 and (not math.isfinite(row[2]) or row[2] <= 0) for row in rows):
        raise ValueError("Market closing prices must be finite and positive.")
    prices = [row[1] for row in rows]
    rsi_values = calculate_rsi(prices)
    return [
        {"date": row[0].isoformat(), "close": round(row[1], 4), "quote_close": round(row[2] if len(row) > 2 else row[1], 4), "rsi": round(rsi, 4) if rsi is not None else None}
        for row, rsi in zip(rows, rsi_values)
    ]


def download_history(symbol, cutoff):
    import yfinance as yf

    error = None
    for attempt in range(3):
        try:
            frame = yf.Ticker(symbol).history(period="2y", interval="1d", auto_adjust=False, actions=False)
            rows = []
            for timestamp, row in frame.iterrows():
                trading_date = timestamp.date()
                if trading_date > cutoff:
                    continue
                try:
                    adjusted_close = float(row["Adj Close"])
                    quote_close = float(row["Close"])
                except (TypeError, ValueError):
                    adjusted_close = quote_close = math.nan
                # Yahoo can return missing prices among otherwise valid daily bars.
                if not all(math.isfinite(price) and price > 0 for price in (adjusted_close, quote_close)):
                    print(
                        f"{symbol}: skipping invalid prices for {trading_date}: "
                        f"Adj Close={row['Adj Close']!r}, Close={row['Close']!r}",
                        file=sys.stderr,
                    )
                    continue
                rows.append((trading_date, adjusted_close, quote_close))
            history = make_history(rows)
            if (cutoff - date.fromisoformat(history[-1]["date"])).days > 7:
                raise ValueError("Latest price is more than seven days old.")
            return history
        except Exception as exc:
            error = exc
            if attempt < 2:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"{symbol}: could not download valid daily prices: {error}")


def demo_history(index, cutoff):
    """Deterministic synthetic prices, never presented as market observations."""
    generator = random.Random(42 + index)
    price = [68, 150, 160, 155, 90][index]
    rows = []
    for offset in range(730, -1, -1):
        day = cutoff - timedelta(days=offset)
        if day.weekday() >= 5:
            continue
        drift = math.sin(offset / 15 + index) * 0.002
        price *= 1 + drift + generator.gauss(0.00015, 0.008)
        rows.append((day, price))
    return make_history(rows)


def build_payload(demo=False):
    cutoff = date.today() - timedelta(days=1) if demo else latest_completed_date()
    stocks = []
    for index, (symbol, name, sector) in enumerate(STOCKS):
        history = demo_history(index, cutoff) if demo else download_history(symbol, cutoff)
        stocks.append({"symbol": symbol, "name": name, "sector": sector, "history": history})
        print(f"{symbol}: {len(history)} days through {history[-1]['date']}")
    return {
        "schema_version": 1,
        "mode": "demo" if demo else "live",
        "source": "Synthetic demonstration" if demo else "Yahoo Finance via yfinance",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "price_basis": "adjusted_close",
        "rsi_period": 14,
        "stocks": stocks,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--demo", action="store_true", help="Generate clearly labelled synthetic data.")
    parser.add_argument("--output", type=Path, default=ROOT / "data" / "stocks.json")
    args = parser.parse_args()
    try:
        # Download everything before replacing the existing snapshot.
        payload = build_payload(args.demo)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.output.with_suffix(".tmp")
        temporary.write_text(json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n", encoding="utf-8")
        temporary.replace(args.output)
    except Exception as error:
        print(f"Data refresh failed; existing snapshot was not replaced: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
