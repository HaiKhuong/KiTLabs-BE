"""TTS dispatch for Narrato render — Edge / OmniVoice / VoxCPM2 from job voice config.

Does not import recap/*.py. Shared engines live in tools/video-pipeline/.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Optional

LOG = logging.getLogger("narrato.tts")

_PIPELINE_DIR = Path(__file__).resolve().parent.parent
if str(_PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(_PIPELINE_DIR))

_ENGINE_ALIASES = {
    "edge": "edge",
    "edge_tts": "edge",
    "edgetts": "edge",
    "azure": "edge",
    "omnivoice": "omnivoice",
    "omni": "omnivoice",
    "omni_voice": "omnivoice",
    "voxcpm2": "voxcpm2",
    "voxcpm": "voxcpm2",
}

_LANG_ALIASES = {
    "vietnamese": "vietnamese",
    "vi": "vietnamese",
    "vie": "vietnamese",
    "english": "english",
    "en": "english",
    "eng": "english",
    "korean": "korean",
    "ko": "korean",
    "kor": "korean",
    "japanese": "japanese",
    "ja": "japanese",
    "jpn": "japanese",
}


def normalize_tts_engine(raw: Any, default: str = "edge") -> str:
    key = str(raw or "").strip().lower().replace("-", "_")
    if not key:
        return default
    return _ENGINE_ALIASES.get(key, key if key in ("edge", "omnivoice", "voxcpm2") else default)


def format_edge_rate(raw: Any, default: str = "+0%") -> str:
    if raw is None or raw == "":
        return default
    text = str(raw).strip()
    if re.match(r"^[+-]?\d+(\.\d+)?%$", text):
        return text if text.startswith(("+", "-")) else f"+{text}"
    try:
        pct = float(text)
        rounded = int(round(pct))
        return f"+{rounded}%" if rounded >= 0 else f"{rounded}%"
    except (TypeError, ValueError):
        return default


def resolve_tts_language(*candidates: Any) -> str:
    for raw in candidates:
        text = str(raw or "").strip().lower().replace("-", "_")
        if not text:
            continue
        if text in _LANG_ALIASES:
            return _LANG_ALIASES[text]
        if "vietnam" in text:
            return "vietnamese"
        if text.startswith("english"):
            return "english"
        if text.startswith("korean") or text.startswith("hangul"):
            return "korean"
        if text.startswith("japan"):
            return "japanese"
    return "vietnamese"


def _env_flag(name: str, default: bool = True) -> bool:
    raw = os.getenv(name)
    if raw is None or str(raw).strip() == "":
        return default
    return str(raw).strip().lower() in ("1", "true", "yes", "on")


def _resolve_voice_dir() -> Path:
    raw = (os.getenv("PIPELINE_VOICE_DIR") or os.getenv("AUDIO_PIPELINE_VOICE_DIR") or "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    return (_PIPELINE_DIR / "voice").resolve()


def resolve_ref_audio(ref_wav: str | None) -> Path:
    name = str(ref_wav or "").strip()
    if not name:
        raise ValueError("omnivoiceRefWav is required for OmniVoice / VoxCPM2")
    p = Path(name).expanduser()
    if p.is_absolute() and p.is_file():
        return p.resolve()
    candidates = [
        _resolve_voice_dir() / (p.name if p.is_absolute() else name),
        _PIPELINE_DIR / "voice" / Path(name).name,
    ]
    for candidate in candidates:
        resolved = candidate.expanduser().resolve()
        if resolved.is_file():
            return resolved
    raise FileNotFoundError(f"TTS ref audio not found: {name}")


def _resolve_seed(env_key: str, default: str = "42") -> Optional[int]:
    raw = (os.getenv(env_key) or default).strip()
    if not raw or raw.lower() in ("none", "null"):
        return None
    try:
        return int(raw)
    except ValueError:
        return 42


def _ffmpeg() -> str:
    return (os.environ.get("FFMPEG_BIN") or os.environ.get("FFMPEG_PATH") or "ffmpeg").strip() or "ffmpeg"


def _to_wav(src: Path, dst: Path) -> None:
    cmd = [
        _ffmpeg(),
        "-y",
        "-i",
        str(src),
        "-ac",
        "1",
        "-ar",
        "44100",
        str(dst),
    ]
    subprocess.check_call(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _prepare_ref_audio(ref_path: Path) -> Path:
    if ref_path.suffix.lower() == ".wav":
        return ref_path
    try:
        from audio_tts_with_pauses import _prepare_ref_audio_for_omnivoice

        return _prepare_ref_audio_for_omnivoice(ref_path)
    except Exception as exc:
        LOG.warning("ref audio prepare failed (%s); using original %s", exc, ref_path)
        return ref_path


def _edge_tts(text: str, out_mp3: Path, voice: str, rate: str) -> bool:
    out_mp3.parent.mkdir(parents=True, exist_ok=True)
    try:
        import edge_tts  # type: ignore

        async def _run() -> None:
            communicate = edge_tts.Communicate(text=text or ".", voice=voice, rate=rate)
            await communicate.save(str(out_mp3))

        asyncio.run(_run())
        if out_mp3.exists() and out_mp3.stat().st_size > 0:
            return True
    except Exception as exc:
        LOG.warning("edge-tts python failed (%s); trying CLI", exc)

    if shutil.which("edge-tts") is None:
        LOG.warning("edge-tts not on PATH")
        return False
    cmd = [
        "edge-tts",
        "--voice",
        voice,
        "--rate",
        rate,
        "--text",
        text or ".",
        "--write-media",
        str(out_mp3),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if proc.returncode != 0:
        LOG.warning("edge-tts CLI failed: %s", (proc.stderr or "")[-500:])
        return False
    return out_mp3.exists() and out_mp3.stat().st_size > 0


def _omnivoice_tts(
    text: str,
    out_wav: Path,
    *,
    ref_path: Path,
    ref_text: str,
    language: str,
) -> None:
    from omnivoice_tts import (
        resolve_omnivoice_device_map,
        resolve_omnivoice_dtype,
        resolve_omnivoice_language,
        synthesize_to_wav,
    )

    synthesize_to_wav(
        text=text or ".",
        out_wav=out_wav,
        ref_audio=str(_prepare_ref_audio(ref_path)),
        ref_text=ref_text,
        model_id=(os.getenv("OMNIVOICE_MODEL_ID") or "k2-fsa/OmniVoice").strip(),
        device_map=resolve_omnivoice_device_map(os.getenv("OMNIVOICE_DEVICE_MAP")),
        dtype_str=resolve_omnivoice_dtype(os.getenv("OMNIVOICE_DTYPE")),
        language=resolve_omnivoice_language(language),
        num_step=int(os.getenv("OMNIVOICE_NUM_STEP") or 32),
        guidance_scale=float(os.getenv("OMNIVOICE_GUIDANCE_SCALE") or 2),
        denoise=_env_flag("OMNIVOICE_DENOISE", True),
        preprocess_prompt=_env_flag("OMNIVOICE_PREPROCESS_PROMPT", True),
        postprocess_output=_env_flag("OMNIVOICE_POSTPROCESS_OUTPUT", True),
        seed=_resolve_seed("OMNIVOICE_SEED"),
    )


def _voxcpm2_tts(
    text: str,
    out_wav: Path,
    *,
    ref_path: Path,
    ref_text: str,
    language: str,
) -> None:
    from voxcpm2_tts import synthesize_to_wav

    synthesize_to_wav(
        text=text or ".",
        out_wav=out_wav,
        ref_audio=str(ref_path),
        ref_text=ref_text,
        model_id=(os.getenv("VOXCPM2_MODEL_ID") or "openbmb/VoxCPM2").strip(),
        language=language,
        cfg_value=float(os.getenv("VOXCPM2_CFG_VALUE") or 2.0),
        inference_timesteps=int(os.getenv("VOXCPM2_INFERENCE_TIMESTEPS") or 10),
        seed=_resolve_seed("VOXCPM2_SEED"),
    )


def synthesize_clip(
    text: str,
    out_wav: Path,
    *,
    engine: str = "edge",
    voice: str = "vi-VN-HoaiMyNeural",
    rate: str = "+0%",
    ref_audio: str | None = None,
    ref_text: str | None = None,
    language: str | None = None,
) -> bool:
    """Synthesize one narration clip. Clone engines raise; Edge returns False on failure."""
    narration = str(text or "").strip()
    if not narration:
        return False
    eng = normalize_tts_engine(engine)
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    lang = resolve_tts_language(language)
    LOG.info("TTS engine=%s voice=%s lang=%s", eng, voice if eng == "edge" else (ref_audio or ""), lang)

    if eng in ("omnivoice", "voxcpm2"):
        ref_path = resolve_ref_audio(ref_audio)
        rt = str(ref_text or "").strip()
        if not rt:
            raise ValueError(f"{eng}: omnivoiceRefText (transcript of ref audio) is required")
        if eng == "voxcpm2":
            _voxcpm2_tts(narration, out_wav, ref_path=ref_path, ref_text=rt, language=lang)
        else:
            _omnivoice_tts(narration, out_wav, ref_path=ref_path, ref_text=rt, language=lang)
        return out_wav.exists() and out_wav.stat().st_size > 0

    mp3 = out_wav.with_suffix(".mp3")
    if not _edge_tts(narration, mp3, voice=voice, rate=format_edge_rate(rate)):
        return False
    _to_wav(mp3, out_wav)
    return out_wav.exists() and out_wav.stat().st_size > 0
