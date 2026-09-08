"""faster-whisper ASR with forced language (default vi)."""

from __future__ import annotations

import logging
import os
import re
import subprocess
from pathlib import Path
from typing import Any

import narrato_cache  # noqa: F401

LOG = logging.getLogger("narrato.asr")

_NO_AUDIO_MSG = (
    "Source video has no audio track (common with video-only YouTube downloads "
    "such as videoplayback.mp4). Upload a merged file with sound, or download "
    "audio+video and merge before recap."
)


def _ffmpeg_bin() -> str:
    raw = (os.environ.get("FFMPEG_BIN") or os.environ.get("FFMPEG_PATH") or "ffmpeg").strip()
    return raw or "ffmpeg"


def _ffprobe_bin() -> str:
    explicit = (os.environ.get("FFPROBE_BIN") or "").strip()
    if explicit:
        return explicit
    fb = Path(_ffmpeg_bin())
    for name in ("ffprobe.exe", "ffprobe"):
        cand = fb.with_name(name)
        if cand.exists():
            return str(cand)
    return "ffprobe"


def has_audio_stream(video: Path) -> bool:
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


def extract_wav(video: Path, wav: Path) -> None:
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
        raise RuntimeError(f"ffmpeg extract wav failed: {tail}")


def run_asr(video: Path, work_dir: Path, language: str = "vi") -> dict[str, Any]:
    if not has_audio_stream(video):
        LOG.error("%s video=%s", _NO_AUDIO_MSG, video)
        raise RuntimeError(_NO_AUDIO_MSG)

    wav = work_dir / "audio_16k.wav"
    extract_wav(video, wav)

    try:
        from faster_whisper import WhisperModel  # type: ignore
    except Exception as exc:
        raise RuntimeError(f"faster-whisper unavailable: {exc}") from exc

    lang = (language or "vi").strip() or "vi"
    model_size = (
        os.environ.get("NARRATO_WHISPER_MODEL") or os.environ.get("RECAP_WHISPER_MODEL") or "large-v3"
    ).strip()
    device = (os.environ.get("NARRATO_WHISPER_DEVICE") or os.environ.get("RECAP_WHISPER_DEVICE") or "cpu").strip()
    compute = (os.environ.get("NARRATO_WHISPER_COMPUTE") or os.environ.get("RECAP_WHISPER_COMPUTE") or "int8").strip()
    LOG.info("Whisper transcribing model=%s device=%s language=%s", model_size, device, lang)
    model = WhisperModel(model_size, device=device, compute_type=compute)
    segments_iter, info = model.transcribe(
        str(wav),
        language=lang,
        beam_size=1,
        vad_filter=True,
    )
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
        "language": getattr(info, "language", None) or lang,
        "segments": segments,
    }


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


def segments_to_srt(segments: list[dict[str, Any]]) -> str:
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


def parse_timestamp_range(timestamp: str) -> tuple[float, float]:
    raw = str(timestamp or "").strip()
    if "-" in raw and "-->" not in raw:
        left, right = raw.split("-", 1)
        rng = parse_srt_time_range(f"{left.strip()} --> {right.strip()}")
    else:
        rng = parse_srt_time_range(raw)
    if rng is None:
        raise ValueError(f"Invalid timestamp: {timestamp}")
    return rng


def parse_srt(text: str) -> list[dict[str, Any]]:
    raw = (text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not raw:
        return []
    chunks = re.split(r"\n\s*\n", raw)
    segments: list[dict[str, Any]] = []
    for chunk in chunks:
        lines = [ln.strip() for ln in chunk.split("\n") if ln.strip()]
        if not lines:
            continue
        if lines[0].isdigit():
            lines = lines[1:]
        if not lines:
            continue
        rng = parse_srt_time_range(lines[0])
        if rng is None:
            continue
        body = " ".join(lines[1:]).strip()
        if not body:
            continue
        segments.append({"startSec": rng[0], "endSec": rng[1], "text": body})
    return segments


def format_subtitle_content(srt_text: str, video_name: str) -> str:
    return f"# Video 1: {video_name}\nSubtitle file: transcript.srt\n{srt_text}".strip()
