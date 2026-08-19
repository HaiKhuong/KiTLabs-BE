"""Step7c: trim+concat audio/video segments on finalized output."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any


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
    if not segments:
        return False

    active = get_active_segments(segments)
    if not active:
        return True

    if len(active) > 1:
        return True

    if any(segment.deleted for segment in segments):
        return True

    duration = max(0.0, float(source_duration_sec))
    output_duration = map_source_time_to_output(duration, preprocess_speed, speed_video)
    only = active[0]
    out_start = map_source_time_to_output(only.start_sec, preprocess_speed, speed_video)
    out_end = map_source_time_to_output(only.end_sec, preprocess_speed, speed_video)

    if out_start > MIN_SEGMENT_SEC / 2:
        return True
    if abs(out_end - output_duration) > MIN_SEGMENT_SEC / 2:
        return True
    return False


def build_output_ranges(
    segments: list[AudioSegment],
    preprocess_speed: float,
    speed_video: float,
    output_duration_sec: float,
) -> list[tuple[float, float]]:
    active = get_active_segments(segments)
    if not active:
        return []

    output_duration = max(0.0, float(output_duration_sec))
    ranges: list[tuple[float, float]] = []
    for segment in active:
        start = map_source_time_to_output(segment.start_sec, preprocess_speed, speed_video)
        end = map_source_time_to_output(segment.end_sec, preprocess_speed, speed_video)
        start = max(0.0, min(output_duration, start))
        end = max(start, min(output_duration, end))
        if end - start >= MIN_SEGMENT_SEC:
            ranges.append((start, end))
    return ranges


def build_step7c_filter_complex(
    ranges: list[tuple[float, float]],
    has_audio: bool,
) -> str:
    if not ranges:
        raise ValueError("No output ranges for Step7c segment cut")

    parts: list[str] = []
    concat_inputs: list[str] = []

    for index, (start, end) in enumerate(ranges):
        v_label = f"v{index}"
        parts.append(
            f"[0:v]trim=start={start:.3f}:end={end:.3f},setpts=PTS-STARTPTS[{v_label}]"
        )
        if has_audio:
            a_label = f"a{index}"
            parts.append(
                f"[0:a]atrim=start={start:.3f}:end={end:.3f},asetpts=PTS-STARTPTS[{a_label}]"
            )
            concat_inputs.append(f"[{v_label}][{a_label}]")
        else:
            concat_inputs.append(f"[{v_label}]")

    n = len(ranges)
    if has_audio:
        parts.append(f"{''.join(concat_inputs)}concat=n={n}:v=1:a=1[outv][outa]")
    else:
        parts.append(f"{''.join(concat_inputs)}concat=n={n}:v=1:a=0[outv]")

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
