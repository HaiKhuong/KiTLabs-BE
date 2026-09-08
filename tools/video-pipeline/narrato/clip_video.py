"""NarratoAI clip_video_unified — OST=0 silent cut by TTS length; OST=1 exact timestamp + source audio."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from asr import parse_timestamp_range, sec_to_srt_timestamp

LOG = logging.getLogger("narrato.clip_video")


def parse_timestamp(timestamp: str) -> tuple[str, str]:
    start_time, end_time = str(timestamp).split("-", 1)
    return start_time.strip(), end_time.strip()


def ffmpeg_time(ts: str) -> str:
    return str(ts).replace(",", ".")


def calculate_end_time(start_time: str, duration: float, extra_seconds: float = 0.0) -> str:
    has_ms = "," in start_time or "." in start_time.replace(":", "")
    raw = start_time.replace(",", ".")
    parts = raw.split(":")
    h, m = int(parts[0]), int(parts[1])
    sec = float(parts[2])
    total_ms = int(round((h * 3600 + m * 60 + sec + duration + extra_seconds) * 1000))
    ms_new = total_ms % 1000
    total_seconds = total_ms // 1000
    h_new = int(total_seconds // 3600)
    m_new = int((total_seconds % 3600) // 60)
    s_new = int(total_seconds % 60)
    if "," in start_time:
        return f"{h_new:02d}:{m_new:02d}:{s_new:02d},{ms_new:03d}"
    if has_ms:
        return f"{h_new:02d}:{m_new:02d}:{s_new:02d}.{ms_new:03d}"
    return f"{h_new:02d}:{m_new:02d}:{s_new:02d}"


def _ffmpeg_duration(start_time: str, end_time: str) -> str:
    left = str(start_time).replace(".", ",")
    right = str(end_time).replace(".", ",")
    start_s, end_s = parse_timestamp_range(f"{left}-{right}")
    duration = max(end_s - start_s, 0.04)
    return f"{duration:.3f}".rstrip("0").rstrip(".")


def build_cut_cmd(
    ffmpeg: str,
    input_path: str,
    output_path: str,
    start_time: str,
    end_time: str,
    *,
    remove_audio: bool,
) -> list[str]:
    duration = _ffmpeg_duration(start_time, end_time)
    cmd = [
        ffmpeg,
        "-y",
        "-ss",
        ffmpeg_time(start_time),
        "-i",
        input_path,
        "-t",
        duration,
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
    ]
    if remove_audio:
        cmd.append("-an")
    else:
        cmd.extend(["-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "128k"])
    cmd.extend(["-avoid_negative_ts", "make_zero", "-movflags", "+faststart", output_path])
    return cmd


def clip_video_unified(
    video_origin_path: Path,
    script_list: list[dict[str, Any]],
    tts_map: dict[int, dict[str, Any]],
    output_dir: Path,
    ffmpeg: str,
    run,
) -> dict[int, Path]:
    """Return {_id: clipped mp4}. OST=0 uses TTS duration; OST=1 uses script timestamp."""
    output_dir.mkdir(parents=True, exist_ok=True)
    result: dict[int, Path] = {}
    for item in script_list:
        item_id = int(item["_id"])
        ost = int(item.get("OST") or 0)
        start_time, end_time = parse_timestamp(str(item["timestamp"]))
        if ost == 0:
            tts_item = tts_map.get(item_id)
            if not tts_item:
                LOG.error("OST=0 id=%s missing TTS; falling back to timestamp cut (silent)", item_id)
            else:
                end_time = calculate_end_time(start_time, float(tts_item["duration"]), extra_seconds=0)
            remove_audio = True
            prefix = "ost0"
        else:
            remove_audio = False
            prefix = "ost1"
        safe_start = ffmpeg_time(start_time).replace(":", "-")
        safe_end = ffmpeg_time(end_time).replace(":", "-")
        out = output_dir / f"{prefix}_{item_id:04d}_vid_{safe_start}@{safe_end}.mp4"
        cmd = build_cut_cmd(
            ffmpeg,
            str(video_origin_path),
            str(out),
            start_time,
            end_time,
            remove_audio=remove_audio,
        )
        run(cmd)
        if not out.exists():
            raise RuntimeError(f"clip missing after ffmpeg: {out}")
        result[item_id] = out
        LOG.info("clipped %s id=%s %s -> %s", prefix, item_id, f"{start_time}-{end_time}", out.name)
    return result
