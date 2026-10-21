import contextlib
import io
import json
import unittest

from scripts.update_kings import DIVIDEND_KINGS, ROOT, build_kings_payload


class DividendKingsTests(unittest.TestCase):
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
