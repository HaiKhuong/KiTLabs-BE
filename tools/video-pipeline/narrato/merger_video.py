"""NarratoAI merger_video.combine_clip_videos + generate_video.merge_materials (ffmpeg path, no BGM/subs)."""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

LOG = logging.getLogger("narrato.merger_video")


def create_ffmpeg_concat_file(video_paths: list[Path], concat_file: Path) -> Path:
    lines: list[str] = []
    for video_path in video_paths:
        abs_path = os.path.abspath(str(video_path))
        if os.name == "nt":
            abs_path = abs_path.replace("\\", "/")
        abs_path = abs_path.replace("'", "\\'")
        lines.append(f"file '{abs_path}'")
    concat_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return concat_file


def process_single_video(
    ffmpeg: str,
    input_path: Path,
    output_path: Path,
    target_width: int,
    target_height: int,
    keep_audio: bool,
    run,
) -> Path:
    vf = (
        f"scale={target_width}:{target_height}:force_original_aspect_ratio=decrease,"
        f"pad={target_width}:{target_height}:(ow-iw)/2:(oh-ih)/2"
    )
    cmd = [
        ffmpeg,
        "-y",
        "-i",
        str(input_path),
        "-vf",
        vf,
        "-r",
        "30",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-profile:v",
        "high",
        "-b:v",
        "5M",
        "-maxrate",
        "8M",
        "-bufsize",
        "10M",
        "-pix_fmt",
        "yuv420p",
    ]
    if keep_audio:
        cmd.extend(["-c:a", "aac", "-b:a", "128k"])
    else:
        cmd.append("-an")
    cmd.append(str(output_path))
    run(cmd)
    return output_path


def combine_clip_videos(
    output_video_path: Path,
    video_paths: list[Path],
    video_ost_list: list[int],
    ffmpeg: str,
    run,
    probe_duration,
    target_width: int,
    target_height: int,
    threads: int = 4,
) -> Path:
    if len(video_paths) != len(video_ost_list):
        n = min(len(video_paths), len(video_ost_list))
        video_paths = video_paths[:n]
        video_ost_list = video_ost_list[:n]
    if not video_paths:
        raise ValueError("no clips to combine")

    output_video_path.parent.mkdir(parents=True, exist_ok=True)
    temp_dir = output_video_path.parent / "temp_videos"
    temp_dir.mkdir(parents=True, exist_ok=True)

    processed: list[dict[str, Any]] = []
    for index, (path, ost) in enumerate(zip(video_paths, video_ost_list)):
        keep_audio = int(ost) > 0
        temp_out = temp_dir / f"processed_{index}.mp4"
        process_single_video(ffmpeg, path, temp_out, target_width, target_height, keep_audio, run)
        processed.append({"index": index, "path": temp_out, "keep_audio": keep_audio})

    processed.sort(key=lambda x: x["index"])
    video_only = [Path(row["path"]) for row in processed]
    concat_file = temp_dir / "concat_list.txt"
    create_ffmpeg_concat_file(video_only, concat_file)
    video_concat = temp_dir / "video_concat.mp4"
    try:
        run(
            [
                ffmpeg,
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(concat_file),
                "-c:v",
                "copy",
                "-an",
                "-movflags",
                "+faststart",
                "-avoid_negative_ts",
                "make_zero",
                str(video_concat),
            ]
        )
    except RuntimeError:
        LOG.warning("video concat copy failed; re-encoding")
        run(
            [
                ffmpeg,
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(concat_file),
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-profile:v",
                "high",
                "-an",
                "-threads",
                str(threads),
                str(video_concat),
            ]
        )

    audio_segments = [row for row in processed if row["keep_audio"]]
    if not audio_segments:
        import shutil

        shutil.copyfile(video_concat, output_video_path)
        LOG.info("combine_clip_videos: no original audio (all OST=0)")
        return output_video_path

    audio_files: list[dict[str, Any]] = []
    for i, segment in enumerate(audio_segments):
        audio_file = temp_dir / f"audio_{i}.aac"
        run(
            [
                ffmpeg,
                "-y",
                "-i",
                str(segment["path"]),
                "-vn",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                str(audio_file),
            ]
        )
        audio_files.append({"index": segment["index"], "path": audio_file})

    audio_timings: list[dict[str, Any]] = []
    current_time = 0.0
    for video in processed:
        duration = probe_duration(Path(video["path"]))
        if video["keep_audio"]:
            for audio in audio_files:
                if audio["index"] == video["index"]:
                    audio_timings.append(
                        {"file": audio["path"], "start": current_time, "index": video["index"]}
                    )
                    break
        current_time += duration

    silence_audio = temp_dir / "silence.aac"
    run(
        [
            ffmpeg,
            "-y",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=44100:cl=stereo",
            "-t",
            str(current_time),
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            str(silence_audio),
        ]
    )

    num_inputs = len(audio_timings) + 1
    filter_script = temp_dir / "filter_script.txt"
    lines = ["[0:a]volume=0.0[silence];"]
    for i, timing in enumerate(audio_timings):
        delay_ms = int(round(float(timing["start"]) * 1000))
        lines.append(f"[{i + 1}:a]volume={num_inputs},adelay={delay_ms}|{delay_ms}[a{i}];")
    mix_str = "[silence]" + "".join(f"[a{i}]" for i in range(len(audio_timings)))
    mix_str += f"amix=inputs={num_inputs}:duration=longest[aout]"
    lines.append(mix_str)
    filter_script.write_text("\n".join(lines), encoding="utf-8")

    audio_inputs: list[str] = ["-i", str(silence_audio)]
    for timing in audio_timings:
        audio_inputs.extend(["-i", str(timing["file"])])
    mixed_audio = temp_dir / "mixed_audio.aac"
    run(
        [
            ffmpeg,
            "-y",
            *audio_inputs,
            "-filter_complex_script",
            str(filter_script),
            "-map",
            "[aout]",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            str(mixed_audio),
        ]
    )

    run(
        [
            ffmpeg,
            "-y",
            "-i",
            str(video_concat),
            "-i",
            str(mixed_audio),
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-shortest",
            str(output_video_path),
        ]
    )
    LOG.info("combine_clip_videos done -> %s", output_video_path)
    return output_video_path


