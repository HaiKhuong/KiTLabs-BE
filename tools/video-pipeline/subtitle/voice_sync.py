"""
Subtitle Timing Optimizer (Đồng Bộ Voice).

Chạy sau Step 2 (vi.srt) để mở rộng end cue thiếu thời gian bằng gap phía sau,
ước lượng duration theo CPS + pause + tail pad + TTS silence.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any, Callable

from audio_tts_with_pauses import (
    _resolve_pause_sec,
    _resolve_tail_pad_sec,
    _tokenize_with_pauses,
)


@dataclass
class VoiceSyncReport:
    extended: int = 0
    overlaps_fixed: int = 0
    unchanged: int = 0
    details: list[str] = field(default_factory=list)


@dataclass
class _CueState:
    index: int
    start_ms: int
    end_ms: int
    text: str


def compact_text_len(text: str) -> int:
    return len(re.sub(r"\s+", "", str(text or "")))


def resolve_base_tail_pad_ms() -> int:
    return int(_resolve_tail_pad_sec() * 1000)


def resolve_effective_tail_pad_ms(
    text: str,
    current_ms: int,
    *,
    base_tail_pad_ms: int | None = None,
    short_text_max_chars: int = 14,
    short_timeline_max_ms: int = 1500,
) -> int:
    base = base_tail_pad_ms if base_tail_pad_ms is not None else resolve_base_tail_pad_ms()
    compact_len = compact_text_len(text)
    is_short_text = compact_len > 0 and compact_len <= short_text_max_chars
    is_short_timeline = current_ms > 0 and current_ms <= short_timeline_max_ms
    if is_short_text and is_short_timeline:
        return max(0, base // 2)
    return base


def estimate_pause_ms(text: str) -> int:
    pause_sec = _resolve_pause_sec(None)
    chunks = _tokenize_with_pauses(str(text or ""), engine="omnivoice")
    total_sec = 0.0
    for chunk in chunks:
        pause_key = chunk.get("pause_after")
        if pause_key and pause_key in pause_sec:
            total_sec += pause_sec[pause_key]
    return int(round(total_sec * 1000))


def speech_ms(compact_len: int, target_cps: float) -> int:
    if compact_len <= 0 or target_cps <= 0:
        return 0
    return int(math.ceil(compact_len / target_cps * 1000))


def estimate_required_ms(
    text: str,
    current_ms: int,
    *,
    target_cps: float,
    tts_head_ms: int,
    tts_tail_ms: int,
    short_text_max_chars: int = 14,
    short_timeline_max_ms: int = 1500,
) -> int:
    compact_len = compact_text_len(text)
    if compact_len <= 0:
        return 0
    tail_pad_ms = resolve_effective_tail_pad_ms(
        text,
        current_ms,
        short_text_max_chars=short_text_max_chars,
        short_timeline_max_ms=short_timeline_max_ms,
    )
    return (
        speech_ms(compact_len, target_cps)
        + estimate_pause_ms(text)
        + tail_pad_ms
        + int(tts_head_ms)
        + int(tts_tail_ms)
    )


def srt_time_to_ms(time_str: str) -> int:
    hms, ms = time_str.strip().split(",")
    h, m, s = hms.split(":")
    return int(h) * 3_600_000 + int(m) * 60_000 + int(s) * 1000 + int(ms)


def ms_to_srt_time(ms: int) -> str:
    ms = max(0, int(ms))
    h = ms // 3_600_000
    ms %= 3_600_000
    m = ms // 60_000
    ms %= 60_000
    s = ms // 1000
    ms %= 1000
    return f"{h:02}:{m:02}:{s:02},{ms:03}"


def parse_srt_time_range(time_range: str) -> tuple[int, int]:
    start_str, end_str = [x.strip() for x in time_range.split("-->")]
    return srt_time_to_ms(start_str), srt_time_to_ms(end_str)


def format_srt_time_range(start_ms: int, end_ms: int) -> str:
    return f"{ms_to_srt_time(start_ms)} --> {ms_to_srt_time(end_ms)}"


def _blocks_to_cues(blocks: list[dict[str, Any]]) -> list[_CueState]:
    cues: list[_CueState] = []
    for block in blocks:
        start_ms, end_ms = parse_srt_time_range(block["time"])
        cues.append(
            _CueState(
                index=int(block["index"]),
                start_ms=int(start_ms),
                end_ms=int(end_ms),
                text=str(block.get("text") or ""),
            )
        )
    return cues


def _resolve_overlaps(cues: list[_CueState], *, min_gap_ms: int) -> int:
    fixed = 0
    for i in range(len(cues) - 1):
        cur = cues[i]
        nxt = cues[i + 1]
        if cur.start_ms == nxt.start_ms:
            continue
        if cur.end_ms <= nxt.start_ms:
            continue
        mid = (cur.end_ms + nxt.start_ms) // 2
        cur.end_ms = mid
        nxt.start_ms = mid + min_gap_ms
        fixed += 1
    return fixed


def _extend_cue_ends(
    cues: list[_CueState],
    *,
    target_cps: float,
    min_gap_ms: int,
    min_borrow_gap_ms: int,
    tts_head_ms: int,
    tts_tail_ms: int,
    short_text_max_chars: int,
    short_timeline_max_ms: int,
) -> int:
    extended = 0
    last_idx = len(cues) - 1
    for i, cue in enumerate(cues):
        if i == last_idx:
            continue
        current_ms = cue.end_ms - cue.start_ms
        if current_ms <= 0:
            continue

        nxt = cues[i + 1]
        if cue.start_ms == nxt.start_ms:
            continue

        required_ms = estimate_required_ms(
            cue.text,
            current_ms,
            target_cps=target_cps,
            tts_head_ms=tts_head_ms,
            tts_tail_ms=tts_tail_ms,
            short_text_max_chars=short_text_max_chars,
            short_timeline_max_ms=short_timeline_max_ms,
        )
        deficit = required_ms - current_ms
        if deficit <= 0:
            continue

        gap = nxt.start_ms - cue.end_ms
        if gap <= min_borrow_gap_ms:
            continue

        extend_by = min(deficit, gap - min_gap_ms)
        if extend_by <= 0:
            continue

        cue.end_ms += int(extend_by)
        extended += 1
    return extended


def optimize_subtitle_timings(
    blocks: list[dict[str, Any]],
    *,
    target_cps: float,
    min_gap_ms: int = 10,
    min_borrow_gap_ms: int = 20,
    tts_head_ms: int = 50,
    tts_tail_ms: int = 120,
    short_text_max_chars: int = 14,
    short_timeline_max_ms: int = 1500,
    video_duration_ms: int | None = None,
) -> tuple[list[dict[str, Any]], VoiceSyncReport]:
    del video_duration_ms  # reserved; last cue never extends per spec

    if not blocks:
        return [], VoiceSyncReport()

    cues = _blocks_to_cues(blocks)
    original_ends = [c.end_ms for c in cues]
    original_starts = [c.start_ms for c in cues]

    overlaps_fixed = _resolve_overlaps(cues, min_gap_ms=min_gap_ms)
    extended = _extend_cue_ends(
        cues,
        target_cps=target_cps,
        min_gap_ms=min_gap_ms,
        min_borrow_gap_ms=min_borrow_gap_ms,
        tts_head_ms=tts_head_ms,
        tts_tail_ms=tts_tail_ms,
        short_text_max_chars=short_text_max_chars,
        short_timeline_max_ms=short_timeline_max_ms,
    )

    out_blocks: list[dict[str, Any]] = []
    unchanged = 0
    for idx, (block, cue) in enumerate(zip(blocks, cues)):
        changed = (
            cue.start_ms != original_starts[idx] or cue.end_ms != original_ends[idx]
        )
        if not changed:
            unchanged += 1
        out_blocks.append(
            {
                "index": block["index"],
                "time": format_srt_time_range(cue.start_ms, cue.end_ms),
                "text": block["text"],
            }
        )

    report = VoiceSyncReport(
        extended=extended,
        overlaps_fixed=overlaps_fixed,
        unchanged=unchanged,
    )
    return out_blocks, report


def append_tail_pad_wav(
    input_wav: str,
    output_wav: str,
    tail_pad_ms: int,
    *,
    run_command: Callable[[list[str], str], None],
    ffmpeg_bin: str,
    sample_rate: int = 24000,
) -> None:
    """Concat silence tail pad after a WAV segment (Step 3 runtime)."""
    if tail_pad_ms <= 0:
        import shutil
        from pathlib import Path

        shutil.copyfile(input_wav, output_wav)
        return

    tail_sec = tail_pad_ms / 1000.0
    run_command(
        [
            ffmpeg_bin,
            "-y",
            "-i",
            str(input_wav),
            "-f",
            "lavfi",
            "-t",
            f"{tail_sec:.3f}",
            "-i",
            f"anullsrc=r={sample_rate}:cl=mono",
            "-filter_complex",
            "[0:a][1:a]concat=n=2:v=0:a=1[out]",
            "-map",
            "[out]",
            "-ac",
            "1",
            "-ar",
            str(sample_rate),
            "-c:a",
            "pcm_s16le",
            str(output_wav),
        ],
        "Append tail pad to TTS segment",
    )
