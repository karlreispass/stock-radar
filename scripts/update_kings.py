"""Download latest prices and Wilder RSI (14) for US Dividend Kings (50+ years of dividend growth)."""
import argparse
import json
import math
import random
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen

if __package__:
    from .update_data import make_history
else:
    from update_data import make_history

ROOT = Path(__file__).resolve().parents[1]

# US Dividend Kings: companies with 50+ consecutive years of dividend increases.
DIVIDEND_KINGS = [
    ("KO", "Coca-Cola", "Tarbekaubad", 64, "NYSE:KO"),
    ("PEP", "PepsiCo", "Tarbekaubad", 54, "NASDAQ:PEP"),
    ("JNJ", "Johnson & Johnson", "Tervishoid", 64, "NYSE:JNJ"),
    ("PG", "Procter & Gamble", "Tarbekaubad", 70, "NYSE:PG"),
    ("CL", "Colgate-Palmolive", "Tarbekaubad", 63, "NYSE:CL"),
    ("ABBV", "AbbVie", "Tervishoid", 54, "NYSE:ABBV"),
    ("ABT", "Abbott Laboratories", "Tervishoid", 54, "NYSE:ABT"),
    ("MCD", "McDonald's", "Tarbijateenused", 50, "NYSE:MCD"),
    ("WMT", "Walmart", "Jaekaubandus", 53, "NYSE:WMT"),
    ("LOW", "Lowe's", "Jaekaubandus", 63, "NYSE:LOW"),
    ("TGT", "Target", "Jaekaubandus", 58, "NYSE:TGT"),
    ("KMB", "Kimberly-Clark", "Tarbekaubad", 54, "NASDAQ:KMB"),
    ("SYY", "Sysco", "Tarbekaubad", 56, "NYSE:SYY"),
    ("HRL", "Hormel Foods", "Tarbekaubad", 60, "NYSE:HRL"),
    ("ADM", "Archer-Daniels-Midland", "Tarbekaubad", 51, "NYSE:ADM"),
    ("GPC", "Genuine Parts", "Tööstus", 70, "NYSE:GPC"),
    ("EMR", "Emerson Electric", "Tööstus", 69, "NYSE:EMR"),
    ("ITW", "Illinois Tool Works", "Tööstus", 63, "NYSE:ITW"),
    ("DOV", "Dover", "Tööstus", 70, "NYSE:DOV"),
    ("PH", "Parker-Hannifin", "Tööstus", 70, "NYSE:PH"),
    ("ADP", "Automatic Data Processing", "Tehnoloogia", 51, "NASDAQ:ADP"),
    ("SPGI", "S&P Global", "Finants", 53, "NYSE:SPGI"),
    ("CINF", "Cincinnati Financial", "Finants", 65, "NASDAQ:CINF"),
    ("ED", "Consolidated Edison", "Kommunaal", 52, "NYSE:ED"),
    ("FRT", "Federal Realty", "Kinnisvara", 58, "NYSE:FRT"),
]


def download_king_history(symbol):
    """Download 2y daily bars including today's latest market price using stdlib urllib."""
    error = None
    hosts = ["https://query2.finance.yahoo.com", "https://query1.finance.yahoo.com"]
    for attempt in range(3):
        for host in hosts:
            try:
                url = f"{host}/v8/finance/chart/{quote(symbol)}?interval=1d&range=2y&includeAdjustedClose=true"
                req = Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
                with urlopen(req, timeout=15) as resp:
                    payload = json.loads(resp.read().decode("utf-8"))
                result = payload["chart"]["result"][0]
                meta = result.get("meta", {})
                timestamps = result["timestamp"]
                closes = result["indicators"]["quote"][0]["close"]
                adj_closes = result["indicators"].get("adjclose", [{}])[0].get("adjclose") or closes
                by_date = {}
                for ts, raw_close, adj_close in zip(timestamps, closes, adj_closes):
                    if raw_close is None or adj_close is None:
                        continue
                    raw_val = float(raw_close)
                    adj_val = float(adj_close)
                    if math.isfinite(raw_val) and raw_val > 0 and math.isfinite(adj_val) and adj_val > 0:
                        day = datetime.fromtimestamp(ts, tz=timezone.utc).date()
                        by_date[day] = (day, adj_val, raw_val)
                live_price = meta.get("regularMarketPrice")
                live_time = meta.get("regularMarketTime")
                if isinstance(live_price, (int, float)) and live_price > 0 and isinstance(live_time, (int, float)):
                    live_day = datetime.fromtimestamp(live_time, tz=timezone.utc).date()
                    by_date[live_day] = (live_day, float(live_price), float(live_price))
                return make_history(list(by_date.values()))
            except Exception as exc:
                error = exc
        if attempt < 2:
            time.sleep(2 ** attempt)
    raise RuntimeError(f"{symbol}: could not download prices: {error}")


def demo_king_history(index, cutoff):
    generator = random.Random(100 + index)
    base_prices = [
        68, 150, 160, 155, 90, 185, 115, 295, 80, 250,
        145, 138, 76, 32, 58, 135, 118, 255, 190, 620,
        285, 510, 138, 102, 112
    ]
    price = base_prices[index % len(base_prices)]
    rows = []
    for offset in range(730, -1, -1):
        day = cutoff - timedelta(days=offset)
        if day.weekday() >= 5:
            continue
        drift = math.sin(offset / 16 + index) * 0.002
        price *= 1 + drift + generator.gauss(0.00012, 0.0085)
        rows.append((day, price, price))
    return make_history(rows)


def build_kings_payload(demo=False):
    cutoff = date.today()
    stocks = []
    for index, (symbol, name, sector, streak_years, tv_symbol) in enumerate(DIVIDEND_KINGS):
        history = demo_king_history(index, cutoff) if demo else download_king_history(symbol)
        stocks.append({
            "symbol": symbol,
            "tv_symbol": tv_symbol,
            "name": name,
            "sector": sector,
            "streak_years": streak_years,
            "history": history,
        })
        print(f"{symbol}: {len(history)} days through {history[-1]['date']}")
    return {
        "schema_version": 1,
        "mode": "demo" if demo else "live",
        "source": "Synthetic demonstration" if demo else "Yahoo Finance",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "price_basis": "adjusted_close",
        "rsi_period": 14,
        "stocks": stocks,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--demo", action="store_true", help="Generate synthetic Dividend Kings data.")
    parser.add_argument("--output", type=Path, default=ROOT / "data" / "kings.json")
    args = parser.parse_args()
    try:
        payload = build_kings_payload(args.demo)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.output.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        temporary.replace(args.output)
    except Exception as error:
        print(f"Dividend Kings refresh failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
