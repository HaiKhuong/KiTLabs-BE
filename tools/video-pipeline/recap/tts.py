from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Optional

from progress_log import progress

LOG = logging.getLogger("recap.tts")

# recap/ → video-pipeline/
_PIPELINE_DIR = Path(__file__).resolve().parent.parent
if str(_PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(_PIPELINE_DIR))

# HF/torch cache → ~/.cache/huggingface/hub (trước OmniVoice/VoxCPM2 load)
import recap_cache  # noqa: F401


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


def _resolve_ref_audio(ref_wav: str | None) -> Path:
    name = str(ref_wav or "").strip()
    if not name:
        raise ValueError("omnivoiceRefWav is required for OmniVoice / VoxCPM2")
    p = Path(name).expanduser()
    if not p.is_absolute():
        p = _resolve_voice_dir() / name
    p = p.resolve()
    if not p.is_file():
        raise FileNotFoundError(f"TTS ref audio not found: {p}")
    return p


def _probe_duration(path: Path) -> float:
    if not path.is_file() or path.stat().st_size <= 44:
        raise RuntimeError(f"TTS output missing or too small: {path}")

    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    try:
        out = subprocess.check_output(cmd, text=True, timeout=60).strip()
        dur = float(out)
        if dur > 0:
            return dur
    except (subprocess.CalledProcessError, ValueError, subprocess.TimeoutExpired) as exc:
        LOG.warning("ffprobe duration failed for %s (%s); trying soundfile", path, exc)

    try:
        import soundfile as sf

        info = sf.info(str(path))
        if info.duration and info.duration > 0:
            return float(info.duration)
    except Exception as exc:
        raise RuntimeError(f"Cannot read WAV duration: {path} ({exc})") from exc

    raise RuntimeError(f"Cannot read WAV duration: {path}")


def _tts_row(i: int, text: str, wav: Path, dur: float, engine: str, signature: str) -> dict[str, Any]:
    return {
        "i": i,
        "file": str(wav),
        "audioDur": dur,
        "durationSec": dur,
        "text": text,
        "engine": engine,
        "signature": signature,
    }


def _try_reuse_segment(
    i: int,
    text: str,
    wav: Path,
    signature: str,
) -> dict[str, Any] | None:
    if not wav.is_file() or wav.stat().st_size <= 0:
        return None
    try:
        dur = _probe_duration(wav)
    except (subprocess.CalledProcessError, ValueError, OSError):
        return None
    if dur <= 0:
        return None
    return _tts_row(i, text, wav, dur, signature.split("|", 1)[0], signature)


