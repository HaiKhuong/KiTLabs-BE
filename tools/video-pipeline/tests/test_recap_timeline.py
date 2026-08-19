"""Tests for voice-master timeline sync (voice vs B-roll duration)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "recap"))

from timeline import _fit_video_cues_to_voice, pack_voice_master_timeline  # noqa: E402


def test_voice_short_video_long_speeds_up_clips():
    """Voice 8s, packed B-roll 12s → adaptive speed ~1.5x, total video ≈ voice."""
    voice_t0 = 0.0
    audio_dur = 8.0
    base_speed = 1.0
    video_cues = [
        {
            "shot": 1,
            "t0": 0.0,
            "t1": 6.0,
            "srcIn": 10.0,
            "srcOut": 16.0,
        },
        {
            "shot": 2,
            "t0": 6.0,
            "t1": 12.0,
            "srcIn": 20.0,
            "srcOut": 26.0,
        },
    ]

    fitted = _fit_video_cues_to_voice(video_cues, audio_dur, voice_t0, base_speed)
    total = sum(float(v["t1"]) - float(v["t0"]) for v in fitted)

    assert len(fitted) == 2
    assert total == pytest_approx(8.0, abs=0.1)
    assert fitted[0]["speed"] == pytest_approx(1.5, abs=0.05)
    assert fitted[1]["speed"] == pytest_approx(1.5, abs=0.05)


def test_voice_long_video_short_extends_last_frame():
    """Voice 10s, B-roll chỉ fill 6s → freeze frame cuối đến hết voice."""
    shots = [{"id": 1, "startSec": 0.0, "endSec": 6.0}]
    tts_meta = [{"audioDur": 10.0, "file": "/tmp/seg_000.wav"}]
    picks = [[1]]
    candidates = [[1]]

    timeline = pack_voice_master_timeline(
        shots=shots,
        picks=picks,
        candidates=candidates,
        tts_meta=tts_meta,
        video_speed=1.0,
    )

    cue = timeline["cues"][0]
    video_total = sum(float(v["t1"]) - float(v["t0"]) for v in cue["video"])
    voice_dur = float(cue["voice"]["t1"]) - float(cue["voice"]["t0"])

    assert video_total == pytest_approx(voice_dur, abs=0.1)
    assert video_total == pytest_approx(10.0, abs=0.1)


def pytest_approx(val, abs=0):  # noqa: A002
    """Minimal approx helper without pytest dependency."""

    class _Approx:
        def __init__(self, expected: float, tolerance: float):
            self.expected = expected
            self.tolerance = tolerance

        def __eq__(self, other: object) -> bool:
            if not isinstance(other, (int, float)):
                return NotImplemented
            return abs(float(other) - self.expected) <= self.tolerance

    return _Approx(val, abs)
