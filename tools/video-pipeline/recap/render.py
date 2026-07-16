from __future__ import annotations

import logging
import subprocess
from pathlib import Path
from typing import Any

LOG = logging.getLogger("recap.render")


def render_timeline(
    video: Path,
    timeline: dict[str, Any],
    out_mp4: Path,
    work_dir: Path,
) -> None:
    clips_dir = work_dir / "clips"
    clips_dir.mkdir(parents=True, exist_ok=True)
    concat_list = work_dir / "concat_video.txt"
    voice_list = work_dir / "concat_voice.txt"

    video_parts: list[Path] = []
    voice_parts: list[Path] = []
    idx = 0

    for cue in timeline.get("cues") or []:
        voice_file = Path(cue["voice"]["file"])
        if voice_file.exists():
            voice_parts.append(voice_file)

        for vc in cue.get("video") or []:
            dur = max(0.05, float(vc["t1"]) - float(vc["t0"]))
            src_in = float(vc["srcIn"])
            clip_path = clips_dir / f"clip_{idx:05d}.mp4"
            _cut_clip(video, src_in, dur, clip_path)
            video_parts.append(clip_path)
            idx += 1

    if not video_parts:
        raise RuntimeError("No video clips to render")

    _write_concat_file(concat_list, video_parts)
    video_only = work_dir / "video_only.mp4"
    _concat_copy(concat_list, video_only)

    audio_path = work_dir / "voice_mix.wav"
    if voice_parts:
        _write_concat_file(voice_list, voice_parts)
        _concat_audio(voice_list, audio_path)
    else:
        raise RuntimeError("No voice segments to mux")

    out_mp4.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(video_only),
        "-i",
        str(audio_path),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-shortest",
        "-movflags",
        "+faststart",
        str(out_mp4),
    ]
    LOG.info("Muxing final recap → %s", out_mp4)
    subprocess.check_call(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _cut_clip(video: Path, src_in: float, dur: float, out: Path) -> None:
    if out.exists():
        return
    # Re-encode for consistent concat
    cmd = [
        "ffmpeg",
        "-y",
        "-ss",
        f"{src_in:.3f}",
        "-i",
        str(video),
        "-t",
        f"{dur:.3f}",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        str(out),
    ]
    subprocess.check_call(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _write_concat_file(path: Path, files: list[Path]) -> None:
    lines = []
    for f in files:
        # escape single quotes for ffmpeg concat demuxer
        p = str(f.resolve()).replace("'", "'\\''")
        lines.append(f"file '{p}'")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _concat_copy(list_path: Path, out: Path) -> None:
    cmd = [
        "ffmpeg",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(list_path),
        "-c",
        "copy",
        str(out),
    ]
    try:
        subprocess.check_call(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError:
        # re-encode fallback
        cmd = [
            "ffmpeg",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(list_path),
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-an",
            str(out),
        ]
        subprocess.check_call(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _concat_audio(list_path: Path, out: Path) -> None:
    cmd = [
        "ffmpeg",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(list_path),
        "-c:a",
        "pcm_s16le",
        str(out),
    ]
    subprocess.check_call(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
