"""Exact 100% duplicate consecutive SRT cues merge into one timeline."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from subtitle.merge import merge_exact_duplicate_cues, merge_exact_duplicate_srt_blocks  # noqa: E402


class TestMergeExactDuplicates(unittest.TestCase):
    def test_merge_two_adjacent_identical_vi_cues(self):
        blocks = [
            {
                "index": 244,
                "time": "00:08:38,000 --> 00:08:38,232",
                "text": "Rất có thể là người Khấu Quốc.",
            },
            {
                "index": 245,
                "time": "00:08:38,233 --> 00:08:40,023",
                "text": "Rất có thể là người Khấu Quốc.",
            },
        ]
        merged, count = merge_exact_duplicate_srt_blocks(blocks)
        self.assertEqual(count, 1)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["index"], 244)
        self.assertEqual(merged[0]["time"], "00:08:38,000 --> 00:08:40,023")
        self.assertEqual(merged[0]["text"], "Rất có thể là người Khấu Quốc.")

    def test_does_not_merge_when_text_differs(self):
        blocks = [
            {"index": 1, "time": "00:00:01,000 --> 00:00:02,000", "text": "Xin chào."},
            {"index": 2, "time": "00:00:02,001 --> 00:00:03,000", "text": "Xin chào!"},
        ]
        merged, count = merge_exact_duplicate_srt_blocks(blocks)
        self.assertEqual(count, 0)
        self.assertEqual(len(merged), 2)

    def test_does_not_merge_when_gap_too_large(self):
        blocks = [
            {"index": 1, "time": "00:00:01,000 --> 00:00:02,000", "text": "Lặp lại."},
            {"index": 2, "time": "00:00:03,000 --> 00:00:04,000", "text": "Lặp lại."},
        ]
        merged, count = merge_exact_duplicate_srt_blocks(blocks, max_gap_ms=500)
        self.assertEqual(count, 0)
        self.assertEqual(len(merged), 2)

    def test_chain_merge_three_identical_cues(self):
        cues = [
            (1.0, 1.2, "A"),
            (1.201, 1.5, "A"),
            (1.501, 2.0, "A"),
        ]
        merged, count = merge_exact_duplicate_cues(cues)
        self.assertEqual(count, 2)
        self.assertEqual(merged, [(1.0, 2.0, "A")])


if __name__ == "__main__":
    unittest.main()
