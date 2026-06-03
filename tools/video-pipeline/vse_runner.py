"""
VSE Runner - wrapper for SubtitleExtractor integration with KiTLabs pipeline.

Maps EasyOCR crop band detection to VSE SubtitleArea, runs extraction,
outputs to KiTLabs subtitle directory.
"""

import os
import shutil
from pathlib import Path

# Import config shim first to inject before SubtitleExtractor imports
from vse import config_shim
from vse.config_shim import VseConfig, install, create_config
from vse.bean.subtitle_area import SubtitleArea
from vse.main import SubtitleExtractor


def band_to_subtitle_area(
    band_lo: float,
    band_hi: float,
    frame_width: int,
    frame_height: int,
    h_trim_left: float = 0.15,
    h_trim_right: float = 0.15,
) -> SubtitleArea:
    """
    Convert EasyOCR crop band (from bottom) to VSE SubtitleArea (pixel, from top).

    Args:
        band_lo: Lower bound of subtitle band (from bottom, 0 = bottom edge).
        band_hi: Upper bound of subtitle band (from bottom).
        frame_width: Video frame width in pixels.
        frame_height: Video frame height in pixels.
        h_trim_left: Horizontal trim fraction from left.
        h_trim_right: Horizontal trim fraction from right.

    Returns:
        SubtitleArea with pixel coordinates (origin = top-left).
    """
    ymin = int(frame_height * (1.0 - band_hi))
    ymax = int(frame_height * (1.0 - band_lo))
    xmin = int(frame_width * h_trim_left)
    xmax = int(frame_width * (1.0 - h_trim_right))

    area = SubtitleArea(ymin=ymin, ymax=ymax, xmin=xmin, xmax=xmax)
    area.normalized()
    return area


def run_vse(
    video_path: str,
    output_srt_path: str,
    log_dir: str,
    band_lo: float,
    band_hi: float,
    frame_width: int,
    frame_height: int,
    h_trim_left: float = 0.15,
    h_trim_right: float = 0.15,
    language: str = "ch",
    mode: str = "auto",
    hardware_acceleration: bool = True,
    drop_score: int = 75,
    text_similarity: int = 80,
    extract_frequency: int = 3,
    log_func=None,
) -> str:
    """
    Run VSE subtitle extraction.

    Args:
        video_path: Path to input video.
        output_srt_path: Path to output .zh.srt file.
        log_dir: Directory for temporary files (step1_vse/).
        band_lo: EasyOCR-style band lower bound (from bottom).
        band_hi: EasyOCR-style band upper bound (from bottom).
        frame_width: Video width in pixels.
        frame_height: Video height in pixels.
        h_trim_left: Horizontal trim from left (0-1).
        h_trim_right: Horizontal trim from right (0-1).
        language: OCR language code (ch, en, etc.).
        mode: VSE mode (fast, auto, accurate).
        hardware_acceleration: Enable GPU acceleration.
        drop_score: Minimum confidence score (0-100).
        text_similarity: Dedup similarity threshold (0-100).
        extract_frequency: Frames per second to extract (fallback).
        log_func: Optional logging function.

    Returns:
        Path to generated SRT file.
    """
    log = log_func or print

    # Create and install config
    cfg = create_config(
        language=language,
        mode=mode,
        hardware_acceleration=hardware_acceleration,
        extract_frequency=extract_frequency,
        drop_score=drop_score,
        threshold_text_similarity=text_similarity,
    )
    install(cfg)

    # Create temp directory
    temp_dir = Path(log_dir) / "step1_vse"
    temp_dir.mkdir(parents=True, exist_ok=True)

    # Convert band to SubtitleArea
    sub_area = band_to_subtitle_area(
        band_lo=band_lo,
        band_hi=band_hi,
        frame_width=frame_width,
        frame_height=frame_height,
        h_trim_left=h_trim_left,
        h_trim_right=h_trim_right,
    )

    log(
        f"VSE: ROI ymin={sub_area.ymin} ymax={sub_area.ymax} "
        f"xmin={sub_area.xmin} xmax={sub_area.xmax} "
        f"(band lo={band_lo:.3f} hi={band_hi:.3f})"
    )
    log(f"VSE: mode={mode} lang={language} gpu={hardware_acceleration}")

    # Create extractor
    extractor = SubtitleExtractor(
        vd_path=video_path,
        temp_output_dir=str(temp_dir),
        subtitle_output_path=output_srt_path,
        log_func=log,
    )
    extractor.sub_area = sub_area

    # Run extraction
    extractor.run()

    # Verify output
    if not os.path.exists(output_srt_path):
        raise RuntimeError(f"VSE failed to generate SRT: {output_srt_path}")

    with open(output_srt_path, "r", encoding="utf-8") as f:
        content = f.read().strip()
    if not content:
        raise RuntimeError(f"VSE generated empty SRT: {output_srt_path}")

    log(f"VSE: done → {output_srt_path}")
    return output_srt_path


