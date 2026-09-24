"""Step7c: mute+black deleted ranges on finalized output, keeping duration."""

from __future__ import annotations

import json
from dataclasses import dataclass


MIN_SEGMENT_SEC = 0.5


@dataclass(frozen=True)
class AudioSegment:
    id: str
    start_sec: float
    end_sec: float
    deleted: bool = False


def _round_sec(value: float) -> float:
    return round(float(value), 3)


def parse_audio_segments_json(text: str, duration_sec: float) -> list[AudioSegment]:
    duration = max(0.0, float(duration_sec))
    raw = (text or "").strip()
    if not raw or duration <= 0:
        return []

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return []

    if not isinstance(parsed, list) or not parsed:
        return []

    segments: list[AudioSegment] = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        start_raw = item.get("startSec", item.get("start_sec"))
        end_raw = item.get("endSec", item.get("end_sec"))
        try:
            start_sec = _round_sec(max(0.0, min(duration, float(start_raw))))
            end_sec = _round_sec(max(start_sec, min(duration, float(end_raw))))
        except (TypeError, ValueError):
            continue
        if end_sec - start_sec < MIN_SEGMENT_SEC:
            continue
        seg_id = str(item.get("id") or f"seg-{len(segments)}")
        deleted = bool(item.get("deleted"))
        segments.append(
            AudioSegment(
                id=seg_id,
                start_sec=start_sec,
                end_sec=end_sec,
                deleted=deleted,
            )
        )

    segments.sort(key=lambda seg: seg.start_sec)
    return segments


def map_source_time_to_output(
    source_sec: float,
    preprocess_speed: float,
    speed_video: float,
) -> float:
    prep = float(preprocess_speed) if preprocess_speed else 1.0
    speed = float(speed_video) if speed_video else 1.0
    if prep <= 0 or speed <= 0:
        raise ValueError("preprocess_speed and speed_video must be > 0")
    return _round_sec(float(source_sec) / prep / speed)


def get_active_segments(segments: list[AudioSegment]) -> list[AudioSegment]:
    return [segment for segment in segments if not segment.deleted]


def needs_audio_segment_cut(
    segments: list[AudioSegment],
    source_duration_sec: float,
    preprocess_speed: float,
    speed_video: float,
) -> bool:
    del source_duration_sec, preprocess_speed, speed_video
    return any(segment.deleted for segment in segments)


def get_deleted_output_windows(
    segments: list[AudioSegment],
    preprocess_speed: float,
    speed_video: float,
    output_duration_sec: float,
) -> list[tuple[float, float]]:
    output_duration = max(0.0, float(output_duration_sec))
    windows: list[tuple[float, float]] = []
    for segment in segments:
        if not segment.deleted:
            continue
        start = map_source_time_to_output(segment.start_sec, preprocess_speed, speed_video)
        end = map_source_time_to_output(segment.end_sec, preprocess_speed, speed_video)
        start = max(0.0, min(output_duration, start))
        end = max(start, min(output_duration, end))
        if end - start >= MIN_SEGMENT_SEC:
            windows.append((start, end))

    windows.sort(key=lambda item: item[0])
    merged: list[tuple[float, float]] = []
    for start, end in windows:
        if not merged or start > merged[-1][1]:
            merged.append((start, end))
        else:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
    return merged


def _enable_expr(windows: list[tuple[float, float]]) -> str:
    return "+".join(
        f"gte(t,{start:.3f})*lte(t,{end:.3f})" for start, end in windows
    )


def build_step7c_filter_complex(
    windows: list[tuple[float, float]],
    has_audio: bool,
) -> str:
    if not windows:
        raise ValueError("No deleted windows for Step7c keep-duration mute")

    enable = _enable_expr(windows)
    parts = [f"[0:v]eq=brightness=-1:enable='{enable}'[outv]"]
    if has_audio:
        parts.append(f"[0:a]volume=0:enable='{enable}'[outa]")
    return ";".join(parts)


def build_step7c_segment_cut_command(
    video_path: str,
    part_path: str,
    ranges: list[tuple[float, float]],
    has_audio: bool,
    use_gpu: bool,
    ffmpeg_bin: str,
    video_encode_args: list[str],
    output_metadata_args: list[str],
) -> list[str]:
    del use_gpu
    filter_complex = build_step7c_filter_complex(ranges, has_audio)
    maps = ["-map", "[outv]"]
    audio_args: list[str] = []
    if has_audio:
        maps.extend(["-map", "[outa]"])
        audio_args = ["-c:a", "aac"]

    return [
        ffmpeg_bin,
        "-y",
        "-i",
        str(video_path),
        "-filter_complex",
        filter_complex,
        *maps,
        *video_encode_args,
        *audio_args,
        *output_metadata_args,
        "-f",
        "mp4",
        str(part_path),
    ]
