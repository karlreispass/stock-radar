import copy
import json
import os
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from scripts.send_notifications import configured_signals, create_issue_body, event_marker, load_remote_profiles
from scripts.write_profile_config import validate_api_url
from test_alert_features import settings, snapshot


def profiles():
    return [{"id": "user-" + str(number), "name": "Kasutaja " + str(number), "enabled": True, "settings": settings()} for number in range(1, 4)]


class ProfileTests(unittest.TestCase):
    @patch.dict(os.environ, {}, clear=True)
    def test_absent_configuration_preserves_legacy_mode(self):
        self.assertIsNone(load_remote_profiles())

    @patch.dict(os.environ, {"PROFILE_API_URL": "https://profiles.example"}, clear=True)
    def test_partial_configuration_is_rejected(self):
        with self.assertRaises(ValueError):
            load_remote_profiles()

    def test_only_root_https_service_urls_are_allowed(self):
        self.assertEqual(validate_api_url("https://profiles.example/"), "https://profiles.example")
        for value in ["http://profiles.example", "https://user:pass@profiles.example", "https://profiles.example/private", "https://profiles.example/?secret=x"]:
            with self.subTest(url=value), self.assertRaises(ValueError):
                validate_api_url(value)

    @patch.dict(os.environ, {"PROFILE_API_URL": "https://profiles.example", "PROFILE_API_TOKEN": "x" * 32}, clear=True)
    @patch("scripts.send_notifications.urlopen")
    def test_service_credentials_stay_in_header_and_response_is_validated(self, urlopen):
        urlopen.return_value.__enter__.return_value.read.return_value = json.dumps({"profiles": profiles()}).encode()
        result = load_remote_profiles()
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "https://profiles.example/v1/profiles")
        self.assertEqual(request.get_header("Authorization"), "Bearer " + "x" * 32)
        self.assertEqual(len(result), 3)

    @patch.dict(os.environ, {"PROFILE_API_URL": "https://profiles.example", "PROFILE_API_TOKEN": "x" * 32}, clear=True)
    @patch("scripts.send_notifications.urlopen")
    def test_backend_failure_never_falls_back_to_old_targets(self, urlopen):
        urlopen.side_effect = OSError("private-network-detail")
        with self.assertRaisesRegex(ValueError, "Vanade valikutega"):
            load_remote_profiles()

    @patch("scripts.send_notifications.load_remote_profiles")
    def test_profiles_have_distinct_markers_in_one_daily_summary(self, remote):
        remote.return_value = profiles()
        events, health = configured_signals(snapshot(), settings())
        self.assertEqual(len(events), 3)
        self.assertTrue(health)
        self.assertEqual(len({event_marker(event) for event in events}), 3)
        body = create_issue_body(events, "https://site.example")
        for name in ["Kasutaja 1", "Kasutaja 2", "Kasutaja 3"]:
            self.assertIn(name, body)

    @patch("scripts.send_notifications.load_remote_profiles")
    def test_unsaved_profiles_do_not_generate_notifications(self, remote):
        data = profiles()
        for profile in data:
            profile["enabled"] = False
        remote.return_value = data
        events, health = configured_signals(snapshot(), settings())
        self.assertEqual(events, [])
        self.assertFalse(health)

    @patch("scripts.send_notifications.load_remote_profiles")
    def test_each_profile_uses_its_own_target(self, remote):
        data = profiles()
        for profile in data:
            profile["settings"]["targets"]["KO"] = 90
        data[1]["settings"]["targets"]["KO"] = 99
        remote.return_value = data
        events, _ = configured_signals(snapshot(50, 50), settings())
        self.assertEqual([event["profile_name"] for event in events], ["Kasutaja 2"])


if __name__ == "__main__":
    unittest.main()
