"""Subtitle merge pipeline: fuzzy grouping, majority vote, confidence vote, SRT export.

Replaces the old "longest text wins" heuristic with a proper voting system.
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable

from subtitle.models import OcrFrameResult, SubtitleSegment
from subtitle.normalize import clean_text, same_subtitle_line


def fuzzy_group_and_vote(
    ocr_results: list[OcrFrameResult],
    fuzzy_threshold: float,
    frame_interval_sec: float,
    merge_gap_ms: int,
    min_duration_ms: int,
    log: Callable[[str], None] | None = None,
) -> list[SubtitleSegment]:
    """Full merge pipeline: normalize -> fuzzy group -> majority+confidence vote -> timeline merge.

    Returns list of SubtitleSegment ready for SRT export or watermark filter.
    """
    if not ocr_results:
        return []

    # 1. Clean text
    cleaned = []
    for r in ocr_results:
        t = clean_text(r.text)
        if t:
            cleaned.append(OcrFrameResult(r.timestamp_sec, t, r.confidence))
    if not cleaned:
        return []

    # 2. Fuzzy grouping: consecutive similar frames form a cluster
    clusters: list[list[OcrFrameResult]] = []
    for frame in cleaned:
        if clusters and same_subtitle_line(clusters[-1][-1].text, frame.text, fuzzy_threshold):
            clusters[-1].append(frame)
        else:
            clusters.append([frame])

    # 3. Per-cluster majority + confidence vote
    segments: list[SubtitleSegment] = []
    for cluster in clusters:
        text = _vote_best_text(cluster, fuzzy_threshold)
        start = cluster[0].timestamp_sec
        end = cluster[-1].timestamp_sec + frame_interval_sec
        avg_conf = sum(f.confidence for f in cluster) / len(cluster) if cluster else 0.0
        segments.append(SubtitleSegment(
            start_sec=start,
            end_sec=end,
            text=text,
            confidence=avg_conf,
            frame_count=len(cluster),
        ))

    # 4. Timeline merge: merge adjacent segments with same text within gap
    merged = _timeline_merge(segments, fuzzy_threshold, merge_gap_ms)

    # 5. Enforce minimum duration
    for seg in merged:
        if (seg.end_sec - seg.start_sec) * 1000 < min_duration_ms:
            seg.end_sec = seg.start_sec + min_duration_ms / 1000.0

    if log:
        log(f"subtitle.merge: {len(cleaned)} frames -> {len(clusters)} clusters -> {len(merged)} segments")
    return merged


def _vote_best_text(cluster: list[OcrFrameResult], fuzzy_threshold: float) -> str:
    """Select best text from a cluster using majority count + confidence tie-break."""
    if len(cluster) == 1:
        return cluster[0].text

    # Group similar texts within the cluster
    variants: list[dict] = []  # [{"text": str, "count": int, "total_conf": float}]
    for frame in cluster:
        matched = False
        for v in variants:
            if same_subtitle_line(v["text"], frame.text, fuzzy_threshold):
                v["count"] += 1
                v["total_conf"] += frame.confidence
                # Keep longer text as representative if tied
                if len(frame.text) > len(v["text"]):
                    v["text"] = frame.text
                matched = True
                break
        if not matched:
            variants.append({"text": frame.text, "count": 1, "total_conf": frame.confidence})

    # Sort by count desc, then by total_conf desc
    variants.sort(key=lambda v: (v["count"], v["total_conf"]), reverse=True)
    return variants[0]["text"]


def _timeline_merge(
    segments: list[SubtitleSegment],
    fuzzy_threshold: float,
    merge_gap_ms: int,
) -> list[SubtitleSegment]:
    """Merge adjacent segments with similar text that are close in time."""
    if not segments:
        return []

    merged: list[SubtitleSegment] = []
    for seg in segments:
        if (
            merged
            and same_subtitle_line(merged[-1].text, seg.text, fuzzy_threshold)
            and (seg.start_sec - merged[-1].end_sec) * 1000 <= merge_gap_ms
        ):
            merged[-1].end_sec = seg.end_sec
            merged[-1].frame_count += seg.frame_count
            # Keep the text from the segment with more frames (majority principle)
            if seg.frame_count > merged[-1].frame_count - seg.frame_count:
                merged[-1].text = seg.text
            merged[-1].confidence = (
                (merged[-1].confidence * (merged[-1].frame_count - seg.frame_count)
                 + seg.confidence * seg.frame_count)
                / merged[-1].frame_count
            )
        else:
            merged.append(SubtitleSegment(
                start_sec=seg.start_sec,
                end_sec=seg.end_sec,
                text=seg.text,
                confidence=seg.confidence,
                frame_count=seg.frame_count,
            ))
    return merged


def segments_to_srt(
    segments: list[SubtitleSegment],
    srt_path: Path,
    fmt_time: Callable[[float], str],
) -> Path:
    """Export SubtitleSegments to SRT file."""
    with open(srt_path, "w", encoding="utf8") as f:
        for i, seg in enumerate(segments, 1):
            f.write(f"{i}\n{fmt_time(seg.start_sec)} --> {fmt_time(seg.end_sec)}\n{seg.text}\n\n")
    return srt_path


def _srt_time_to_ms(time_str: str) -> int:
    hms, ms = time_str.strip().split(",")
    hours, minutes, seconds = hms.split(":")
    return int(hours) * 3_600_000 + int(minutes) * 60_000 + int(seconds) * 1000 + int(ms)


def _ms_to_srt_time(ms: int) -> str:
    ms = max(0, int(ms))
    hours = ms // 3_600_000
    ms %= 3_600_000
    minutes = ms // 60_000
    ms %= 60_000
    seconds = ms // 1000
    ms %= 1000
    return f"{hours:02}:{minutes:02}:{seconds:02},{ms:03}"


def _srt_range_ms(time_range: str) -> tuple[int, int]:
    start_str, end_str = [x.strip() for x in str(time_range).split("-->")]
    return _srt_time_to_ms(start_str), _srt_time_to_ms(end_str)


def canonical_subtitle_text(text: str) -> str:
    """Visible subtitle text for 100% equality (strip + newline normalize only)."""
    return str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip()


def merge_exact_duplicate_cues(
    cues: list,
    *,
    max_gap_ms: int = 500,
) -> tuple[list, int]:
    """Merge consecutive cues whose text matches 100% and timelines touch/overlap.

    Each cue is (start_sec, end_sec, text). Returns (cues, merge_count).
    """
    if not cues:
        return [], 0
    gap_ms = max(0, int(max_gap_ms))
    merged = [list(cues[0])]
    merges = 0
    for start, end, text in cues[1:]:
        prev = merged[-1]
        same = canonical_subtitle_text(prev[2]) == canonical_subtitle_text(text)
        same = same and bool(canonical_subtitle_text(text))
        gap = (float(start) - float(prev[1])) * 1000.0
        if same and gap <= gap_ms:
            prev[1] = max(float(prev[1]), float(end))
            merges += 1
        else:
            merged.append([float(start), float(end), text])
    return [(a, b, t) for a, b, t in merged], merges


def merge_exact_duplicate_srt_blocks(
    blocks: list[dict],
    *,
    max_gap_ms: int = 500,
) -> tuple[list[dict], int]:
    """Merge consecutive SRT blocks with identical text and adjacent/overlapping times.

    Keeps the first block's index; extends end time to the last merged cue.
    """
    if not blocks:
        return [], 0
    gap_ms = max(0, int(max_gap_ms))
    merged: list[dict] = []
    merges = 0
    for block in blocks:
        text = str(block.get("text") or "")
        start_ms, end_ms = _srt_range_ms(block["time"])
        if end_ms < start_ms:
            end_ms = start_ms
        if (
            merged
            and canonical_subtitle_text(merged[-1]["text"]) == canonical_subtitle_text(text)
            and canonical_subtitle_text(text)
            and (start_ms - merged[-1]["_end_ms"]) <= gap_ms
        ):
            merged[-1]["_end_ms"] = max(merged[-1]["_end_ms"], end_ms)
            merges += 1
            continue
        merged.append(
            {
                "index": block.get("index"),
                "text": text,
                "_start_ms": start_ms,
                "_end_ms": end_ms,
            }
        )
    out: list[dict] = []
    for item in merged:
        out.append(
            {
                "index": item["index"],
                "time": f"{_ms_to_srt_time(item['_start_ms'])} --> {_ms_to_srt_time(item['_end_ms'])}",
                "text": item["text"],
            }
        )
    return out, merges