def merge_materials(
    video_path: Path,
    audio_path: Path | None,
    output_path: Path,
    ffmpeg: str,
    run,
    probe_duration,
    *,
    voice_volume: float = 1.0,
    original_audio_volume: float = 1.0,
    keep_original_audio: bool = True,
) -> Path:
    """NarratoAI generate_video.merge_materials ffmpeg mix: original (OST=1) + TTS timeline."""
    duration = probe_duration(video_path)
    duration_arg = f"{duration:.6f}".rstrip("0").rstrip(".")
    inputs = ["-i", str(video_path)]
    filters: list[str] = []
    labels: list[str] = []

    if keep_original_audio and original_audio_volume > 0:
        filters.append(
            f"[0:a]volume={original_audio_volume},atrim=0:{duration_arg},asetpts=PTS-STARTPTS[a0]"
        )
        labels.append("[a0]")

    if audio_path and audio_path.is_file():
        inputs.extend(["-i", str(audio_path)])
        idx = 1
        label = f"a{len(labels)}"
        filters.append(
            f"[{idx}:a]volume={voice_volume},atrim=0:{duration_arg},asetpts=PTS-STARTPTS[{label}]"
        )
        labels.append(f"[{label}]")

    if not labels:
        raise RuntimeError("merge_materials: no audio tracks")
    if len(labels) == 1:
        filters.append(f"{labels[0]}atrim=0:{duration_arg},asetpts=PTS-STARTPTS[aout]")
    else:
        filters.append(
            f"{''.join(labels)}amix=inputs={len(labels)}:duration=longest:dropout_transition=0:normalize=0,"
            f"atrim=0:{duration_arg},asetpts=PTS-STARTPTS[aout]"
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    run(
        [
            ffmpeg,
            "-y",
            *inputs,
            "-filter_complex",
            ";".join(filters),
            "-map",
            "0:v:0",
            "-map",
            "[aout]",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-shortest",
            "-movflags",
            "+faststart",
            str(output_path),
        ]
    )
    LOG.info("merge_materials done -> %s", output_path)
    return output_path
