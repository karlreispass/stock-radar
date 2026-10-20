import unittest
from datetime import datetime, timezone

from scripts.update_data import calculate_rsi, latest_completed_date, make_history


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


if __name__ == "__main__":
    unittest.main()