def synthesize_segments(
    narrations: list[str],
    out_dir: Path,
    engine: str = "edge",
    voice: str = "vi-VN-HoaiMyNeural",
    rate: str = "+0%",
    ref_audio: str | None = None,
    ref_text: str | None = None,
    language: str | None = None,
    *,
    skip_existing: bool = True,
) -> list[dict[str, Any]]:
    out_dir.mkdir(parents=True, exist_ok=True)
    eng = str(engine or "omnivoice").strip().lower()
    signature = "|".join(
        [
            eng,
            str(voice or "").strip(),
            str(rate or "").strip(),
            str(ref_audio or "").strip(),
            str(ref_text or "").strip(),
            str(language or "vietnamese").strip(),
        ]
    )
    prior_meta: list[dict[str, Any]] = []
    prior_path = out_dir.parent / "tts.json"
    if prior_path.is_file():
        try:
            raw = json.loads(prior_path.read_text(encoding="utf-8"))
            if isinstance(raw, list):
                prior_meta = [row for row in raw if isinstance(row, dict)]
        except (json.JSONDecodeError, OSError):
            prior_meta = []

    meta: list[dict[str, Any]] = []
    total = len(narrations)

    def _maybe_reuse(i: int, text: str, wav: Path) -> dict[str, Any] | None:
        if not skip_existing:
            return None
        prev = prior_meta[i] if i < len(prior_meta) else None
        if prev is None:
            return None
        if prev.get("text") != text:
            return None
        prev_sig = str(prev.get("signature") or "")
        if prev_sig and prev_sig != signature:
            return None
        return _try_reuse_segment(i, text, wav, signature)

    if eng in ("omnivoice", "voxcpm2"):
        ref_path = _resolve_ref_audio(ref_audio)
        rt = str(ref_text or "").strip()
        if not rt:
            raise ValueError(f"{eng}: omnivoiceRefText (transcript of ref audio) is required")
        lang = str(language or "vietnamese").strip() or "vietnamese"

        for i, text in enumerate(narrations):
            wav = out_dir / f"seg_{i:03d}.wav"
            cached = _maybe_reuse(i, text, wav)
            if cached:
                meta.append(cached)
                progress(LOG, "TTS", i, total, every=10)
                continue
            if eng == "voxcpm2":
                _voxcpm2_tts(text, wav, ref_path=ref_path, ref_text=rt, language=lang)
            else:
                _omnivoice_tts(text, wav, ref_path=ref_path, ref_text=rt, language=lang)
            dur = _probe_duration(wav)
            meta.append(_tts_row(i, text, wav, dur, eng, signature))
            progress(LOG, "TTS", i, total, every=10)
        return meta

    for i, text in enumerate(narrations):
        wav = out_dir / f"seg_{i:03d}.wav"
        mp3 = out_dir / f"seg_{i:03d}.mp3"
        cached = _maybe_reuse(i, text, wav)
        if cached:
            meta.append(cached)
            progress(LOG, "TTS", i, total, every=10)
            continue
        _edge_tts(text, mp3, voice=voice, rate=rate)
        _to_wav(mp3, wav)
        dur = _probe_duration(wav)
        meta.append(_tts_row(i, text, wav, dur, "edge", signature))
        progress(LOG, "TTS", i, total, every=10)
    return meta


def _edge_tts(text: str, out_mp3: Path, voice: str, rate: str) -> None:
    try:
        import edge_tts  # type: ignore
    except Exception as exc:
        raise RuntimeError(
            "edge-tts is required for recap TTS. pip install edge-tts"
        ) from exc

    async def _run() -> None:
        communicate = edge_tts.Communicate(text=text or ".", voice=voice, rate=rate)
        await communicate.save(str(out_mp3))

    asyncio.run(_run())


def _resolve_seed(env_key: str, default: str = "42") -> Optional[int]:
    raw = (os.getenv(env_key) or default).strip()
    if not raw or raw.lower() in ("none", "null"):
        return None
    try:
        return int(raw)
    except ValueError:
        return 42


def _prepare_ref_audio(ref_path: Path) -> Path:
    """Match Audio Studio: keep WAV; convert other formats to 24kHz mono WAV."""
    if ref_path.suffix.lower() == ".wav":
        return ref_path
    try:
        from audio_tts_with_pauses import _prepare_ref_audio_for_omnivoice

        return _prepare_ref_audio_for_omnivoice(ref_path)
    except Exception as exc:
        LOG.warning("ref audio prepare failed (%s); using original %s", exc, ref_path)
        return ref_path


def _omnivoice_tts(
    text: str,
    out_wav: Path,
    *,
    ref_path: Path,
    ref_text: str,
    language: str,
) -> None:
    """Recap OmniVoice → shared module tools/video-pipeline/omnivoice_tts.py"""
    from omnivoice_tts import resolve_omnivoice_language, synthesize_to_wav

    synthesize_to_wav(
        text=text or ".",
        out_wav=out_wav,
        ref_audio=str(_prepare_ref_audio(ref_path)),
        ref_text=ref_text,
        model_id=(os.getenv("OMNIVOICE_MODEL_ID") or "k2-fsa/OmniVoice").strip(),
        device_map=(os.getenv("OMNIVOICE_DEVICE_MAP") or "").strip() or "cuda:0",
        dtype_str=(os.getenv("OMNIVOICE_DTYPE") or "float16").strip() or "float16",
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


def _to_wav(src: Path, dst: Path) -> None:
    cmd = [
        "ffmpeg",
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
