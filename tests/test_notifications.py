import copy
import io
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

from scripts.send_notifications import (
    create_issue_body, day_marker, event_marker, find_signals,
    github_pages, github_request, main, publish_day, run,
)

TODAY = datetime.now(timezone.utc).date()


def sample_data(previous=35, current=28):
    return {
        "mode": "live", "rsi_period": 14,
        "stocks": [{
            "symbol": "KO", "name": "Coca-Cola",
            "history": [
                {"date": (TODAY - timedelta(days=1)).isoformat(), "close": 69.5, "rsi": previous},
                {"date": TODAY.isoformat(), "close": 68.0, "rsi": current},
            ],
        }],
    }


def sample_events():
    return find_signals(sample_data())


class SignalTests(unittest.TestCase):
    def test_threshold_crossings_and_persistent_low_rsi(self):
        for previous, current, expected in [(30, 29, 1), (29, 30, 1), (29, 28, 0), (35, 30, 0), (55, 65, 0)]:
            with self.subTest(previous=previous, current=current):
                self.assertEqual(len(find_signals(sample_data(previous, current))), expected)

    def test_old_and_future_data_do_not_notify(self):
        for offset in [-6, 1]:
            data = sample_data()
            for index, point in enumerate(data["stocks"][0]["history"]):
                point["date"] = (TODAY + timedelta(days=offset - 1 + index)).isoformat()
            self.assertEqual(find_signals(data), [])

    def test_demo_and_invalid_values_are_rejected(self):
        data = sample_data()
        data["mode"] = "demo"
        with self.assertRaises(ValueError):
            find_signals(data)
        for invalid in [None, float("nan"), -1, 101]:
            with self.subTest(value=invalid), self.assertRaises(ValueError):
                find_signals(sample_data(current=invalid))

    def test_duplicate_symbols_are_rejected(self):
        data = sample_data()
        data["stocks"].append(copy.deepcopy(data["stocks"][0]))
        with self.assertRaises(ValueError):
            find_signals(data)

    def test_multiple_events_and_stable_markers_are_in_issue_body(self):
        data = sample_data()
        second = copy.deepcopy(data["stocks"][0])
        second.update(symbol="PEP", name="PepsiCo")
        data["stocks"].append(second)
        events = find_signals(data)
        body = create_issue_body(events, "https://example.com/")
        for event in events:
            self.assertIn(event["symbol"], body)
            self.assertIn(event_marker(event), body)
        self.assertIn(day_marker(TODAY.isoformat()), body)
        self.assertIn("https://example.com/", body)


class GitHubApiTests(unittest.TestCase):
    @patch.dict(os.environ, {}, clear=True)
    @patch("scripts.send_notifications.urlopen")
    def test_json_authentication_and_api_version(self, urlopen):
        urlopen.return_value.__enter__.return_value.read.return_value = b'{"number": 1}'
        result = github_request("POST", "/repos/owner/repo/issues", "test-token", {"title": "Test"})
        request = urlopen.call_args.args[0]
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.full_url, "https://api.github.com/repos/owner/repo/issues")
        self.assertEqual(request.get_header("Authorization"), "Bearer test-token")
        self.assertEqual(request.get_header("X-github-api-version"), "2026-03-10")
        self.assertEqual(json.loads(request.data), {"title": "Test"})
        self.assertEqual(result["number"], 1)

    @patch("scripts.send_notifications.github_request")
    def test_list_pagination(self, request):
        request.side_effect = [[{"number": index} for index in range(100)], [{"number": 100}]]
        items = list(github_pages("/repos/owner/repo/issues", "test-token", {"state": "all"}))
        self.assertEqual(len(items), 101)
        self.assertIn("page=2", request.call_args_list[1].args[1])
        self.assertIn("state=all", request.call_args_list[0].args[1])


