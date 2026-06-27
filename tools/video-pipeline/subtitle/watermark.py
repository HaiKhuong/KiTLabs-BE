"""Watermark filter: remove platform watermarks and persistent on-screen text.

Two strategies:
1. Static blacklist — known platform names (腾讯视频, bilibili, etc.)
2. Frequency filter — text appearing on too many frames is likely a watermark
"""

from __future__ import annotations

import re
from typing import Callable

from subtitle.models import SubtitleSegment
from subtitle.normalize import clean_text

# Default platform watermark blacklist (partial match after normalization)
DEFAULT_WATERMARK_BLACKLIST = (
    "腾讯视频",
    "优酷",
    "爱奇艺",
    "芒果TV",
    "bilibili",
    "VIP",
    "独播",
    "搜狐视频",
    "乐视",
    "PP视频",
    "咪咕视频",
)

# Builtin skip regexes (UI elements, timestamps, subscription prompts)
BUILTIN_SKIP_REGEXES = (
    r"(?i)^\s*(订阅|点赞|收藏|分享|转发|AlCheng动漫)\s*$",
    r"(?i)^\s*会员\s*\d*\s*$",
    r"(?i)^\s*温馨提示\s*$",
    r"^\s*\d{1,2}:\d{2}(:\d{2})?\s*[-–~至]\s*\d{1,2}:\d{2}(:\d{2})?\s*$",
)


def build_skip_regexes(
    extra_patterns: list[str] | None = None,
    include_builtins: bool = True,
) -> list[re.Pattern]:
    """Compile skip regex patterns."""
    patterns = []
    if include_builtins:
        patterns.extend(BUILTIN_SKIP_REGEXES)
    if extra_patterns:
        patterns.extend(extra_patterns)
    compiled = []
    for p in patterns:
        try:
            compiled.append(re.compile(p))
        except re.error:
            pass
    return compiled


def should_skip_text(text: str, skip_regexes: list[re.Pattern]) -> bool:
    """Check if text matches any skip regex (fullmatch)."""
    t = re.sub(r"\s+", " ", (text or "").strip())
    if not t:
        return True
    for cre in skip_regexes:
        try:
            if cre.fullmatch(t):
                return True
        except re.error:
            continue
    return False


def filter_watermarks(
    segments: list[SubtitleSegment],
    *,
    blacklist: tuple[str, ...] | list[str] = DEFAULT_WATERMARK_BLACKLIST,
    skip_regexes: list[re.Pattern] | None = None,
    min_frame_count: int = 0,
    total_scan_frames: int = 0,
    log: Callable[[str], None] | None = None,
) -> list[SubtitleSegment]:
    """Filter watermark segments from the list.

    Args:
        segments: merged subtitle segments
        blacklist: platform name substrings to remove
        skip_regexes: compiled regex patterns for skip matching
        min_frame_count: if a segment's frame_count exceeds this, treat as watermark
                        (0 = disabled; set to e.g. total_frames * 0.8 for frequency filter)
        total_scan_frames: total frames scanned (used for adaptive threshold)
        log: optional logger
    """
    if not segments:
        return []

    # Adaptive min_frame_count: if not explicitly set, use 80% of total frames
    effective_min_frames = min_frame_count
    if effective_min_frames <= 0 and total_scan_frames > 100:
        effective_min_frames = int(total_scan_frames * 0.8)

    kept: list[SubtitleSegment] = []
    removed_blacklist = 0
    removed_regex = 0
    removed_frequency = 0

    for seg in segments:
        normalized = clean_text(seg.text)

        # 1. Blacklist check (substring)
        if any(bl in normalized for bl in blacklist):
            removed_blacklist += 1
            continue

        # 2. Skip regex check
        if skip_regexes and should_skip_text(normalized, skip_regexes):
            removed_regex += 1
            continue

        # 3. Frequency filter: short text appearing on too many frames
        if (
            effective_min_frames > 0
            and seg.frame_count >= effective_min_frames
            and len(normalized) <= 20
        ):
            removed_frequency += 1
            continue

        kept.append(seg)

    total_removed = removed_blacklist + removed_regex + removed_frequency
    if log and total_removed > 0:
        log(
            f"subtitle.watermark: filtered {total_removed} segment(s) "
            f"(blacklist={removed_blacklist}, regex={removed_regex}, frequency={removed_frequency})"
        )
    return kept
