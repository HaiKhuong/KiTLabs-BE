"""
Nest Audio Studio — stdin JSON → audio_tts_with_pauses (gọi omnivoice_tts bên trong).

Đặt AUDIO_PYTHON_SCRIPT trỏ file này, không phải omnivoice_tts.py.
"""

from __future__ import annotations

import json
import sys

import pipeline_cache  # noqa: F401
from audio_tts_with_pauses import synthesize_with_pause_settings


def main() -> None:
    payload = json.load(sys.stdin)
    allowed = {
        "text",
        "out_wav",
        "ref_audio",
        "ref_text",
        "model_id",
        "device_map",
        "dtype_str",
        "language",
        "num_step",
        "guidance_scale",
        "seed",
        "pause_settings",
        "playback_speed",
    }
    kw = {k: v for k, v in payload.items() if k in allowed and v is not None}
    synthesize_with_pause_settings(**kw)


if __name__ == "__main__":
    main()
