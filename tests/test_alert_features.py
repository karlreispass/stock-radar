import copy
import json
import shutil
import subprocess
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from scripts.send_notifications import find_signals, publish_health, stale_snapshot
from scripts.signals import is_candidate, validate_settings
from scripts.update_data import make_history

ROOT = Path(__file__).resolve().parents[1]
TODAY = datetime.now(timezone.utc).date()


def settings():
    return json.loads((ROOT / "settings.json").read_text(encoding="utf-8"))


def snapshot(previous=45, current=35):
    return {"mode": "live", "rsi_period": 14, "stocks": [{
        "symbol": "KO", "name": "Coca-Cola", "history": [
            {"date": (TODAY - timedelta(days=1)).isoformat(), "close": 100, "quote_close": 100, "rsi": previous},
            {"date": TODAY.isoformat(), "close": 98, "quote_close": 98, "rsi": current},
        ],
    }]}


class AlertFeatureTests(unittest.TestCase):
    def test_intraday_quote_does_not_change_daily_alerts(self):
        data = snapshot(50, 50)
        config = settings()
        config["targets"]["KO"] = 99
        expected = find_signals(data, settings=config)
        data["stocks"][0]["quote"] = {"price": 1, "as_of": datetime.now(timezone.utc).isoformat(), "date": TODAY.isoformat()}
        self.assertEqual(find_signals(data, settings=config), expected)
        data["stocks"][0]["quote"]["price"] = 1000
        self.assertEqual(find_signals(data, settings=config), expected)

    def test_watch_crossing_and_persistent_low_rsi(self):
        self.assertEqual([event["kind"] for event in find_signals(snapshot())], ["watch"])
        self.assertEqual(find_signals(snapshot(39, 35)), [])

    def test_target_uses_unadjusted_quote_and_only_new_crossing(self):
        config = settings()
        config["targets"]["KO"] = 99
        data = snapshot(50, 50)
        data["stocks"][0]["history"][-1]["close"] = 90
        events = find_signals(data, settings=config)
        self.assertEqual([event["kind"] for event in events], ["target"])
        data["stocks"][0]["history"][-2]["quote_close"] = 98
        self.assertEqual(find_signals(data, settings=config), [])
        data["stocks"][0]["history"][-1].pop("quote_close")
        self.assertEqual(find_signals(data, settings=config), [])

    def test_disabled_notifications(self):
        config = settings()
        config["events"]["watch"] = False
        self.assertEqual(find_signals(snapshot(), settings=config), [])

    def test_config_validation(self):
        self.assertEqual(validate_settings(settings()), settings())
        for bad in [0, -1, True, float("nan")]:
            config = settings()
            config["targets"]["KO"] = bad
            with self.assertRaises(ValueError):
                validate_settings(config)

    def test_stale_snapshot_and_future_dates(self):
        self.assertIsNone(stale_snapshot(snapshot()))
        data = snapshot()
        for point in data["stocks"][0]["history"]:
            point["date"] = (TODAY - timedelta(days=7)).isoformat()
        self.assertIn("stale-", stale_snapshot(data)[1])

    @patch("scripts.send_notifications.github_request")
    def test_identical_health_warning_is_not_repeated(self, request):
        request.side_effect = [[{"number": 7, "body": "<!-- stock-radar:health:v1 -->\n<!-- stock-radar:health-event:stale-test -->"}], []]
        self.assertFalse(publish_health("Stale", "stale-test", "owner/repo", "token"))
        self.assertTrue(all(call.args[0] == "GET" for call in request.call_args_list))

    @patch("scripts.send_notifications.github_request")
    def test_new_health_event_reopens_closed_issue(self, request):
        request.side_effect = [[{"number": 7, "state": "closed", "body": "<!-- stock-radar:health:v1 -->"}], [], {}, {}]
        self.assertTrue(publish_health("Failed", "new-failure", "owner/repo", "token"))
        self.assertEqual(request.call_args_list[-2].args[0], "PATCH")
        self.assertEqual(request.call_args_list[-1].args[0], "POST")

    @unittest.skipUnless(shutil.which("node"), "Node needed for cross-language rule comparison")
    def test_browser_and_notification_candidate_rules_match(self):
        data = json.loads((ROOT / "data/stocks.json").read_text(encoding="utf-8"))
        expected = [[is_candidate(stock["history"], index) for index in range(len(stock["history"]))] for stock in data["stocks"]]
        code = "const fs=require('fs');const {analyzeStock}=require('./analysis.js');const d=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify(d.stocks.map(s=>s.history.map((p,i)=>analyzeStock(s,i).candidate))));"
        result = subprocess.run(["node", "-e", code], input=json.dumps(data), text=True, capture_output=True, cwd=ROOT, check=True)
        self.assertEqual(json.loads(result.stdout), expected)

    def test_price_basis_is_preserved(self):
        rows = [(TODAY - timedelta(days=200-index), 90 + index, 100 + index) for index in range(201)]
        history = make_history(rows)
        self.assertEqual(history[-1]["close"], 290)
        self.assertEqual(history[-1]["quote_close"], 300)

    def test_candidate_notification_is_only_created_on_new_signal(self):
        data = snapshot()
        history = [
            {"date": (TODAY - timedelta(days=29-index)).isoformat(), "close": 100, "rsi": 35}
            for index in range(30)
        ]
        history[-2]["close"] = 90
        history[-1].update(close=110, rsi=45)
        data["stocks"][0]["history"] = history
        kinds = [event["kind"] for event in find_signals(data)]
        self.assertIn("candidate", kinds)
        config = settings()
        config["events"]["candidate"] = False
        self.assertNotIn("candidate", [event["kind"] for event in find_signals(data, settings=config)])

    def test_download_keeps_adjusted_and_quote_prices_separate(self):
        import sys
        from types import SimpleNamespace
        from unittest.mock import Mock
        from scripts.update_data import download_history
        frame = Mock()
        frame.iterrows.return_value = iter([
            (datetime.combine(TODAY - timedelta(days=200-index), datetime.min.time()),
             {"Adj Close": 90 + index, "Close": 100 + index})
            for index in range(201)
        ])
        ticker = Mock()
        ticker.history.return_value = frame
        factory = Mock(return_value=ticker)
        with patch.dict(sys.modules, {"yfinance": SimpleNamespace(Ticker=factory)}):
            history = download_history("KO", TODAY)
        self.assertEqual(history[-1]["close"], 290)
        self.assertEqual(history[-1]["quote_close"], 300)
        self.assertFalse(ticker.history.call_args.kwargs["auto_adjust"])

    @patch("scripts.send_notifications.github_request")
    def test_failure_preview_never_calls_github(self, request):
        import io
        from scripts.send_notifications import run
        with patch("sys.stdout", new_callable=io.StringIO) as output:
            run(ROOT / "does-not-exist.json", dry_run=True, failure=True)
        self.assertIn("ebaõnnestus", output.getvalue())
        request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
