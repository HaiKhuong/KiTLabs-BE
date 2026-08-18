"""Unit tests for subtitle/voice_sync.py (Đồng Bộ Voice)."""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

# tools/video-pipeline on path
_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from subtitle.voice_sync import (  # noqa: E402
    estimate_required_ms,
    optimize_subtitle_timings,
    parse_srt_time_range,
    resolve_effective_tail_pad_ms,
)


def _block(index: int, start: str, end: str, text: str) -> dict:
    return {"index": index, "time": f"{start} --> {end}", "text": text}


def _end_ms(block: dict) -> int:
    return parse_srt_time_range(block["time"])[1]


def _start_ms(block: dict) -> int:
    return parse_srt_time_range(block["time"])[0]


class TestResolveEffectiveTailPad(unittest.TestCase):
    def test_full_pad_for_long_text_short_slot(self):
        # 15+ chars in 1s slot → full 350ms (text not short)
        text = "Xin chào các bạn nhé"
        self.assertGreater(resolve_effective_tail_pad_ms(text, 1000), 170)

    def test_half_pad_short_text_short_slot(self):
        os.environ["AUDIO_TTS_TAIL_PAD_MS"] = "350"
        pad = resolve_effective_tail_pad_ms("Ừ.", 1200)
        self.assertEqual(pad, 175)

    def test_full_pad_short_text_long_slot(self):
        os.environ["AUDIO_TTS_TAIL_PAD_MS"] = "350"
        pad = resolve_effective_tail_pad_ms("Ừ.", 2000)
        self.assertEqual(pad, 350)


