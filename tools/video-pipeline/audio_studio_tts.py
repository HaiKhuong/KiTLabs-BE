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
    synthesize_with_pause_settings(**{k: v for k, v in payload.items() if v is not None})


if __name__ == "__main__":
    main()
