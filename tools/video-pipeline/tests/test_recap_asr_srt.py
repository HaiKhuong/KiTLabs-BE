"""SRT round-trip for recap Whisper output."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "recap"))

from asr import parse_srt, parse_srt_time_range, sec_to_srt_timestamp, segments_to_srt  # noqa: E402


class TestRecapSrt(unittest.TestCase):
    def test_round_trip_milliseconds(self) -> None:
        segs = [
            {"startSec": 1.2, "endSec": 3.456, "text": "Xin chào"},
            {"startSec": 3.5, "endSec": 5.0, "text": "Dòng hai"},
        ]
        srt = segments_to_srt(segs)
        self.assertIn("00:00:01,200 --> 00:00:03,456", srt)
        self.assertTrue(srt.startswith("1\n"))
        parsed = parse_srt(srt)
        self.assertEqual(len(parsed), 2)
        self.assertAlmostEqual(parsed[0]["startSec"], 1.2, places=3)
        self.assertAlmostEqual(parsed[0]["endSec"], 3.456, places=3)
        self.assertEqual(parsed[0]["text"], "Xin chào")
        self.assertEqual(parse_srt(segments_to_srt(parsed))[1]["text"], "Dòng hai")

    def test_parse_srt_time_range(self) -> None:
        rng = parse_srt_time_range("00:01:38,933 --> 00:01:41,832")
        self.assertIsNotNone(rng)
        assert rng is not None
        self.assertAlmostEqual(rng[0], 98.933, places=3)
        self.assertAlmostEqual(rng[1], 101.832, places=3)

    def test_sec_to_srt_timestamp_hours(self) -> None:
        self.assertEqual(sec_to_srt_timestamp(5028.299), "01:23:48,299")


if __name__ == "__main__":
    unittest.main()
