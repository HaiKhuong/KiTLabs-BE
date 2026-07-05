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


def _default_audio_data_root() -> Path:
    return _DEFAULT_AUDIO_DATA_ROOT.resolve()


def _sanitize_audio_path(raw: str, fallback: Path, label: str) -> Path:
    resolved = Path(raw).expanduser().resolve()
    if _is_placeholder_path(resolved):
        import sys

        print(
            f"[audio] {label}={raw!r} là placeholder — dùng {fallback}. "
            "Sửa hoặc xóa dòng này trong .env / systemd.",
            file=sys.stderr,
        )
        return fallback
    return resolved


def resolve_audio_data_root() -> Path:
    raw = (os.getenv("AUDIO_DATA_ROOT") or os.getenv("KITLABS_AUDIO_DATA_ROOT") or "").strip()
    if raw:
        return _sanitize_audio_path(raw, _default_audio_data_root(), "AUDIO_DATA_ROOT")
    return _default_audio_data_root()


def resolve_audio_output_dir() -> Path:
    raw = (os.getenv("AUDIO_OUTPUT_DIR") or "").strip()
    if raw:
        fallback = (resolve_audio_data_root() / "audio-tts").resolve()
        return _sanitize_audio_path(raw, fallback, "AUDIO_OUTPUT_DIR")
    return (resolve_audio_data_root() / "audio-tts").resolve()


def build_output_wav_path(user_id: str, job_id: str) -> Path:
    """``{AUDIO_OUTPUT_DIR}/{userId}/{jobId}.wav`` — khớp ``AudioService.buildOutputPath``."""
    out_dir = resolve_audio_output_dir() / str(user_id)
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir / f"{job_id}.wav"
