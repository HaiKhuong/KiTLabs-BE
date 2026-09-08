"""NarratoAI audio_merger.merge_audio_files — overlay TTS onto a silent timeline by segment duration."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

LOG = logging.getLogger("narrato.audio_merger")


def tts_overlay_timeline(list_script: list[dict[str, Any]]) -> tuple[float, list[tuple[float, Path]]]:
    """Walk script durations; return (total_seconds, [(start_sec, audio_path), ...])."""
    current = 0.0
    overlays: list[tuple[float, Path]] = []
    for segment in list_script:
        duration = float(segment.get("duration") or 0)
        audio = str(segment.get("audio") or "").strip()
        if audio:
            path = Path(audio)
            if path.is_file():
                overlays.append((current, path))
            else:
                LOG.info("segment %s has no audio file, keep %.3fs gap", segment.get("_id"), duration)
        current += max(duration, 0.0)
    return current, overlays


def merge_audio_files(
    list_script: list[dict[str, Any]],
    output_audio: Path,
    ffmpeg: str,
    run,
    ffprobe_duration,
) -> Path | None:
    total_duration, overlays = tts_overlay_timeline(list_script)
    if total_duration <= 0:
        return None
    output_audio.parent.mkdir(parents=True, exist_ok=True)
    if not overlays:
        run(
            [
                ffmpeg,
                "-y",
                "-f",
                "lavfi",
                "-i",
                "anullsrc=r=44100:cl=stereo",
                "-t",
                f"{total_duration:.3f}",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                str(output_audio),
            ]
        )
        return output_audio

    silence = output_audio.with_name("tts_silence.aac")
    run(
        [
            ffmpeg,
            "-y",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=44100:cl=stereo",
            "-t",
            f"{total_duration:.3f}",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            str(silence),
        ]
    )
    inputs = ["-i", str(silence)]
    for _start, path in overlays:
        inputs.extend(["-i", str(path)])
    n = len(overlays) + 1
    lines = ["[0:a]volume=0.0[silence];"]
    for i, (start, _path) in enumerate(overlays):
        delay_ms = int(round(start * 1000))
        lines.append(f"[{i + 1}:a]volume={n},adelay={delay_ms}|{delay_ms}[a{i}];")
    mix = "[silence]" + "".join(f"[a{i}]" for i in range(len(overlays)))
    mix += f"amix=inputs={n}:duration=longest[aout]"
    lines.append(mix)
    script = output_audio.with_name("tts_mix_filter.txt")
    script.write_text("\n".join(lines), encoding="utf-8")
    run(
        [
            ffmpeg,
            "-y",
            *inputs,
            "-filter_complex_script",
            str(script),
            "-map",
            "[aout]",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-t",
            f"{total_duration:.3f}",
            str(output_audio),
        ]
    )
    LOG.info("merged TTS timeline %.3fs overlays=%s -> %s", total_duration, len(overlays), output_audio)
    return output_audio
