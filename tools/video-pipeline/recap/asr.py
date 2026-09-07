from __future__ import annotations

import logging
import re
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


_SRT_TS_RE = re.compile(
    r"(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})"
)


def _ms_token_to_millis(raw: str) -> int:
    digits = re.sub(r"\D", "", raw or "") or "0"
    return int((digits + "000")[:3])


def srt_timestamp_to_sec(h: str, m: str, s: str, ms: str) -> float:
    return int(h) * 3600 + int(m) * 60 + int(s) + _ms_token_to_millis(ms) / 1000.0


def sec_to_srt_timestamp(sec: float) -> str:
    total_ms = max(0, int(round(float(sec) * 1000.0)))
    hours, rem = divmod(total_ms, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    seconds, millis = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"


def sec_to_hhmmss(sec: float) -> str:
    total = max(0, int(sec))
    h = total // 3600
    m = (total % 3600) // 60
    s = total % 60
    if h > 0:
        return f"{h:02d}:{m:02d}:{s:02d}"
    return f"{m:02d}:{s:02d}"


def segments_to_srt(segments: list[dict[str, Any]]) -> str:
    """Whisper segments → SubRip (.srt) with millisecond timestamps."""
    blocks: list[str] = []
    index = 0
    for seg in segments:
        text = str(seg.get("text") or "").strip()
        if not text:
            continue
        start = float(seg.get("startSec") or 0)
        end = float(seg.get("endSec") or start)
        if end <= start:
            end = start + 0.001
        index += 1
        blocks.append(
            f"{index}\n{sec_to_srt_timestamp(start)} --> {sec_to_srt_timestamp(end)}\n{text}"
        )
    if not blocks:
        return ""
    return "\n\n".join(blocks) + "\n"


def parse_srt_time_range(text: str) -> tuple[float, float] | None:
    match = _SRT_TS_RE.search(text or "")
    if not match:
        return None
    start = srt_timestamp_to_sec(*match.group(1, 2, 3, 4))
    end = srt_timestamp_to_sec(*match.group(5, 6, 7, 8))
    return start, max(end, start + 0.001)


def parse_srt(text: str) -> list[dict[str, Any]]:
    """Parse SubRip into Whisper-style segments (startSec / endSec / text)."""
    raw = (text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not raw:
        return []
    chunks = re.split(r"\n\s*\n", raw)
    segments: list[dict[str, Any]] = []
    for chunk in chunks:
        lines = [ln.strip() for ln in chunk.split("\n") if ln.strip()]
        if not lines:
            continue
        ts_idx = 1 if lines[0].isdigit() and len(lines) > 1 else 0
        if ts_idx >= len(lines):
            continue
        match = _SRT_TS_RE.search(lines[ts_idx])
        if not match:
            continue
        start = srt_timestamp_to_sec(*match.group(1, 2, 3, 4))
        end = srt_timestamp_to_sec(*match.group(5, 6, 7, 8))
        body = "\n".join(lines[ts_idx + 1 :]).strip()
        if not body:
            continue
        i = len(segments)
        segments.append(
            {
                "id": f"t{i:04d}",
                "startSec": start,
                "endSec": max(end, start + 0.001),
                "text": body,
            }
        )
    return segments


def write_srt(path: Path, segments: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(segments_to_srt(segments), encoding="utf-8")


def load_srt_segments(path: Path) -> list[dict[str, Any]]:
    return parse_srt(path.read_text(encoding="utf-8"))


def format_srt_for_prompt(
    srt_text: str,
    max_chars: int | None = None,
) -> str:
    """Pass real SRT to Gemini; keep head+tail cues if over budget."""
    if max_chars is None:
        raw = os_env("RECAP_TRANSCRIPT_MAX_CHARS")
        max_chars = int(raw) if raw and raw.isdigit() else 120_000
    body = (srt_text or "").strip()
    if not body or len(body) <= max_chars:
        return body

    segments = parse_srt(body)
    if not segments:
        return body[:max_chars]

    head: list[dict[str, Any]] = []
    tail: list[dict[str, Any]] = []
    size = 0
    head_budget = int(max_chars * 0.45)
    tail_budget = int(max_chars * 0.45)
    for seg in segments:
        block = segments_to_srt([seg]).strip()
        add = len(block) + 2
        if size + add > head_budget:
            break
        head.append(seg)
        size += add
    size = 0
    for seg in reversed(segments):
        block = segments_to_srt([seg]).strip()
        add = len(block) + 2
        if size + add > tail_budget:
            break
        tail.insert(0, seg)
        size += add

    omitted = max(0, len(segments) - len(head) - len(tail))
    marker = (
        f"\n\n{len(head) + 1}\n00:00:00,000 --> 00:00:00,001\n"
        f"[... omitted {omitted} SRT cues for length ...]\n\n"
    )
    return segments_to_srt(head).rstrip() + marker + segments_to_srt(tail)


def format_transcript_timestamped(
    segments: list[dict[str, Any]],
    max_chars: int | None = None,
) -> str:
    """Gemini input: valid SubRip (not a custom JSON dump)."""
    return format_srt_for_prompt(segments_to_srt(segments), max_chars=max_chars)


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