class TestOptimizeSubtitleTimings(unittest.TestCase):
    def setUp(self):
        os.environ["AUDIO_TTS_TAIL_PAD_MS"] = "350"
        self.kw = dict(
            target_cps=14.0,
            min_gap_ms=10,
            min_borrow_gap_ms=20,
            tts_head_ms=50,
            tts_tail_ms=120,
            short_text_max_chars=14,
            short_timeline_max_ms=1500,
        )

    def test_case1_timeline_sufficient(self):
        # 28 chars → speech ~2000ms; slot 2500ms → no change
        text = "A" * 28
        blocks = [_block(1, "00:00:03,600", "00:00:06,100", text)]
        out, report = optimize_subtitle_timings(blocks, **self.kw)
        self.assertEqual(_end_ms(out[0]), 6100)
        self.assertEqual(report.extended, 0)

    def test_case2_extend_into_gap(self):
        # Need more time; gap 400ms after cue
        text = "A" * 42  # speech ~3000ms + overhead
        blocks = [
            _block(1, "00:00:03,600", "00:00:04,200", text),
            _block(2, "00:00:04,600", "00:00:06,200", "B"),
        ]
        out, report = optimize_subtitle_timings(blocks, **self.kw)
        self.assertGreater(_end_ms(out[0]), 4200)
        self.assertLessEqual(_end_ms(out[0]), 4600 - 10)
        self.assertEqual(_start_ms(out[1]), 4600)
        self.assertGreater(report.extended, 0)

    def test_case3_partial_gap_only(self):
        # Overlap start: gap only 100ms between end 4200 and next start 4300
        text = "A" * 56
        blocks = [
            _block(1, "00:00:03,600", "00:00:04,200", text),
            _block(2, "00:00:04,300", "00:00:06,200", "B"),
        ]
        out, _ = optimize_subtitle_timings(blocks, **self.kw)
        # After overlap fix, then extend at most available gap
        self.assertLessEqual(_end_ms(out[0]), _start_ms(out[1]) - 10)

    def test_case4_sufficient_with_large_gap(self):
        text = "A" * 14
        blocks = [
            _block(1, "00:00:03,600", "00:00:05,000", text),
            _block(2, "00:00:08,000", "00:00:09,000", "B"),
        ]
        out, report = optimize_subtitle_timings(blocks, **self.kw)
        self.assertEqual(_end_ms(out[0]), 5000)
        self.assertEqual(report.extended, 0)

    def test_case5_large_gap_take_only_deficit(self):
        text = "A" * 28
        blocks = [
            _block(1, "00:00:03,600", "00:00:04,000", text),
            _block(2, "00:00:06,000", "00:00:07,000", "B"),
        ]
        out, report = optimize_subtitle_timings(blocks, **self.kw)
        self.assertGreater(_end_ms(out[0]), 4000)
        self.assertLess(_end_ms(out[0]), 6000)

    def test_case6_zero_gap(self):
        text = "A" * 42
        blocks = [
            _block(1, "00:00:03,600", "00:00:04,200", text),
            _block(2, "00:00:04,200", "00:00:06,200", "B"),
        ]
        out, report = optimize_subtitle_timings(blocks, **self.kw)
        self.assertEqual(_end_ms(out[0]), 4200)
        self.assertEqual(report.extended, 0)

    def test_case7_overlap_split(self):
        blocks = [
            _block(1, "00:00:03,600", "00:00:04,800", "A"),
            _block(2, "00:00:04,500", "00:00:06,000", "B"),
        ]
        out, report = optimize_subtitle_timings(blocks, **self.kw)
        self.assertEqual(_end_ms(out[0]), 4650)
        self.assertEqual(_start_ms(out[1]), 4660)
        self.assertEqual(report.overlaps_fixed, 1)

    def test_case8_short_text_long_slot(self):
        blocks = [_block(1, "00:00:00,000", "00:00:05,000", "Ừ.")]
        out, report = optimize_subtitle_timings(blocks, **self.kw)
        self.assertEqual(_end_ms(out[0]), 5000)
        self.assertEqual(report.extended, 0)

    def test_case8b_short_text_short_slot_uses_half_tail_pad(self):
        req_full = estimate_required_ms(
            "Ừ.",
            500,
            target_cps=14.0,
            tts_head_ms=50,
            tts_tail_ms=120,
            short_text_max_chars=14,
            short_timeline_max_ms=1500,
        )
        req_long_slot = estimate_required_ms(
            "Ừ.",
            2000,
            target_cps=14.0,
            tts_head_ms=50,
            tts_tail_ms=120,
            short_text_max_chars=14,
            short_timeline_max_ms=1500,
        )
        self.assertLess(req_full, req_long_slot)

    def test_case11_last_cue_not_extended(self):
        text = "A" * 56
        blocks = [_block(1, "00:00:03,600", "00:00:04,200", text)]
        out, report = optimize_subtitle_timings(blocks, **self.kw)
        self.assertEqual(_end_ms(out[0]), 4200)
        self.assertEqual(report.extended, 0)

    def test_case14_same_start(self):
        blocks = [
            _block(1, "00:00:03,600", "00:00:04,200", "A" * 42),
            _block(2, "00:00:03,600", "00:00:06,200", "B"),
        ]
        out, report = optimize_subtitle_timings(blocks, **self.kw)
        self.assertEqual(_start_ms(out[0]), 3600)
        self.assertEqual(_start_ms(out[1]), 3600)
        self.assertEqual(report.extended, 0)

    def test_case16_tiny_gap_not_borrowed(self):
        text = "A" * 56
        blocks = [
            _block(1, "00:00:03,600", "00:00:04,200", text),
            _block(2, "00:00:04,205", "00:00:06,200", "B"),
        ]
        out, report = optimize_subtitle_timings(blocks, **self.kw)
        self.assertEqual(_end_ms(out[0]), 4200)
        self.assertEqual(report.extended, 0)

    def test_case18_pause_included(self):
        req_plain = estimate_required_ms(
            "Hello",
            1000,
            target_cps=14.0,
            tts_head_ms=50,
            tts_tail_ms=120,
        )
        req_pause = estimate_required_ms(
            "Xin chào.",
            1000,
            target_cps=14.0,
            tts_head_ms=50,
            tts_tail_ms=120,
        )
        self.assertGreater(req_pause, req_plain)


if __name__ == "__main__":
    unittest.main()
