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
    apply_speed_factor_ms,
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
            max_start_shift_ms=400,
            speed_factor=1.0,
        )

    def test_speed_factor_reduces_deficit_before_borrowing_timeline(self):
        text_2520 = "A" * 28
        blocks = [
            _block(1, "00:00:00,000", "00:00:02,000", text_2520),
            _block(2, "00:00:04,000", "00:00:06,520", text_2520),
        ]
        kw = {**self.kw, "speed_factor": 1.1}

        out, report = optimize_subtitle_timings(blocks, **kw)

        self.assertEqual(apply_speed_factor_ms(2520, 1.1), 2291)
        self.assertEqual(_end_ms(out[0]), 2291)
        self.assertEqual(report.extended, 1)

    def test_case1_timeline_sufficient(self):
        # 28 chars → speech ~2000ms; slot 2500ms → no change
        text = "A" * 28
        blocks = [_block(1, "00:00:03,600", "00:00:06,100", text)]
        out, report = optimize_subtitle_timings(blocks, **self.kw)
        self.assertEqual(_end_ms(out[0]), 6100)
        self.assertEqual(report.extended, 0)

    def test_case2_extend_into_gap(self):
        # Need more time; gap 400ms after cue (cue 2 is full so only gap is taken)
        text = "A" * 42  # speech ~3000ms + overhead
        blocks = [
            _block(1, "00:00:03,600", "00:00:04,200", text),
            _block(2, "00:00:04,600", "00:00:06,200", "B" * 28),
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
            _block(2, "00:00:04,300", "00:00:06,200", "B" * 28),
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
        text = "A" * 20
        blocks = [
            _block(1, "00:00:03,600", "00:00:04,000", text),
            _block(2, "00:00:06,000", "00:00:07,000", "B" * 28),
        ]
        out, report = optimize_subtitle_timings(blocks, **self.kw)
        self.assertGreater(_end_ms(out[0]), 4000)
        self.assertLess(_end_ms(out[0]), 6000)

    def test_case6_zero_gap(self):
        text = "A" * 42
        blocks = [
            _block(1, "00:00:03,600", "00:00:04,200", text),
            _block(2, "00:00:04,200", "00:00:06,200", "B" * 28),
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
            _block(2, "00:00:04,205", "00:00:06,200", "B" * 28),
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

    def test_rebalance_5_cues_shift_neighbors_2_and_4(self):
        """
        Ví dụ thực tế:
        - SRT 1: dư 0.02s (20ms)
        - SRT 2: đủ (0ms dư)
        - SRT 3: thiếu 0.04s (40ms)
        - SRT 4: đủ (0ms dư)
        - SRT 5: dư 0.02s (20ms)
        -> Dịch chuyển điểm bắt đầu/kết thúc của SRT 2 (-20ms) & SRT 4 (+20ms)
           để lắp khoảng trống vào SRT 3, giúp SRT 3 mở rộng thêm đúng +40ms (0.04s).
        """
        # Với target_cps=14.0, text 28 ký tự cần: 2000 (speech) + 350 (tail_pad) + 50 (head) + 120 (tail) = 2520ms
        text_2520 = "A" * 28
        req_ms = estimate_required_ms(
            text_2520,
            2520,
            target_cps=14.0,
            tts_head_ms=50,
            tts_tail_ms=120,
            short_text_max_chars=14,
            short_timeline_max_ms=1500,
        )
        self.assertEqual(req_ms, 2520)

        # Thiết lập 5 SRT liền kề:
        # SRT 1: 0 -> 2540 (dư 20ms)
        # SRT 2: 2540 -> 5060 (2520ms = đủ)
        # SRT 3: 5060 -> 7540 (2480ms = thiếu 40ms)
        # SRT 4: 7540 -> 10060 (2520ms = đủ)
        # SRT 5: 10060 -> 12600 (2540ms = dư 20ms)
        blocks = [
            _block(1, "00:00:00,000", "00:00:02,540", text_2520),
            _block(2, "00:00:02,540", "00:00:05,060", text_2520),
            _block(3, "00:00:05,060", "00:00:07,540", text_2520),
            _block(4, "00:00:07,540", "00:00:10,060", text_2520),
            _block(5, "00:00:10,060", "00:00:12,600", text_2520),
        ]
        out, report = optimize_subtitle_timings(blocks, **self.kw)

        # Kiểm tra SRT 1 thu gọn 20ms ở cuối
        self.assertEqual(_start_ms(out[0]), 0)
        self.assertEqual(_end_ms(out[0]), 2520)

        # Kiểm tra SRT 2 dịch lùi 20ms, giữ nguyên độ dài 2520ms
        self.assertEqual(_start_ms(out[1]), 2520)
        self.assertEqual(_end_ms(out[1]), 5040)
        self.assertEqual(_end_ms(out[1]) - _start_ms(out[1]), 2520)

        # Kiểm tra SRT 3 mở rộng thêm 40ms (từ 2480ms lên 2520ms: 5040 -> 7560)
        self.assertEqual(_start_ms(out[2]), 5040)
        self.assertEqual(_end_ms(out[2]), 7560)
        self.assertEqual(_end_ms(out[2]) - _start_ms(out[2]), 2520)

        # Kiểm tra SRT 4 dịch tiến 20ms, giữ nguyên độ dài 2520ms
        self.assertEqual(_start_ms(out[3]), 7560)
        self.assertEqual(_end_ms(out[3]), 10080)
        self.assertEqual(_end_ms(out[3]) - _start_ms(out[3]), 2520)

        # Kiểm tra SRT 5 lùi điểm bắt đầu +20ms, giữ nguyên điểm kết thúc 12600ms
        self.assertEqual(_start_ms(out[4]), 10080)
        self.assertEqual(_end_ms(out[4]), 12600)
        self.assertEqual(_end_ms(out[4]) - _start_ms(out[4]), 2520)

        self.assertEqual(report.rebalanced, 1)

    def test_rebalance_distant_gaps_via_shifting_neighbors(self):
        """
        Khi SRT 1..5 đều chỉ vừa đủ (không dư nội tại), nhưng giữa SRT 1-2 có gap dư 20ms
        và giữa SRT 4-5 có gap dư 20ms -> dịch SRT 2 và SRT 4 để lấy 40ms cho SRT 3.
        """
        text_2520 = "A" * 28
        # min_gap_ms = 10 -> để lấy được 20ms từ gap thì gap = 30ms (> min_borrow_gap_ms=20)
        blocks = [
            _block(1, "00:00:00,000", "00:00:02,520", text_2520),
            # gap 30ms (dư 20ms sau khi chừa min_gap_ms=10)
            _block(2, "00:00:02,550", "00:00:05,070", text_2520),
            # SRT 3 thiếu 40ms (2480ms)
            _block(3, "00:00:05,070", "00:00:07,550", text_2520),
            _block(4, "00:00:07,550", "00:00:10,070", text_2520),
            # gap 30ms (dư 20ms sau khi chừa min_gap_ms=10)
            _block(5, "00:00:10,100", "00:00:12,620", text_2520),
        ]
        out, report = optimize_subtitle_timings(blocks, **self.kw)

        # SRT 2 lùi 20ms (2530 -> 5050)
        self.assertEqual(_start_ms(out[1]), 2530)
        self.assertEqual(_end_ms(out[1]), 5050)
        # SRT 3 mở rộng 40ms (5050 -> 7570 = 2520ms)
        self.assertEqual(_start_ms(out[2]), 5050)
        self.assertEqual(_end_ms(out[2]), 7570)
        # SRT 4 tiến 20ms (7570 -> 10090)
        self.assertEqual(_start_ms(out[3]), 7570)
        self.assertEqual(_end_ms(out[3]), 10090)
        self.assertEqual(report.rebalanced, 1)

    def test_rebalance_caps_first_earlier_shift_at_400ms(self):
        text_2520 = "A" * 28
        blocks = [
            # Cue 1 has 1000ms surplus; cue 3 lacks 1000ms.
            _block(1, "00:00:00,000", "00:00:03,520", text_2520),
            _block(2, "00:00:03,520", "00:00:06,040", text_2520),
            _block(3, "00:00:06,040", "00:00:07,560", text_2520),
            _block(4, "00:00:07,560", "00:00:10,080", text_2520),
        ]

        out, report = optimize_subtitle_timings(blocks, **self.kw)

        self.assertEqual(_start_ms(out[1]), 3520 - 400)
        self.assertEqual(_start_ms(out[2]), 6040 - 400)
        self.assertEqual(report.max_abs_start_shift_ms, 400)
        self.assertGreater(report.start_shift_capped, 0)

    def test_rebalance_allows_multiple_subtractions_with_cumulative_budget(self):
        text_2520 = "A" * 28
        blocks = [
            # Cue 2 first borrows 300ms from cue 1.
            _block(1, "00:00:00,000", "00:00:03,120", text_2520),
            _block(2, "00:00:03,120", "00:00:05,340", text_2520),
            # Cue 3 asks for another 300ms through cue 2, but cue 2 has only
            # 100ms left in its cumulative subtraction budget.
            _block(3, "00:00:05,340", "00:00:07,560", text_2520),
        ]

        out, report = optimize_subtitle_timings(blocks, **self.kw)

        self.assertEqual(_start_ms(out[1]), 3120 - 400)
        self.assertEqual(_start_ms(out[2]), 5340 - 100)
        self.assertEqual(_end_ms(out[2]) - _start_ms(out[2]), 2320)
        self.assertEqual(report.max_abs_start_shift_ms, 400)
        self.assertGreater(report.start_shift_capped, 0)


if __name__ == "__main__":
    unittest.main()
