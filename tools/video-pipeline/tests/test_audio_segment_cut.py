"""Unit tests for subtitle/audio_segment_cut.py (Step7c)."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from subtitle.audio_segment_cut import (  # noqa: E402
    AudioSegment,
    build_output_ranges,
    build_step7c_filter_complex,
    map_source_time_to_output,
    needs_audio_segment_cut,
    parse_audio_segments_json,
)


class TestMapSourceTime(unittest.TestCase):
    def test_default_speeds(self):
        self.assertEqual(map_source_time_to_output(10.0, 1.0, 1.0), 10.0)

    def test_preprocess_and_speed(self):
        self.assertEqual(map_source_time_to_output(12.0, 2.0, 0.5), 12.0)


class TestParseAudioSegments(unittest.TestCase):
    def test_parse_valid_json(self):
        payload = json.dumps(
            [
                {"id": "a", "startSec": 0, "endSec": 5, "deleted": False},
                {"id": "b", "startSec": 5, "endSec": 10, "deleted": True},
            ]
        )
        segments = parse_audio_segments_json(payload, 10)
        self.assertEqual(len(segments), 2)
        self.assertTrue(segments[1].deleted)


class TestNeedsAudioSegmentCut(unittest.TestCase):
    def test_skip_full_single_segment(self):
        segments = [AudioSegment("a", 0.0, 10.0, False)]
        self.assertFalse(needs_audio_segment_cut(segments, 10.0, 1.0, 1.0))

    def test_cut_when_deleted(self):
        segments = [
            AudioSegment("a", 0.0, 5.0, False),
            AudioSegment("b", 5.0, 10.0, True),
        ]
        self.assertTrue(needs_audio_segment_cut(segments, 10.0, 1.0, 1.0))

    def test_cut_when_multiple_active(self):
        segments = [
            AudioSegment("a", 0.0, 5.0, False),
            AudioSegment("b", 5.0, 10.0, False),
        ]
        self.assertTrue(needs_audio_segment_cut(segments, 10.0, 1.0, 1.0))


class TestBuildOutputRanges(unittest.TestCase):
    def test_maps_and_filters_deleted(self):
        segments = [
            AudioSegment("a", 0.0, 6.0, False),
            AudioSegment("b", 6.0, 12.0, True),
            AudioSegment("c", 12.0, 20.0, False),
        ]
        ranges = build_output_ranges(segments, 2.0, 0.5, 20.0)
        self.assertEqual(ranges, [(0.0, 6.0), (12.0, 20.0)])


class TestFilterComplex(unittest.TestCase):
    def test_builds_concat_with_audio(self):
        fc = build_step7c_filter_complex([(0.0, 2.0), (4.0, 6.0)], True)
        self.assertIn("concat=n=2:v=1:a=1[outv][outa]", fc)
        self.assertIn("trim=start=0.000:end=2.000", fc)


if __name__ == "__main__":
    unittest.main()
