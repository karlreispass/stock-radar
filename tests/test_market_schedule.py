import unittest
from datetime import datetime, timezone

from scripts.market_schedule import DAILY_SCHEDULE, is_market_open, refresh_plan


class MarketScheduleTests(unittest.TestCase):
    def utc(self, value):
        return datetime.fromisoformat(value).replace(tzinfo=timezone.utc)

    def test_opening_and_closing_times_follow_us_daylight_saving(self):
        for timestamp, expected in [
            ("2026-07-06T13:29:00", False),
            ("2026-07-06T13:30:00", True),
            ("2026-07-06T19:59:00", True),
            ("2026-07-06T20:00:00", False),
            ("2026-01-20T14:29:00", False),
            ("2026-01-20T14:30:00", True),
            ("2026-01-20T21:00:00", False),
        ]:
            with self.subTest(timestamp=timestamp):
                self.assertEqual(is_market_open(self.utc(timestamp)), expected)

    def test_holidays_weekends_and_early_close(self):
        for timestamp, expected in [
            ("2026-10-24T15:00:00", False),
            ("2026-11-26T15:00:00", False),
            ("2026-11-27T17:59:00", True),
            ("2026-11-27T18:00:00", False),
        ]:
            with self.subTest(timestamp=timestamp):
                self.assertEqual(is_market_open(self.utc(timestamp)), expected)

    def test_intraday_run_never_sends_daily_notifications(self):
        self.assertEqual(refresh_plan("schedule", "intraday", self.utc("2026-10-26T15:00:00")), (True, False))
        self.assertEqual(refresh_plan("schedule", "intraday", self.utc("2026-10-26T22:00:00")), (False, False))

    def test_daily_run_survives_scheduler_delays(self):
        self.assertEqual(refresh_plan("schedule", DAILY_SCHEDULE, self.utc("2026-10-27T00:30:00")), (True, True))

    def test_push_and_manual_runs_only_notify_after_close_buffer(self):
        for event in ("push", "workflow_dispatch"):
            with self.subTest(event=event):
                self.assertEqual(refresh_plan(event, now=self.utc("2026-10-26T15:00:00")), (True, False))
                self.assertEqual(refresh_plan(event, now=self.utc("2026-10-26T21:00:00")), (True, True))


if __name__ == "__main__":
    unittest.main()
