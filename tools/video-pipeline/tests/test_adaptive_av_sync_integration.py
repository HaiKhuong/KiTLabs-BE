"""Integration & rerender-idempotency tests for Adaptive AV Sync in auto_vietsub_pro.py."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import soundfile as sf

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

import auto_vietsub_pro as avp  # noqa: E402


def _make_speech_wav(path: Path, duration_sec: float, sr: int = 24000) -> None:
    n = max(1, int(round(duration_sec * sr)))
    t = np.arange(n, dtype=np.float32) / float(sr)
    wave = (0.25 * np.sin(2.0 * np.pi * 220.0 * t)).astype(np.float32)
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), wave, sr, subtype="PCM_16")


class TestAdaptiveAVSyncIntegration(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="test_av_sync_int_")
        self.root = Path(self._tmp.name)
        self._orig_work_name = avp.WORK_NAME
        self._orig_video_dir = avp.VIDEO_DIR
        self._orig_sub_dir = avp.SUBTITLE_DIR
        self._orig_log_dir = avp.LOG_DIR
        self._orig_log_path = avp.LOG_PATH
        self._orig_ffmpeg = avp.FFMPEG_BIN
        self._orig_ffprobe = avp.FFPROBE_BIN

        avp.WORK_NAME = "demo_movie"
        avp.VIDEO_DIR = self.root / "videos"
        avp.SUBTITLE_DIR = self.root / "subtitles"
        avp.LOG_DIR = self.root / "logs"
        avp.LOG_PATH = avp.LOG_DIR / "pipeline.log"
        avp.VIDEO_DIR.mkdir(parents=True, exist_ok=True)
        avp.SUBTITLE_DIR.mkdir(parents=True, exist_ok=True)
        avp.LOG_DIR.mkdir(parents=True, exist_ok=True)
        avp.FFMPEG_BIN = avp.FFMPEG_BIN or "ffmpeg"
        avp.FFPROBE_BIN = avp.FFPROBE_BIN or "ffprobe"

    def tearDown(self):
        avp.WORK_NAME = self._orig_work_name
        avp.VIDEO_DIR = self._orig_video_dir
        avp.SUBTITLE_DIR = self._orig_sub_dir
        avp.LOG_DIR = self._orig_log_dir
        avp.LOG_PATH = self._orig_log_path
        avp.FFMPEG_BIN = self._orig_ffmpeg
        avp.FFPROBE_BIN = self._orig_ffprobe
        self._tmp.cleanup()

    def test_step3_tier2_stretch_and_rerender_idempotency(self):
        vi_srt = avp.get_vi_srt_path()
        vi_srt.write_text(
            "1\n00:00:01,000 --> 00:00:03,000\nCâu một vừa đủ.\n\n"
            "2\n00:00:03,000 --> 00:00:05,000\nCâu hai rất dài cần kéo giãn video.\n\n"
            "3\n00:00:05,000 --> 00:00:07,000\nCâu ba phía sau.\n",
            encoding="utf-8",
        )
        orig_srt_bytes = vi_srt.read_bytes()

        w1 = avp.LOG_DIR / "tts_chunks" / "raw_0000_clean.wav"
        w2 = avp.LOG_DIR / "tts_chunks" / "raw_0001_clean.wav"
        w3 = avp.LOG_DIR / "tts_chunks" / "raw_0002_clean.wav"
        _make_speech_wav(w1, 1.80)  # <= 2.00s (native fit)
        _make_speech_wav(w2, 3.24)  # 3.24 / 1.20 = 2.70s -> stretch = 2.70 / 2.00 = 1.35x (0.74x speed)
        _make_speech_wav(w3, 1.90)  # <= 2.00s (native fit)

        raw_segments = [
            {
                "index": 1,
                "start_time": 1.0,
                "end_time": 3.0,
                "text": "Câu một vừa đủ.",
                "audio_path": str(w1),
                "available_duration": 2.0,
            },
            {
                "index": 2,
                "start_time": 3.0,
                "end_time": 5.0,
                "text": "Câu hai rất dài cần kéo giãn video.",
                "audio_path": str(w2),
                "available_duration": 2.0,
            },
            {
                "index": 3,
                "start_time": 5.0,
                "end_time": 7.0,
                "text": "Câu ba phía sau.",
                "audio_path": str(w3),
                "available_duration": 2.0,
            },
        ]

        out_voice = avp.VIDEO_DIR / f"{avp.WORK_NAME}_voice.wav"

        # Lần chạy 1 (Step 3)
        avp._run_step3_adaptive_av_sync(
            srt_path=vi_srt,
            raw_segments=raw_segments,
            out_voice_wav=out_voice,
            orig_video_duration_sec=8.0,
        )

        # Canonical vi.srt KHÔNG bị ghi đè!
        self.assertEqual(vi_srt.read_bytes(), orig_srt_bytes)

        meta_1 = json.loads(avp.get_adaptive_av_sync_meta_path().read_text(encoding="utf-8"))
        self.assertEqual(len(meta_1["stretch_intervals"]), 1)
        iv1 = meta_1["stretch_intervals"][0]
        self.assertEqual(iv1["segment_index"], 2)
        self.assertAlmostEqual(iv1["stretch_factor"], 1.35, places=3)  # 1/1.35 ≈ 0.74x speed
        self.assertAlmostEqual(iv1["delta_t"], 0.70, places=3)
        self.assertAlmostEqual(meta_1["final_video_duration_sec"], 8.70, places=3)

        # Kiểm tra Step 5 chọn vi_synced.srt (câu 3 đã được dịch +0.70s -> 00:00:05,700)
        resolved_srt = avp._resolve_ass_source_srt(vi_srt)
        self.assertEqual(resolved_srt, avp.get_vi_synced_srt_path())
        synced_text = resolved_srt.read_text(encoding="utf-8")
        self.assertIn("00:00:05,700 --> 00:00:07,", synced_text)

        # Lần chạy 2 (Mô phỏng Rerender Step 3-6): kết quả PHẢI giống hệt, không nhân đôi 0.74x!
        avp._run_step3_adaptive_av_sync(
            srt_path=vi_srt,
            raw_segments=raw_segments,
            out_voice_wav=out_voice,
            orig_video_duration_sec=8.0,
        )
        meta_2 = json.loads(avp.get_adaptive_av_sync_meta_path().read_text(encoding="utf-8"))
        self.assertEqual(len(meta_2["stretch_intervals"]), 1)
        self.assertAlmostEqual(meta_2["stretch_intervals"][0]["stretch_factor"], 1.35, places=3)
        self.assertAlmostEqual(meta_2["final_video_duration_sec"], 8.70, places=3)

        # Mô phỏng Rerender Step 5-6 (gọi build_unified_render_command 2 lần)
        intervals, orig_dur, _ = avp._load_valid_adaptive_av_sync(vi_srt)
        dummy_video = self.root / "input.mp4"
        dummy_video.write_bytes(b"")
        dummy_ass = avp.SUBTITLE_DIR / "sub.ass"
        dummy_ass.write_text("[Script Info]\n", encoding="utf-8")

        cmd1 = avp.build_unified_render_command(
            video_path=dummy_video,
            out_path=avp.VIDEO_DIR / "out1.mp4",
            ass_path=dummy_ass,
            voice_path=out_voice,
            use_gpu=False,
            logo_path=None,
            overlay_text_path=None,
            ai_film_path=None,
            outro_path=None,
            probe_wh=(1920, 1080),
            has_video_audio=True,
            outro_has_audio=False,
            stretch_intervals=intervals,
            orig_video_duration_sec=orig_dur,
            source_fps=30.0,
        )
        script_text_1 = (avp.LOG_DIR / "unified_filter_complex.txt").read_text(encoding="utf-8")

        cmd2 = avp.build_unified_render_command(
            video_path=dummy_video,
            out_path=avp.VIDEO_DIR / "out2.mp4",
            ass_path=dummy_ass,
            voice_path=out_voice,
            use_gpu=False,
            logo_path=None,
            overlay_text_path=None,
            ai_film_path=None,
            outro_path=None,
            probe_wh=(1920, 1080),
            has_video_audio=True,
            outro_has_audio=False,
            stretch_intervals=intervals,
            orig_video_duration_sec=orig_dur,
            source_fps=30.0,
        )
        script_text_2 = (avp.LOG_DIR / "unified_filter_complex.txt").read_text(encoding="utf-8")

        self.assertEqual(script_text_1, script_text_2)
        self.assertIn("setpts=1.350000*(PTS-STARTPTS)", script_text_1)
        self.assertIn("atempo=0.740741", script_text_1)
        self.assertTrue(any(flag in cmd1 for flag in ("-/filter_complex", "-filter_complex_script")))
        self.assertTrue(any(flag in cmd2 for flag in ("-/filter_complex", "-filter_complex_script")))

    def test_stale_meta_ignored_when_vi_srt_modified(self):
        vi_srt = avp.get_vi_srt_path()
        vi_srt.write_text("1\n00:00:01,000 --> 00:00:03,000\nBản gốc.\n", encoding="utf-8")
        w1 = avp.LOG_DIR / "tts_chunks" / "raw_0000_clean.wav"
        _make_speech_wav(w1, 3.24)
        avp._run_step3_adaptive_av_sync(
            srt_path=vi_srt,
            raw_segments=[
                {
                    "index": 1,
                    "start_time": 1.0,
                    "end_time": 3.0,
                    "text": "Bản gốc.",
                    "audio_path": str(w1),
                    "available_duration": 2.0,
                }
            ],
            out_voice_wav=avp.VIDEO_DIR / f"{avp.WORK_NAME}_voice.wav",
            orig_video_duration_sec=4.0,
        )

        # User edits vi.srt without rerunning Step 3
        vi_srt.write_text("1\n00:00:01,000 --> 00:00:03,000\nBản đã sửa.\n", encoding="utf-8")
        intervals, _orig_dur, _synced = avp._load_valid_adaptive_av_sync(vi_srt)
        self.assertEqual(intervals, [])
        self.assertEqual(avp._resolve_ass_source_srt(vi_srt), vi_srt)

    def test_invalidate_step3_cache_when_vi_srt_changed(self):
        vi_srt = avp.get_vi_srt_path()
        vi_srt.write_text("1\n00:00:01,000 --> 00:00:03,000\nBản gốc.\n", encoding="utf-8")
        w1 = avp.LOG_DIR / "tts_chunks" / "raw_0000_clean.wav"
        _make_speech_wav(w1, 3.24)
        out_voice = avp.VIDEO_DIR / f"{avp.WORK_NAME}_voice.wav"
        avp._run_step3_adaptive_av_sync(
            srt_path=vi_srt,
            raw_segments=[
                {
                    "index": 1,
                    "start_time": 1.0,
                    "end_time": 3.0,
                    "text": "Bản gốc.",
                    "audio_path": str(w1),
                    "available_duration": 2.0,
                }
            ],
            out_voice_wav=out_voice,
            orig_video_duration_sec=4.0,
        )
        self.assertTrue(out_voice.is_file())

        # Khi vi.srt không đổi -> giữ nguyên cache voice
        avp._invalidate_step3_cache_if_vi_srt_changed(vi_srt, out_voice)
        self.assertTrue(out_voice.is_file())
        self.assertTrue(avp.get_adaptive_av_sync_meta_path().is_file())

        # Khi vi.srt bị sửa -> tự động xóa cache voice & metadata cũ để Step 3 tính lại
        vi_srt.write_text("1\n00:00:01,000 --> 00:00:03,000\nBản đã sửa.\n", encoding="utf-8")
        avp._invalidate_step3_cache_if_vi_srt_changed(vi_srt, out_voice)
        self.assertFalse(out_voice.is_file())
        self.assertFalse(avp.get_adaptive_av_sync_meta_path().is_file())
        self.assertFalse(avp.get_vi_synced_srt_path().is_file())


if __name__ == "__main__":
    unittest.main()

