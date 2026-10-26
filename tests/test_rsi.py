import io
import unittest
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import Mock, patch

from scripts.update_data import calculate_rsi, download_history, latest_completed_date, make_history


class RsiTests(unittest.TestCase):
    def test_wilder_reference_values(self):
        # Wilder's widely used worksheet example, including recursive updates.
        prices = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42,
                  45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00,
                  46.03, 46.41, 46.22, 45.64, 46.21]
        result = calculate_rsi(prices)
        self.assertTrue(all(value is None for value in result[:14]))
        self.assertAlmostEqual(result[14], 70.4641, places=4)
        self.assertAlmostEqual(result[15], 66.2496, places=4)
        self.assertAlmostEqual(result[-1], 62.8807, places=4)

    def test_rising_falling_and_flat_prices(self):
        self.assertEqual(calculate_rsi(list(range(1, 31)))[-1], 100)
        self.assertEqual(calculate_rsi(list(range(30, 0, -1)))[-1], 0)
        self.assertEqual(calculate_rsi([10] * 30)[-1], 50)

    def test_short_history_has_no_rsi(self):
        self.assertEqual(calculate_rsi([10, 11]), [None, None])
        self.assertEqual(calculate_rsi([]), [])

    def test_invalid_prices_are_rejected(self):
        for invalid in [0, -1, float("nan"), float("inf")]:
            with self.subTest(price=invalid), self.assertRaises(ValueError):
                calculate_rsi([10, invalid])
        with self.assertRaises(ValueError):
            calculate_rsi([10], 0)

    def test_incomplete_session_is_excluded(self):
        before_close = datetime(2026, 10, 20, 19, 0, tzinfo=timezone.utc)
        after_buffer = datetime(2026, 10, 20, 21, 1, tzinfo=timezone.utc)
        self.assertEqual(latest_completed_date(before_close).isoformat(), "2026-10-19")
        self.assertEqual(latest_completed_date(after_buffer).isoformat(), "2026-10-20")

    def test_winter_market_timezone(self):
        winter = datetime(2026, 1, 20, 21, 30, tzinfo=timezone.utc)
        self.assertEqual(latest_completed_date(winter).isoformat(), "2026-01-19")

    def test_inadequate_history_is_rejected(self):
        with self.assertRaises(ValueError):
            make_history([])


class DownloadHistoryTests(unittest.TestCase):
    def setUp(self):
        self.cutoff = date(2026, 10, 23)
        self.rows = [
            (datetime.combine(self.cutoff - timedelta(days=offset), datetime.min.time()),
             {"Adj Close": 60.0, "Close": 65.0})
            for offset in range(209, -1, -1)
        ]
        self.frame = Mock()
        self.frame.iterrows.side_effect = lambda: iter(self.rows)
        self.yfinance = Mock()
        self.yfinance.Ticker.return_value.history.return_value = self.frame
        self.stderr = io.StringIO()
        for patcher in (
            patch.dict("sys.modules", {"yfinance": self.yfinance}),
            patch("scripts.update_data.time.sleep"),
            patch("sys.stderr", self.stderr),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_invalid_prices_are_skipped_and_logged(self):
        invalid_prices = [None, float("nan"), float("inf"), float("-inf"), 0, -1, "invalid"]
        for column in ("Adj Close", "Close"):
            for invalid in invalid_prices:
                with self.subTest(column=column, price=invalid):
                    self.rows[10][1][column] = invalid
                    history = download_history("KO", self.cutoff)
                    self.assertEqual(len(history), 209)
                    self.assertNotIn(self.rows[10][0].date().isoformat(), [row["date"] for row in history])
                    self.assertEqual(history[-1]["close"], 60.0)
                    self.assertEqual(history[-1]["quote_close"], 65.0)
                    self.assertEqual(history[-1]["rsi"], 50.0)
                    self.assertIn("KO: skipping invalid prices for 2026-04-07", self.stderr.getvalue())
                    self.rows[10][1][column] = 60.0 if column == "Adj Close" else 65.0

    def test_incomplete_session_is_excluded(self):
        self.rows.append((datetime(2026, 10, 24), {"Adj Close": 100.0, "Close": 105.0}))
        history = download_history("KO", self.cutoff)
        self.assertEqual(len(history), 210)
        self.assertEqual(history[-1]["date"], self.cutoff.isoformat())

    def test_too_few_valid_prices_are_rejected(self):
        for _, row in self.rows[:11]:
            row["Close"] = None
        with self.assertRaisesRegex(RuntimeError, "At least 200 daily observations"):
            download_history("KO", self.cutoff)
        self.assertEqual(self.yfinance.Ticker.call_count, 3)

    def test_stale_prices_after_filtering_are_rejected(self):
        for _, row in self.rows[-8:]:
            row["Adj Close"] = float("nan")
        with self.assertRaisesRegex(RuntimeError, "Latest price is more than seven days old"):
            download_history("KO", self.cutoff)
        self.assertEqual(self.yfinance.Ticker.call_count, 3)


if __name__ == "__main__":
    unittest.main()
