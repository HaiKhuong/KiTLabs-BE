"""Unit tests for subtitle/audio_segment_cut.py (Step7c keep-duration mute)."""

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
    build_step7c_filter_complex,
    get_deleted_output_windows,
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

    def test_skip_when_multiple_active_no_deleted(self):
        segments = [
            AudioSegment("a", 0.0, 5.0, False),
            AudioSegment("b", 5.0, 10.0, False),
        ]
        self.assertFalse(needs_audio_segment_cut(segments, 10.0, 1.0, 1.0))


class TestDeletedWindows(unittest.TestCase):
    def test_maps_deleted_only_and_merges(self):
        segments = [
            AudioSegment("a", 0.0, 6.0, False),
            AudioSegment("b", 6.0, 12.0, True),
            AudioSegment("c", 12.0, 20.0, False),
        ]
        windows = get_deleted_output_windows(segments, 2.0, 0.5, 20.0)
        self.assertEqual(windows, [(6.0, 12.0)])

    def test_all_deleted_keeps_full_span(self):
        segments = [AudioSegment("a", 0.0, 10.0, True)]
        windows = get_deleted_output_windows(segments, 1.0, 1.0, 10.0)
        self.assertEqual(windows, [(0.0, 10.0)])


class TestFilterComplex(unittest.TestCase):
    def test_builds_keep_duration_mute_with_audio(self):
        fc = build_step7c_filter_complex([(0.0, 2.0), (4.0, 6.0)], True)
        self.assertNotIn("concat=", fc)
        self.assertNotIn("trim=", fc)
        self.assertIn("eq=brightness=-1", fc)
        self.assertIn("volume=0", fc)
        self.assertIn("gte(t,0.000)*lte(t,2.000)", fc)
        self.assertIn("gte(t,4.000)*lte(t,6.000)", fc)
        self.assertIn("[outv]", fc)
        self.assertIn("[outa]", fc)

    def test_video_only(self):
        fc = build_step7c_filter_complex([(1.0, 3.0)], False)
        self.assertIn("[outv]", fc)
        self.assertNotIn("[outa]", fc)


if __name__ == "__main__":
    unittest.main()
