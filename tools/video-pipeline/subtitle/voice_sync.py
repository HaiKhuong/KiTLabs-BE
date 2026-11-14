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
    rebalanced: int = 0
    overlaps_fixed: int = 0
    unchanged: int = 0
    start_shift_capped: int = 0
    max_abs_start_shift_ms: int = 0
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


def apply_speed_factor_ms(required_ms: int, speed_factor: float) -> int:
    """Return timeline needed after allowing audio to play at `speed_factor`."""
    speed = max(1.0, float(speed_factor))
    return int(math.ceil(max(0, int(required_ms)) / speed))


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
    speed_factor: float,
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

        required_ms = apply_speed_factor_ms(
            estimate_required_ms(
                cue.text,
                current_ms,
                target_cps=target_cps,
                tts_head_ms=tts_head_ms,
                tts_tail_ms=tts_tail_ms,
                short_text_max_chars=short_text_max_chars,
                short_timeline_max_ms=short_timeline_max_ms,
            ),
            speed_factor,
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


def _rebalance_neighbor_cues(
    cues: list[_CueState],
    *,
    target_cps: float,
    min_gap_ms: int,
    min_borrow_gap_ms: int,
    tts_head_ms: int,
    tts_tail_ms: int,
    short_text_max_chars: int,
    short_timeline_max_ms: int,
    speed_factor: float,
    max_start_shift_ms: int,
    anchor_starts: list[int],
    neighbor_window: int = 2,
) -> tuple[int, int]:
    """
    Dò tối đa `neighbor_window` (mặc định 2) SRT trước & sau câu đang thiếu thời lượng
    (`deficit = required_ms - current_ms > 0`).
    Nếu câu lân cận có khoảng trống (`gap`) hoặc dư thời lượng nội tại (`surplus = current_ms - required_ms > 0`),
    dịch chuyển điểm bắt đầu/kết thúc của các câu trung gian để lấp khoảng trống đó vào câu đang thiếu.
    """
    if len(cues) < 2 or neighbor_window <= 0:
        return 0, 0

    max_start_shift_ms = max(0, int(max_start_shift_ms))
    # Track the total amount subtracted from each cue across the sequential
    # scan. A cue may move earlier multiple times, but its cumulative
    # subtraction may never exceed the configured limit.
    subtracted_start_ms = [0] * len(cues)
    start_shift_capped = 0

    def _limit_start_shift(
        requested_ms: int,
        affected_indices: range,
        *,
        earlier: bool,
    ) -> tuple[int, bool]:
        requested = max(0, int(requested_ms))
        indices = list(affected_indices)
        if requested <= 0 or not indices:
            return requested, False

        if earlier:
            remaining_from_anchor = min(
                cues[idx].start_ms - (anchor_starts[idx] - max_start_shift_ms)
                for idx in indices
            )
            remaining_subtraction = min(
                max_start_shift_ms - subtracted_start_ms[idx] for idx in indices
            )
            allowed = min(
                requested,
                max(0, remaining_from_anchor),
                max(0, remaining_subtraction),
            )
        else:
            remaining = min(
                (anchor_starts[idx] + max_start_shift_ms) - cues[idx].start_ms
                for idx in indices
            )
            allowed = min(requested, max(0, remaining))
        return int(allowed), allowed < requested

    def _record_shifted_earlier(affected_indices: range, amount_ms: int) -> None:
        for idx in affected_indices:
            subtracted_start_ms[idx] += int(amount_ms)

    def _req_ms(cue: _CueState) -> int:
        cur_ms = max(0, cue.end_ms - cue.start_ms)
        return apply_speed_factor_ms(
            estimate_required_ms(
                cue.text,
                cur_ms,
                target_cps=target_cps,
                tts_head_ms=tts_head_ms,
                tts_tail_ms=tts_tail_ms,
                short_text_max_chars=short_text_max_chars,
                short_timeline_max_ms=short_timeline_max_ms,
            ),
            speed_factor,
        )

    rebalanced_count = 0
    n = len(cues)

    for i, cue in enumerate(cues):
        current_ms = cue.end_ms - cue.start_ms
        if current_ms <= 0:
            continue

        deficit = _req_ms(cue) - current_ms
        if deficit <= 0:
            continue

        gained_total = 0

        # ------------------------------------------------------------------
        # 1. Dò `neighbor_window` SRT phía trước (i - 1, i - 2, ...)
        # ------------------------------------------------------------------
        for dist in range(1, neighbor_window + 1):
            donor_idx = i - dist
            if donor_idx < 0 or deficit <= 0:
                break

            # Không dịch chuyển qua các cặp cue có cùng start_ms
            if any(
                cues[m].start_ms == cues[m + 1].start_ms
                for m in range(donor_idx, i)
            ):
                break

            donor = cues[donor_idx]
            after_donor = cues[donor_idx + 1]

            # 1a. Mượn khoảng trống (gap) giữa donor và câu kế tiếp nó
            gap = after_donor.start_ms - donor.end_ms
            avail_gap = (gap - min_gap_ms) if gap > min_borrow_gap_ms else 0
            requested_gap = min(deficit, max(0, int(avail_gap)))
            affected = range(donor_idx + 1, i + 1)
            take_gap, was_capped = _limit_start_shift(
                requested_gap, affected, earlier=True
            )
            if was_capped:
                start_shift_capped += 1
            if take_gap > 0:
                for m in range(donor_idx + 1, i):
                    cues[m].start_ms -= take_gap
                    cues[m].end_ms -= take_gap
                cue.start_ms -= take_gap
                _record_shifted_earlier(affected, take_gap)
                deficit -= take_gap
                gained_total += take_gap

            # 1b. Mượn phần dư nội tại (surplus) của donor
            if deficit > 0:
                donor_cur_ms = donor.end_ms - donor.start_ms
                donor_req_ms = _req_ms(donor)
                surplus = max(0, donor_cur_ms - donor_req_ms)
                requested_surplus = min(deficit, int(surplus))
                affected = range(donor_idx + 1, i + 1)
                take_surplus, was_capped = _limit_start_shift(
                    requested_surplus, affected, earlier=True
                )
                if was_capped:
                    start_shift_capped += 1
                if take_surplus > 0:
                    donor.end_ms -= take_surplus
                    for m in range(donor_idx + 1, i):
                        cues[m].start_ms -= take_surplus
                        cues[m].end_ms -= take_surplus
                    cue.start_ms -= take_surplus
                    _record_shifted_earlier(affected, take_surplus)
                    deficit -= take_surplus
                    gained_total += take_surplus

        # ------------------------------------------------------------------
        # 2. Dò `neighbor_window` SRT phía sau (i + 1, i + 2, ...)
        # ------------------------------------------------------------------
        for dist in range(1, neighbor_window + 1):
            donor_idx = i + dist
            if donor_idx >= n or deficit <= 0:
                break

            # Không dịch chuyển qua các cặp cue có cùng start_ms
            if any(
                cues[m].start_ms == cues[m + 1].start_ms
                for m in range(i, donor_idx)
            ):
                break

            donor = cues[donor_idx]
            before_donor = cues[donor_idx - 1]

            # 2a. Mượn khoảng trống (gap) giữa câu trước donor và donor
            gap = donor.start_ms - before_donor.end_ms
            avail_gap = (gap - min_gap_ms) if gap > min_borrow_gap_ms else 0
            requested_gap = min(deficit, max(0, int(avail_gap)))
            affected = range(i + 1, donor_idx)
            take_gap, was_capped = _limit_start_shift(
                requested_gap, affected, earlier=False
            )
            if was_capped:
                start_shift_capped += 1
            if take_gap > 0:
                for m in range(i + 1, donor_idx):
                    cues[m].start_ms += take_gap
                    cues[m].end_ms += take_gap
                cue.end_ms += take_gap
                deficit -= take_gap
                gained_total += take_gap

            # 2b. Mượn phần dư nội tại (surplus) của donor
            if deficit > 0:
                donor_cur_ms = donor.end_ms - donor.start_ms
                donor_req_ms = _req_ms(donor)
                surplus = max(0, donor_cur_ms - donor_req_ms)
                requested_surplus = min(deficit, int(surplus))
                affected = range(i + 1, donor_idx + 1)
                take_surplus, was_capped = _limit_start_shift(
                    requested_surplus, affected, earlier=False
                )
                if was_capped:
                    start_shift_capped += 1
                if take_surplus > 0:
                    donor.start_ms += take_surplus
                    for m in range(i + 1, donor_idx):
                        cues[m].start_ms += take_surplus
                        cues[m].end_ms += take_surplus
                    cue.end_ms += take_surplus
                    deficit -= take_surplus
                    gained_total += take_surplus

        if gained_total > 0:
            rebalanced_count += 1

    return rebalanced_count, start_shift_capped


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
    rebalance_neighbors: bool = True,
    neighbor_window: int = 2,
    max_start_shift_ms: int = 400,
    speed_factor: float = 1.1,
) -> tuple[list[dict[str, Any]], VoiceSyncReport]:
    del video_duration_ms  # reserved; last cue never extends per spec

    if not blocks:
        return [], VoiceSyncReport()

    cues = _blocks_to_cues(blocks)
    original_ends = [c.end_ms for c in cues]
    original_starts = [c.start_ms for c in cues]

    overlaps_fixed = _resolve_overlaps(cues, min_gap_ms=min_gap_ms)
    # Rebalance limits are anchored after overlap repair, so overlap repair is
    # intentionally exempt from the +/- start-shift cap.
    rebalance_anchor_starts = [c.start_ms for c in cues]
    extended = _extend_cue_ends(
        cues,
        target_cps=target_cps,
        min_gap_ms=min_gap_ms,
        min_borrow_gap_ms=min_borrow_gap_ms,
        tts_head_ms=tts_head_ms,
        tts_tail_ms=tts_tail_ms,
        short_text_max_chars=short_text_max_chars,
        short_timeline_max_ms=short_timeline_max_ms,
        speed_factor=speed_factor,
    )
    rebalanced = 0
    start_shift_capped = 0
    if rebalance_neighbors and neighbor_window > 0:
        rebalanced, start_shift_capped = _rebalance_neighbor_cues(
            cues,
            target_cps=target_cps,
            min_gap_ms=min_gap_ms,
            min_borrow_gap_ms=min_borrow_gap_ms,
            tts_head_ms=tts_head_ms,
            tts_tail_ms=tts_tail_ms,
            short_text_max_chars=short_text_max_chars,
            short_timeline_max_ms=short_timeline_max_ms,
            speed_factor=speed_factor,
            max_start_shift_ms=max_start_shift_ms,
            anchor_starts=rebalance_anchor_starts,
            neighbor_window=neighbor_window,
        )

    max_abs_start_shift_ms = max(
        (
            abs(cue.start_ms - rebalance_anchor_starts[idx])
            for idx, cue in enumerate(cues)
        ),
        default=0,
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
        rebalanced=rebalanced,
        overlaps_fixed=overlaps_fixed,
        unchanged=unchanged,
        start_shift_capped=start_shift_capped,
        max_abs_start_shift_ms=max_abs_start_shift_ms,
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
