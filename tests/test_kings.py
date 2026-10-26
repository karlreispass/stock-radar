import contextlib
import io
import json
import unittest
from datetime import date, datetime, timedelta, timezone
from unittest.mock import Mock, patch

from scripts.update_kings import DIVIDEND_KINGS, ROOT, build_kings_payload, download_king_stock


class DividendKingsTests(unittest.TestCase):
    def test_live_quote_never_replaces_adjusted_daily_prices_or_adds_an_incomplete_day(self):
        last_day = date(2026, 10, 24)
        days = [last_day - timedelta(days=offset) for offset in range(210, -1, -1)]
        now = datetime.now(timezone.utc)
        result = {
            "meta": {"regularMarketPrice": 888, "regularMarketTime": now.timestamp()},
            "timestamp": [datetime.combine(day, datetime.min.time(), tzinfo=timezone.utc).timestamp() for day in days],
            "indicators": {"quote": [{"close": [65] * 210 + [999]}], "adjclose": [{"adjclose": [60] * 210 + [900]}]},
        }
        response = Mock()
        response.read.return_value = json.dumps({"chart": {"result": [result]}}).encode("utf-8")
        connection = Mock()
        connection.__enter__ = Mock(return_value=response)
        connection.__exit__ = Mock(return_value=False)
        with patch("scripts.update_kings.urlopen", return_value=connection), patch("scripts.update_kings.latest_completed_date", return_value=date(2026, 10, 23)):
            data = download_king_stock("KO")
        self.assertEqual(len(data["history"]), 210)
        self.assertEqual(data["history"][-1], {"date": "2026-10-23", "close": 60, "quote_close": 65, "rsi": 50})
        self.assertEqual(data["quote"]["price"], 888)
        self.assertEqual(data["quote"]["as_of"], now.isoformat())

    def test_catalog_has_unique_symbols_and_required_metadata(self):
        catalog = json.loads((ROOT / "data" / "dividend-kings.json").read_text(encoding="utf-8"))
        self.assertEqual(DIVIDEND_KINGS, catalog)
        self.assertGreater(len(catalog), 0)
        self.assertEqual(len({company["symbol"] for company in catalog}), len(catalog))
        for company in catalog:
            with self.subTest(symbol=company["symbol"]):
                self.assertGreaterEqual(company["streakYears"], 50)
                for key in ("symbol", "name", "sector", "tvSymbol"):
                    self.assertIsInstance(company[key], str)
                    self.assertTrue(company[key].strip())

    def test_demo_generation_uses_the_shared_catalog(self):
        with contextlib.redirect_stdout(io.StringIO()):
            payload = build_kings_payload(demo=True)
        self.assertEqual(payload["mode"], "demo")
        self.assertEqual(len(payload["stocks"]), len(DIVIDEND_KINGS))
        for stock, company in zip(payload["stocks"], DIVIDEND_KINGS):
            with self.subTest(symbol=company["symbol"]):
                self.assertEqual(stock["symbol"], company["symbol"])
                self.assertEqual(stock["name"], company["name"])
                self.assertEqual(stock["sector"], company["sector"])
                self.assertEqual(stock["tv_symbol"], company["tvSymbol"])
                self.assertEqual(stock["streak_years"], company["streakYears"])
                self.assertGreaterEqual(len(stock["history"]), 200)
                self.assertIsNotNone(stock["history"][-1]["rsi"])
