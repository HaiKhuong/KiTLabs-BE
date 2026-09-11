"""Narrato unit tests: script normalize, Gemini keys, English prompts, Whisper language=vi."""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "narrato"))

from gemini_client import load_keys  # noqa: E402
from prompts import COPY_TEMPLATE, MATCH_TEMPLATE, MIX_SCRIPT_TEMPLATE, PLOT_TEMPLATE  # noqa: E402
from script import normalize_items, orig_marker  # noqa: E402


class TestNarratoScript(unittest.TestCase):
    def test_normalize_items_ost1_orig_marker(self) -> None:
        items = normalize_items(
            {
                "items": [
                    {
                        "_id": 1,
                        "video_id": 1,
                        "video_name": "a.mp4",
                        "timestamp": "00:00:01,000-00:00:05,000",
                        "picture": "hook",
                        "narration": "Hello world",
                        "OST": 0,
                    },
                    {
                        "_id": 2,
                        "video_id": 1,
                        "video_name": "a.mp4",
                        "timestamp": "00:00:06,000-00:00:12,000",
                        "picture": "peak",
                        "narration": "whatever",
                        "OST": 1,
                    },
                ]
            },
            "a.mp4",
        )
        self.assertEqual(items[0]["narration"], "Hello world")
        self.assertEqual(items[1]["narration"], orig_marker(2))
        self.assertEqual(items[1]["OST"], 1)

    def test_reject_empty_items(self) -> None:
        with self.assertRaises(ValueError):
            normalize_items({"items": []})


class TestGeminiKeys(unittest.TestCase):
    def test_vip_prefers_vip_env(self) -> None:
        with patch.dict(
            os.environ,
            {"GEMINI_API_KEY_VIP": "vip1,vip2", "GEMINI_API_KEY": "norm"},
            clear=False,
        ):
            self.assertEqual(load_keys("vip"), ["vip1", "vip2"])

    def test_normal_uses_standard_key(self) -> None:
        with patch.dict(
            os.environ,
            {"GEMINI_API_KEY_VIP": "vip1", "GEMINI_API_KEY": "norm-a,norm-b"},
            clear=False,
        ):
            self.assertEqual(load_keys("normal"), ["norm-a", "norm-b"])
            self.assertEqual(load_keys("standard"), ["norm-a", "norm-b"])


class TestPromptsEnglish(unittest.TestCase):
    def test_no_cjk_instructions(self) -> None:
        blob = PLOT_TEMPLATE + COPY_TEMPLATE + MATCH_TEMPLATE + MIX_SCRIPT_TEMPLATE
        self.assertNotRegex(blob, r"[\u4e00-\u9fff]")
        self.assertNotRegex(blob, r"[\u3040-\u30ff]")
        self.assertIn("ORIG", MATCH_TEMPLATE)
        self.assertIn("Closing wrap", COPY_TEMPLATE)
        self.assertIn("last 1–2 items MUST be OST=0", MATCH_TEMPLATE)


class TestWhisperLanguage(unittest.TestCase):
    def test_transcribe_passes_vi(self) -> None:
        from asr import run_asr

        fake_seg = MagicMock()
        fake_seg.start = 0.0
        fake_seg.end = 1.0
        fake_seg.text = "xin chao"
        fake_info = MagicMock()
        fake_info.language = "vi"

        work = Path(__file__).resolve().parent / "_tmp_narrato_work"
        work.mkdir(exist_ok=True)
        video = work / "dummy.mp4"
        video.write_bytes(b"x")

        fake_model = MagicMock()
        fake_model.transcribe.return_value = ([fake_seg], fake_info)
        fake_fw = MagicMock()
        fake_fw.WhisperModel = MagicMock(return_value=fake_model)
        with (
            patch("asr.has_audio_stream", return_value=True),
            patch("asr.extract_wav"),
            patch.dict("sys.modules", {"faster_whisper": fake_fw}),
        ):
            result = run_asr(video, work, language="vi")
        fake_model.transcribe.assert_called()
        self.assertEqual(fake_model.transcribe.call_args.kwargs.get("language"), "vi")
        self.assertEqual(result["language"], "vi")


