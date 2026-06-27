"""Data models for OCR subtitle pipeline."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class OcrFrameResult:
    """Single OCR result from one frame."""
    timestamp_sec: float
    text: str
    confidence: float  # avg confidence across detected lines in this frame


@dataclass
class SubtitleSegment:
    """A merged subtitle block with timeline."""
    start_sec: float
    end_sec: float
    text: str
    confidence: float = 0.0
    frame_count: int = 1  # how many frames contributed to this segment
