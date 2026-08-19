"""Unit tests for omnivoice_tts batch helpers (no model load)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from omnivoice_tts import (  # noqa: E402
    _synthesize_many_chunk,
    synthesize_many_to_wavs,
)


class TestSynthesizeManyChunkValidation(unittest.TestCase):
    def test_valid_out_wavs_does_not_raise_typeerror(self):
        """Regression: `any(not out_wavs)` treated a bool as iterable."""
        chunk = [
            {"text": "Xin chào", "out_wav": "a.wav"},
            {"text": "Tạm biệt", "out_wav": "b.wav"},
        ]
        with patch("omnivoice_tts.synthesize_batch_to_wavs") as batch:
            _synthesize_many_chunk(chunk, shared_kw={}, fallback_sequential=True)
        batch.assert_called_once()
        _, kwargs = batch.call_args
        self.assertEqual(kwargs["texts"], ["Xin chào", "Tạm biệt"])
        self.assertEqual(kwargs["out_wavs"], ["a.wav", "b.wav"])

    def test_missing_out_wav_raises_valueerror(self):
        chunk = [
            {"text": "Xin chào", "out_wav": "a.wav"},
            {"text": "Thiếu path", "out_wav": None},
        ]
        with patch("omnivoice_tts.synthesize_batch_to_wavs") as batch:
            with self.assertRaisesRegex(ValueError, "thiếu out_wav"):
                _synthesize_many_chunk(chunk, shared_kw={}, fallback_sequential=True)
        batch.assert_not_called()

    def test_empty_out_wav_raises_valueerror(self):
        chunk = [{"text": "Xin chào", "out_wav": ""}]
        with patch("omnivoice_tts.synthesize_batch_to_wavs") as batch:
            with self.assertRaisesRegex(ValueError, "thiếu out_wav"):
                _synthesize_many_chunk(chunk, shared_kw={}, fallback_sequential=True)
        batch.assert_not_called()

    def test_missing_text_raises_valueerror(self):
        chunk = [{"text": "  ", "out_wav": "a.wav"}]
        with patch("omnivoice_tts.synthesize_batch_to_wavs") as batch:
            with self.assertRaisesRegex(ValueError, "thiếu text"):
                _synthesize_many_chunk(chunk, shared_kw={}, fallback_sequential=True)
        batch.assert_not_called()


class TestSynthesizeManyChunkFallback(unittest.TestCase):
    def test_batch_failure_falls_back_sequential(self):
        chunk = [
            {"text": "Một", "out_wav": "a.wav"},
            {"text": "Hai", "out_wav": "b.wav"},
        ]
        with patch(
            "omnivoice_tts.synthesize_batch_to_wavs",
            side_effect=RuntimeError("batch boom"),
        ):
            with patch("omnivoice_tts.synthesize_to_wav") as sequential:
                _synthesize_many_chunk(chunk, shared_kw={"seed": 1}, fallback_sequential=True)
        self.assertEqual(sequential.call_count, 2)

    def test_batch_failure_without_fallback_raises(self):
        chunk = [
            {"text": "Một", "out_wav": "a.wav"},
            {"text": "Hai", "out_wav": "b.wav"},
        ]
        with patch(
            "omnivoice_tts.synthesize_batch_to_wavs",
            side_effect=RuntimeError("batch boom"),
        ):
            with self.assertRaisesRegex(RuntimeError, "batch boom"):
                _synthesize_many_chunk(chunk, shared_kw={}, fallback_sequential=False)


class TestSynthesizeManyToWavs(unittest.TestCase):
    def test_splits_into_batches(self):
        items = [
            {"text": f"câu {i}", "out_wav": f"{i}.wav"} for i in range(5)
        ]
        with patch("omnivoice_tts._synthesize_many_chunk") as chunk_fn:
            synthesize_many_to_wavs(
                items,
                batch_size=2,
                ref_audio="ref.wav",
                ref_text="ref",
                model_id="m",
                device_map="cpu",
            )
        self.assertEqual(chunk_fn.call_count, 3)
        sizes = [len(call.args[0]) for call in chunk_fn.call_args_list]
        self.assertEqual(sizes, [2, 2, 1])


if __name__ == "__main__":
    unittest.main()
