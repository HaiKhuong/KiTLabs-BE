"""Unit tests for muse_cli_runner (network and Gateway mocked)."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

import muse_cli_runner as runner


class FakeGateway:
    vm_id = "vm-test-123"

    def __init__(self, events_by_call=None):
        self.calls = []
        self.opened = []
        self.events_by_call = list(events_by_call or [])
        self.closed = False

    def call_json(self, method, body=None):
        self.calls.append((method, body))
        if method == "sessions.list":
            return {"sessions": [{"session_id": "sid-studio", "title": runner.STUDIO_THREAD_TITLE, "archived": False}]}
        if method == "session.start":
            return {"session_id": "sid-new"}
        if method == "chat.history":
            if self.events_by_call:
                return {"chat_events": self.events_by_call.pop(0)}
            return {"chat_events": []}
        if method == "chat.unread_count":
            return {"unread": 0}
        if method == "identity":
            return {"email": "tester@example.com"}
        return {}

    def _open(self, method, body=None):
        self.opened.append((method, body))
        return 1

    def download_file(self, resource):
        return b"FAKE_MEDIA_BYTES"

    def close(self):
        self.closed = True


class MuseCliRunnerTest(unittest.TestCase):
    def test_parse_cookie_input_strips_header_prefix(self):
        self.assertEqual(
            runner._parse_cookie_input("Cookie: hatch_sess=abc123; other=1"),
            "hatch_sess=abc123; other=1",
        )

    def test_matches_media_kind(self):
        self.assertTrue(runner._matches_media_kind({"path": "sandbox://workspace/out.png"}, "image"))
        self.assertFalse(runner._matches_media_kind({"path": "sandbox://workspace/out.mp4"}, "image"))
        self.assertTrue(runner._matches_media_kind({"path": "sandbox://workspace/out.mp4"}, "video"))

    def test_run_generation_image_downloads_file(self):
        baseline_ev = [{"seq": 10}]
        reply_ev = [
            {
                "seq": 11,
                "event_name": "message.assistant",
                "payload": {"status": "completed", "display_text": "Done!"},
            },
            {
                "seq": 12,
                "event_name": "delta.presentation",
                "payload": {
                    "kind": "image",
                    "data": {"images": [{"path": "sandbox://workspace/cat.png", "mime": "image/png"}]},
                },
            },
        ]
        fake_gw = FakeGateway(events_by_call=[baseline_ev, reply_ev, reply_ev, reply_ev])

        with tempfile.TemporaryDirectory() as tmpdir:
            out_path = Path(tmpdir) / "result.png"
            with mock.patch.object(runner, "_connect_with_cookies", return_value=fake_gw):
                with mock.patch.object(runner.time, "sleep"):
                    res = runner._run_generation(
                        {
                            "cookies": "hatch_sess=testval",
                            "prompt": "a cute cat",
                            "outputFile": str(out_path),
                            "aspect": "16:9",
                        },
                        "image",
                    )
            self.assertTrue(res["ok"])
            self.assertEqual(res["threadId"], "sid-studio")
            self.assertEqual(out_path.read_bytes(), b"FAKE_MEDIA_BYTES")
            self.assertTrue(fake_gw.closed)

    def test_ensure_studio_thread_starts_session_with_gateway_method(self):
        fake_gw = FakeGateway()
        with mock.patch.object(
            fake_gw,
            "call_json",
            wraps=lambda m, body=None: (
                {"sessions": []}
                if m == "sessions.list"
                else {"session_id": "sid-created"}
                if m == "session.start"
                else {}
            ),
        ) as mocked:
            sid = runner._ensure_studio_thread(fake_gw)
        self.assertEqual(sid, "sid-created")
        start_calls = [c for c in mocked.call_args_list if c.args[0] == "session.start"]
        self.assertEqual(len(start_calls), 1)
        self.assertEqual(
            start_calls[0].kwargs["body"],
            {
                "method": "/api/session/start",
                "params": {"origin": "fresh", "lifecycle": "persistent"},
            },
        )


if __name__ == "__main__":
    unittest.main()
