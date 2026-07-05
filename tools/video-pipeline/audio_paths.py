"""
Đường dẫn output TTS — cùng env với Nest ``src/tools/audio/audio.constants.ts``.

  AUDIO_DATA_ROOT      → mặc định ``<repo>/uploads``
  AUDIO_OUTPUT_DIR     → mặc định ``{AUDIO_DATA_ROOT}/audio-tts`` (ghi đè tùy chọn)
  KITLABS_AUDIO_DATA_ROOT — alias của AUDIO_DATA_ROOT
"""

from __future__ import annotations

import os
from pathlib import Path

_PIPELINE_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _PIPELINE_DIR.parent.parent
_DEFAULT_AUDIO_DATA_ROOT = _REPO_ROOT / "uploads"

_AUDIO_DATA_PLACEHOLDERS = frozenset({"/path", "/path/", "path", "/tmp/path"})


def _is_placeholder_path(resolved: Path) -> bool:
    key = str(resolved).replace("\\", "/").lower()
    return key in _AUDIO_DATA_PLACEHOLDERS or key.endswith("/path")


def resolve_audio_data_root() -> Path:
    raw = (os.getenv("AUDIO_DATA_ROOT") or os.getenv("KITLABS_AUDIO_DATA_ROOT") or "").strip()
    if raw:
        resolved = Path(raw).expanduser().resolve()
        if _is_placeholder_path(resolved):
            raise ValueError(
                f'AUDIO_DATA_ROOT="{raw}" là placeholder — đặt đường dẫn thật có quyền ghi '
                f"(vd. /var/tmp/kitools-audio hoặc {_DEFAULT_AUDIO_DATA_ROOT})"
            )
        return resolved
    return _DEFAULT_AUDIO_DATA_ROOT.resolve()


def resolve_audio_output_dir() -> Path:
    raw = (os.getenv("AUDIO_OUTPUT_DIR") or "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    return (resolve_audio_data_root() / "audio-tts").resolve()


def build_output_wav_path(user_id: str, job_id: str) -> Path:
    """``{AUDIO_OUTPUT_DIR}/{userId}/{jobId}.wav`` — khớp ``AudioService.buildOutputPath``."""
    out_dir = resolve_audio_output_dir() / str(user_id)
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir / f"{job_id}.wav"