def run_vse_with_roi_override(
    video_path: str,
    output_srt_path: str,
    log_dir: str,
    roi_normalized: tuple,  # (ymin, ymax, xmin, xmax) normalized 0-1, origin top-left
    frame_width: int,
    frame_height: int,
    language: str = "ch",
    mode: str = "auto",
    hardware_acceleration: bool = True,
    drop_score: int = 75,
    text_similarity: int = 80,
    extract_frequency: int = 3,
    log_func=None,
) -> str:
    """
    Run VSE with explicit ROI (normalized coordinates, VSE-style).

    Args:
        roi_normalized: (ymin, ymax, xmin, xmax) as fractions (0-1), origin top-left.
        Other args same as run_vse().
    """
    log = log_func or print

    ymin_norm, ymax_norm, xmin_norm, xmax_norm = roi_normalized
    sub_area = SubtitleArea(
        ymin=int(frame_height * ymin_norm),
        ymax=int(frame_height * ymax_norm),
        xmin=int(frame_width * xmin_norm),
        xmax=int(frame_width * xmax_norm),
    )
    sub_area.normalized()

    # Convert back to band notation for logging
    band_hi = 1.0 - ymin_norm
    band_lo = 1.0 - ymax_norm

    cfg = create_config(
        language=language,
        mode=mode,
        hardware_acceleration=hardware_acceleration,
        extract_frequency=extract_frequency,
        drop_score=drop_score,
        threshold_text_similarity=text_similarity,
    )
    install(cfg)

    temp_dir = Path(log_dir) / "step1_vse"
    temp_dir.mkdir(parents=True, exist_ok=True)

    log(
        f"VSE: ROI override ymin={sub_area.ymin} ymax={sub_area.ymax} "
        f"xmin={sub_area.xmin} xmax={sub_area.xmax} "
        f"(normalized {roi_normalized})"
    )
    log(f"VSE: mode={mode} lang={language} gpu={hardware_acceleration}")

    extractor = SubtitleExtractor(
        vd_path=video_path,
        temp_output_dir=str(temp_dir),
        subtitle_output_path=output_srt_path,
        log_func=log,
    )
    extractor.sub_area = sub_area
    extractor.run()

    if not os.path.exists(output_srt_path):
        raise RuntimeError(f"VSE failed to generate SRT: {output_srt_path}")

    with open(output_srt_path, "r", encoding="utf-8") as f:
        content = f.read().strip()
    if not content:
        raise RuntimeError(f"VSE generated empty SRT: {output_srt_path}")

    log(f"VSE: done → {output_srt_path}")
    return output_srt_path


def cleanup_vse_temp(log_dir: str):
    """Remove VSE temporary files."""
    temp_dir = Path(log_dir) / "step1_vse"
    if temp_dir.exists():
        shutil.rmtree(temp_dir, ignore_errors=True)
