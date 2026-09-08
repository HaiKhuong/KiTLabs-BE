"""ffmpeg cut + concat renderer for Narrato OST 0/1 items."""

from __future__ import annotations

import logging
import os
import subprocess
from pathlib import Path
from typing import Any

from asr import parse_timestamp_range, sec_to_srt_timestamp
from tts import synthesize_clip

LOG = logging.getLogger("narrato.render")


def _ffmpeg() -> str:
    return (os.environ.get("FFMPEG_BIN") or os.environ.get("FFMPEG_PATH") or "ffmpeg").strip() or "ffmpeg"


def _run(cmd: list[str], timeout: int = 7200) -> None:
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "")[-2500:]
        raise RuntimeError(f"ffmpeg failed: {tail}")


def render_items(
    video: Path,
    items: list[dict[str, Any]],
    work_dir: Path,
    out_mp4: Path,
    *,
    voice: str = "vi-VN-HoaiMyNeural",
    rate: str = "+0%",
    tts_engine: str = "edge",
    ref_audio: str | None = None,
    ref_text: str | None = None,
    tts_language: str | None = None,
) -> Path:
    clips_dir = work_dir / "clips"
    clips_dir.mkdir(parents=True, exist_ok=True)
    clip_paths: list[Path] = []
    ff = _ffmpeg()

    for item in items:
        item_id = int(item["_id"])
        start, end = parse_timestamp_range(str(item["timestamp"]))
        duration = max(end - start, 0.04)
        start_ts = sec_to_srt_timestamp(start).replace(",", ".")
        ost = int(item.get("OST") or 0)
        clip = clips_dir / f"clip_{item_id:04d}.mp4"

        if ost == 1:
            _run(
                [
                    ff,
                    "-nostdin",
                    "-y",
                    "-ss",
                    start_ts,
                    "-i",
                    str(video),
                    "-t",
                    f"{duration:.3f}",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-c:a",
                    "aac",
                    "-movflags",
                    "+faststart",
                    str(clip),
                ]
            )
        else:
            narration = str(item.get("narration") or "").strip()
            tts_wav = clips_dir / f"tts_{item_id:04d}.wav"
            has_tts = bool(narration) and synthesize_clip(
                narration,
                tts_wav,
                engine=tts_engine,
                voice=voice,
                rate=rate,
                ref_audio=ref_audio,
                ref_text=ref_text,
                language=tts_language,
            )
            if has_tts:
                _run(
                    [
                        ff,
                        "-nostdin",
                        "-y",
                        "-ss",
                        start_ts,
                        "-i",
                        str(video),
                        "-i",
                        str(tts_wav),
                        "-t",
                        f"{duration:.3f}",
                        "-map",
                        "0:v:0",
                        "-map",
                        "1:a:0",
                        "-c:v",
                        "libx264",
                        "-preset",
                        "veryfast",
                        "-c:a",
                        "aac",
                        "-shortest",
                        "-movflags",
                        "+faststart",
                        str(clip),
                    ]
                )
            else:
                _run(
                    [
                        ff,
                        "-nostdin",
                        "-y",
                        "-ss",
                        start_ts,
                        "-i",
                        str(video),
                        "-t",
                        f"{duration:.3f}",
                        "-an",
                        "-c:v",
                        "libx264",
                        "-preset",
                        "veryfast",
                        "-movflags",
                        "+faststart",
                        str(clip),
                    ]
                )
        clip_paths.append(clip)

    if not clip_paths:
        raise RuntimeError("No clips to concat")

    concat_list = clips_dir / "concat.txt"
    concat_list.write_text(
        "".join(f"file '{p.resolve().as_posix()}'\n" for p in clip_paths),
        encoding="utf-8",
    )
    out_mp4.parent.mkdir(parents=True, exist_ok=True)
    _run(
        [
            ff,
            "-nostdin",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_list),
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            str(out_mp4),
        ]
    )
    if not out_mp4.exists():
        raise RuntimeError("Render finished but output missing")
    return out_mp4
