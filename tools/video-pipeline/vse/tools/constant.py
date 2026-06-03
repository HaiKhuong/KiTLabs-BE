"""Constants for VSE."""

from enum import Enum


class SubtitleArea(Enum):
    """Default subtitle area hint (coarse crop before OCR)."""

    LOWER_PART = 0  # subtitle in lower half
    UPPER_PART = 1  # subtitle in upper half
    UNKNOWN = 2  # full frame


class BackgroundColor(Enum):
    WHITE = 0
    DARK = 1
    UNKNOWN = 2


class VideoSubFinderDecoder(Enum):
    OPENCV = "OpenCV"
    FFMPEG = "FFmpeg"


BGR_COLOR_GREEN = (0, 0xFF, 0)
BGR_COLOR_BLUE = (0xFF, 0, 0)
BGR_COLOR_RED = (0, 0, 0xFF)
BGR_COLOR_WHITE = (0xFF, 0xFF, 0xFF)
