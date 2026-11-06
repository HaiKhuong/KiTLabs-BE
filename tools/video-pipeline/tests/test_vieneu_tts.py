"""Unit tests for the VieNeu adapter that do not download model weights."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import soundfile as sf

PIPELINE_DIR = Path(__file__).resolve().parents[1]
if str(PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(PIPELINE_DIR))

import vieneu_tts  # noqa: E402
from audio_tts_with_pauses import _resolve_tts_engine  # noqa: E402


class _FakeVieneu:
    sample_rate = vieneu_tts.SAMPLE_RATE

    def infer(self, text: str, **kwargs):
        self.text = text
        self.kwargs = kwargs
        return np.zeros(480, dtype=np.float32)


class VieneuAdapterTests(unittest.TestCase):
    def test_engine_resolution_is_explicit(self) -> None:
        self.assertEqual(_resolve_tts_engine("vieneu"), "vieneu")
        with self.assertRaises(ValueError):
            _resolve_tts_engine("unknown")

    def test_synthesis_writes_48khz_wav(self) -> None:
        fake = _FakeVieneu()
        with tempfile.TemporaryDirectory() as tmp, patch.object(
            vieneu_tts, "get_vieneu_session", return_value=fake
        ):
            ref = Path(tmp) / "ref.wav"
            out = Path(tmp) / "out.wav"
            sf.write(ref, np.zeros(240, dtype=np.float32), 24_000)
            vieneu_tts.synthesize_to_wav(
                text="Xin chào [cười]",
                out_wav=out,
                ref_audio=ref,
                seed=42,
            )
            self.assertTrue(out.is_file())
            self.assertEqual(sf.info(out).samplerate, 48_000)
            self.assertEqual(fake.kwargs["ref_audio"], str(ref.resolve()))


if __name__ == "__main__":
    unittest.main()
