from __future__ import annotations

import logging
import subprocess
from pathlib import Path
from typing import Any

import recap_cache  # noqa: F401  — HF cache → ~/.cache/huggingface/hub (trước faster-whisper)

LOG = logging.getLogger("recap.asr")

_NO_AUDIO_MSG = (
    "Source video has no audio track (common with video-only YouTube downloads "
    "such as videoplayback.mp4). Upload a merged file with sound, or download "
    "audio+video and merge before recap."
)


def _ffmpeg_bin() -> str:
    import os

    raw = (os.environ.get("FFMPEG_BIN") or os.environ.get("FFMPEG_PATH") or "ffmpeg").strip()
    return raw or "ffmpeg"


def _ffprobe_bin() -> str:
    import os

    explicit = (os.environ.get("FFPROBE_BIN") or "").strip()
    if explicit:
        return explicit
    fb = Path(_ffmpeg_bin())
    for name in ("ffprobe.exe", "ffprobe"):
        cand = fb.with_name(name)
        if cand.exists():
            return str(cand)
    return "ffprobe"


def _has_audio_stream(video: Path) -> bool:
    cmd = [
        _ffprobe_bin(),
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_type",
        "-of",
        "csv=p=0",
        str(video),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    return proc.returncode == 0 and (proc.stdout or "").strip() == "audio"


def _extract_wav(video: Path, wav: Path) -> None:
    wav.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        _ffmpeg_bin(),
        "-nostdin",
        "-y",
        "-i",
        str(video),
        "-vn",
        "-map",
        "0:a:0",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        str(wav),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=7200)
    if proc.returncode != 0:
        stderr = (proc.stderr or "").strip()
        tail = stderr[-3000:] if stderr else "(no stderr)"
        LOG.error("ffmpeg audio extract failed (code=%s): %s", proc.returncode, tail)
        raise RuntimeError(
            f"ffmpeg failed to extract audio (exit {proc.returncode}). "
            f"{tail[-800:]}"
        )


def run_asr(video: Path, work_dir: Path) -> dict[str, Any]:
    """faster-whisper if available; else empty transcript with warning."""
    if not _has_audio_stream(video):
        LOG.error("%s video=%s", _NO_AUDIO_MSG, video)
        raise RuntimeError(_NO_AUDIO_MSG)

    wav = work_dir / "audio_16k.wav"
    _extract_wav(video, wav)

    try:
        from faster_whisper import WhisperModel  # type: ignore
    except Exception as exc:
        LOG.warning("faster-whisper unavailable (%s); using empty transcript", exc)
        return {"language": "unknown", "segments": []}

    # Default large-v3 to reuse the shared faster-whisper cache (auto_vietsub already
    # downloaded it). Avoids writing a new model dir into a www-data-owned HF cache.
    model_size = (os_env("RECAP_WHISPER_MODEL") or "large-v3").strip()
    device = (os_env("RECAP_WHISPER_DEVICE") or "cpu").strip()
    compute = (os_env("RECAP_WHISPER_COMPUTE") or "int8").strip()
    LOG.info("Whisper transcribing model=%s device=%s", model_size, device)
    model = WhisperModel(model_size, device=device, compute_type=compute)
    segments_iter, info = model.transcribe(str(wav), beam_size=1, vad_filter=True)
    segments: list[dict[str, Any]] = []
    for i, seg in enumerate(segments_iter):
        segments.append(
            {
                "id": f"t{i:04d}",
                "startSec": float(seg.start),
                "endSec": float(seg.end),
                "text": (seg.text or "").strip(),
            }
        )
    return {
        "language": getattr(info, "language", None) or "unknown",
        "segments": segments,
    }


def os_env(key: str) -> str | None:
    import os

    return os.environ.get(key)


def sec_to_hhmmss(sec: float) -> str:
    total = max(0, int(sec))
    h = total // 3600
    m = (total % 3600) // 60
    s = total % 60
    if h > 0:
        return f"{h:02d}:{m:02d}:{s:02d}"
    return f"{m:02d}:{s:02d}"


def format_transcript_timestamped(
    segments: list[dict[str, Any]],
    max_chars: int | None = None,
) -> str:
    """
    Chronological transcript for Gemini A:
    00:01:10
    John wakes up.
    """
    if max_chars is None:
        raw = os_env("RECAP_TRANSCRIPT_MAX_CHARS")
        max_chars = int(raw) if raw and raw.isdigit() else 120_000

    blocks: list[str] = []
    for seg in segments:
        text = str(seg.get("text") or "").strip()
        if not text:
            continue
        ts = sec_to_hhmmss(float(seg.get("startSec") or 0))
        blocks.append(f"{ts}\n{text}")

    if not blocks:
        return ""

    body = "\n\n".join(blocks)
    if len(body) <= max_chars:
        return body

    # Keep head + tail; drop middle for very long movies
    head_budget = int(max_chars * 0.45)
    tail_budget = int(max_chars * 0.45)
    head_parts: list[str] = []
    tail_parts: list[str] = []
    size = 0
    for block in blocks:
        add = len(block) + 2
        if size + add > head_budget:
            break
        head_parts.append(block)
        size += add
    size = 0
    for block in reversed(blocks):
        add = len(block) + 2
        if size + add > tail_budget:
            break
        tail_parts.insert(0, block)
        size += add

    omitted = len(blocks) - len(head_parts) - len(tail_parts)
    marker = f"\n\n[... {omitted} transcript blocks omitted for length ...]\n\n"
    return "\n\n".join(head_parts) + marker + "\n\n".join(tail_parts)


def merge_transcript_windows(segments: list[dict[str, Any]], window_sec: float = 30.0) -> list[list[Any]]:
    """Compress to [start, end, text] rows (fallback / summary)."""
    if not segments:
        return [[0, int(window_sec), ""]]

    merged: list[list[Any]] = []
    bucket_start = float(segments[0]["startSec"])
    bucket_end = bucket_start
    texts: list[str] = []

    for seg in segments:
        s = float(seg["startSec"])
        e = float(seg["endSec"])
        t = str(seg.get("text") or "").strip()
        if s - bucket_start >= window_sec and texts:
            merged.append([round(bucket_start, 1), round(bucket_end, 1), " ".join(texts)])
            bucket_start = s
            texts = []
        bucket_end = max(bucket_end, e)
        if t:
            texts.append(t)

    if texts or not merged:
        merged.append([round(bucket_start, 1), round(bucket_end, 1), " ".join(texts)])
    return merged