class PublishingTests(unittest.TestCase):
    @patch("scripts.send_notifications.github_request")
    def test_new_day_creates_one_grouped_issue(self, request):
        request.side_effect = [[], {"number": 1}]
        self.assertTrue(publish_day(sample_events(), "owner/repo", "test-token", "https://example.com/"))
        method, path, token, payload = request.call_args.args
        self.assertEqual((method, path), ("POST", "/repos/owner/repo/issues"))
        self.assertIn(TODAY.isoformat(), payload["title"])
        self.assertIn(event_marker(sample_events()[0]), payload["body"])

    @patch("scripts.send_notifications.github_request")
    def test_existing_closed_issue_prevents_duplicate(self, request):
        events = sample_events()
        request.side_effect = [[{
            "number": 5, "state": "closed", "body": create_issue_body(events, "https://example.com/")
        }], []]
        self.assertFalse(publish_day(events, "owner/repo", "test-token", "https://example.com/"))
        self.assertTrue(all(call.args[0] == "GET" for call in request.call_args_list))
        self.assertIn("state=all", request.call_args_list[0].args[1])

    @patch("scripts.send_notifications.github_request")
    def test_additional_same_day_signal_is_a_comment(self, request):
        events = sample_events()
        request.side_effect = [[{"number": 5, "body": day_marker(TODAY.isoformat())}], [], {"id": 10}]
        self.assertTrue(publish_day(events, "owner/repo", "test-token", "https://example.com/"))
        self.assertEqual(request.call_args.args[1], "/repos/owner/repo/issues/5/comments")
        self.assertIn(event_marker(events[0]), request.call_args.args[3]["body"])

    @patch("scripts.send_notifications.github_request")
    def test_previously_commented_signal_is_not_repeated(self, request):
        events = sample_events()
        request.side_effect = [
            [{"number": 5, "body": day_marker(TODAY.isoformat())}],
            [{"body": create_issue_body(events, "https://example.com/")}],
        ]
        self.assertFalse(publish_day(events, "owner/repo", "test-token", "https://example.com/"))
        self.assertEqual(request.call_count, 2)

    @patch("scripts.send_notifications.github_request")
    def test_pull_request_is_not_mistaken_for_alert_issue(self, request):
        request.side_effect = [
            [{"number": 5, "body": day_marker(TODAY.isoformat()), "pull_request": {}}],
            {"number": 6},
        ]
        self.assertTrue(publish_day(sample_events(), "owner/repo", "test-token", "https://example.com/"))
        self.assertEqual(request.call_args.args[1], "/repos/owner/repo/issues")

    @patch("scripts.send_notifications.github_request")
    def test_api_failure_does_not_report_success(self, request):
        failure = HTTPError("https://api.github.com", 403, "Forbidden", {}, io.BytesIO(b""))
        self.addCleanup(failure.close)
        request.side_effect = [[], failure]
        with self.assertRaises(HTTPError):
            publish_day(sample_events(), "owner/repo", "test-token", "https://example.com/")


class RunTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.data_path = Path(temporary.name) / "stocks.json"
        self.data_path.write_text(json.dumps(sample_data()), encoding="utf-8")

    @patch.dict(os.environ, {}, clear=True)
    @patch("scripts.send_notifications.github_request")
    def test_preview_needs_no_token_and_makes_no_api_calls(self, request):
        with patch("sys.stdout", new_callable=io.StringIO) as output:
            run(self.data_path, dry_run=True)
        self.assertIn("Coca-Cola", output.getvalue())
        request.assert_not_called()

    @patch.dict(os.environ, {}, clear=True)
    @patch("scripts.send_notifications.github_request")
    def test_demo_creates_no_notifications(self, request):
        data = sample_data()
        data["mode"] = "demo"
        self.data_path.write_text(json.dumps(data))
        run(self.data_path)
        request.assert_not_called()

    @patch.dict(os.environ, {}, clear=True)
    @patch("scripts.send_notifications.github_request")
    def test_no_signals_creates_no_notifications(self, request):
        self.data_path.write_text(json.dumps(sample_data(40, 45)))
        run(self.data_path)
        request.assert_not_called()

    @patch.dict(os.environ, {"GITHUB_REPOSITORY": "owner/repo"}, clear=True)
    def test_missing_token_is_an_error_when_there_is_a_signal(self):
        with self.assertRaisesRegex(ValueError, "GITHUB_TOKEN"):
            run(self.data_path)

    @patch.dict(os.environ, {"GITHUB_REPOSITORY": "../invalid/repo", "GITHUB_TOKEN": "test-token"}, clear=True)
    def test_invalid_repository_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "GITHUB_REPOSITORY"):
            run(self.data_path)

    @patch.dict(os.environ, {
        "GITHUB_REPOSITORY": "owner/repo", "GITHUB_TOKEN": "test-token", "SITE_URL": "https://example.com/"
    }, clear=True)
    @patch("scripts.send_notifications.publish_day", return_value=True)
    def test_different_trading_dates_get_separate_daily_issues(self, publish):
        data = sample_data()
        second = copy.deepcopy(data["stocks"][0])
        second.update(symbol="PEP", name="PepsiCo")
        for point in second["history"]:
            point["date"] = (datetime.fromisoformat(point["date"]).date() - timedelta(days=1)).isoformat()
        data["stocks"].append(second)
        self.data_path.write_text(json.dumps(data))
        run(self.data_path)
        self.assertEqual(publish.call_count, 2)

    @patch("sys.argv", ["send_notifications.py"])
    @patch("scripts.send_notifications.run")
    def test_api_error_message_does_not_expose_response_details(self, run_mock):
        run_mock.side_effect = HTTPError("https://api.github.com/private", 403, "private-response-details", {}, io.BytesIO(b""))
        with patch("sys.stderr", new_callable=io.StringIO) as output:
            self.assertEqual(main(), 1)
        self.assertIn("403", output.getvalue())
        self.assertNotIn("private-response-details", output.getvalue())


if __name__ == "__main__":
    unittest.main()