class TestTtsEngineSwitch(unittest.TestCase):
    def test_normalize_engine_aliases(self) -> None:
        from tts import normalize_tts_engine

        self.assertEqual(normalize_tts_engine("edge_tts"), "edge")
        self.assertEqual(normalize_tts_engine("OmniVoice"), "omnivoice")
        self.assertEqual(normalize_tts_engine("voxcpm"), "voxcpm2")
        self.assertEqual(normalize_tts_engine(""), "edge")

    def test_language_from_narration_label(self) -> None:
        from tts import resolve_tts_language

        self.assertEqual(resolve_tts_language("Vietnamese (Vietnam)"), "vietnamese")
        self.assertEqual(resolve_tts_language("en"), "english")
        self.assertEqual(resolve_tts_language("vi"), "vietnamese")

    def test_omnivoice_does_not_call_edge(self) -> None:
        from tts import synthesize_clip

        out = Path(__file__).resolve().parent / "_tmp_narrato_work" / "ov.wav"
        out.parent.mkdir(exist_ok=True)
        if out.exists():
            out.unlink()

        def _write(*_a: object, **_k: object) -> None:
            out.write_bytes(b"RIFF....")

        with (
            patch("tts.resolve_ref_audio", return_value=Path("ref.wav")),
            patch("tts._omnivoice_tts", side_effect=_write) as ov,
            patch("tts._voxcpm2_tts") as vx,
            patch("tts._edge_tts") as edge,
        ):
            ok = synthesize_clip(
                "xin chao",
                out,
                engine="omnivoice",
                ref_audio="RongConVietsub.wav",
                ref_text="hello",
                language="vi",
            )
        self.assertTrue(ok)
        ov.assert_called_once()
        edge.assert_not_called()
        vx.assert_not_called()

    def test_voxcpm2_does_not_call_edge(self) -> None:
        from tts import synthesize_clip

        out = Path(__file__).resolve().parent / "_tmp_narrato_work" / "vx.wav"
        out.parent.mkdir(exist_ok=True)
        if out.exists():
            out.unlink()

        def _write(*_a: object, **_k: object) -> None:
            out.write_bytes(b"RIFF....")

        with (
            patch("tts.resolve_ref_audio", return_value=Path("ref.wav")),
            patch("tts._voxcpm2_tts", side_effect=_write) as vx,
            patch("tts._omnivoice_tts") as ov,
            patch("tts._edge_tts") as edge,
        ):
            ok = synthesize_clip(
                "xin chao",
                out,
                engine="voxcpm2",
                ref_audio="clone.wav",
                ref_text="hello",
                language="vietnamese",
            )
        self.assertTrue(ok)
        vx.assert_called_once()
        ov.assert_not_called()
        edge.assert_not_called()

    def test_edge_does_not_call_clone_engines(self) -> None:
        from tts import synthesize_clip

        out = Path(__file__).resolve().parent / "_tmp_narrato_work" / "edge.wav"
        out.parent.mkdir(exist_ok=True)
        if out.exists():
            out.unlink()

        def _to_wav(_src: Path, dst: Path) -> None:
            dst.write_bytes(b"RIFF....")

        with (
            patch("tts._edge_tts", return_value=True) as edge,
            patch("tts._to_wav", side_effect=_to_wav),
            patch("tts._omnivoice_tts") as ov,
            patch("tts._voxcpm2_tts") as vx,
        ):
            ok = synthesize_clip("xin chao", out, engine="edge", voice="vi-VN-HoaiMyNeural", rate="+10%")
        self.assertTrue(ok)
        edge.assert_called_once()
        ov.assert_not_called()
        vx.assert_not_called()


class TestOst0ClipDuration(unittest.TestCase):
    def test_follows_tts_not_timestamp(self) -> None:
        from render import ost0_clip_duration

        self.assertAlmostEqual(ost0_clip_duration(8.4, 2.0), 8.4)
        self.assertAlmostEqual(ost0_clip_duration(0.0, 5.0), 0.04)


class TestNarratoMergeTimeline(unittest.TestCase):
    def test_tts_overlay_skips_ost1_gaps(self) -> None:
        from audio_merger import tts_overlay_timeline

        work = Path(__file__).resolve().parent / "_tmp_narrato_work"
        work.mkdir(exist_ok=True)
        tts = work / "a.wav"
        tts.write_bytes(b"RIFF")
        total, overlays = tts_overlay_timeline(
            [
                {"_id": 1, "OST": 0, "duration": 8.0, "audio": str(tts)},
                {"_id": 2, "OST": 1, "duration": 3.0, "audio": ""},
                {"_id": 3, "OST": 0, "duration": 5.0, "audio": str(tts)},
            ]
        )
        self.assertAlmostEqual(total, 16.0)
        self.assertEqual(len(overlays), 2)
        self.assertAlmostEqual(overlays[0][0], 0.0)
        self.assertAlmostEqual(overlays[1][0], 11.0)

    def test_calculate_end_time_from_tts_duration(self) -> None:
        from clip_video import calculate_end_time

        self.assertEqual(calculate_end_time("00:00:10,000", 8.5, extra_seconds=0), "00:00:18,500")


if __name__ == "__main__":
    unittest.main()
