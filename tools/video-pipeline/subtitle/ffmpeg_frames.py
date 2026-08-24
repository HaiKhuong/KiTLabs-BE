"""FFmpeg-based frame extraction via pipe (no disk IO for scan frames).

Provides:
- probe_frames_to_memory: extract N sample frames at given timestamps (for crop detection)
- iter_vf_frames: stream frames through an arbitrary -vf chain (crop/gray/fps) via rawvideo pipe
- iter_cropped_frames: legacy helper using band_lo/band_hi crop_vf builder
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Callable, Generator, Iterator


def _ffprobe_video_dimensions(ffmpeg_bin: str, video_path: Path) -> tuple[int, int]:
    """Get video width and height via ffprobe (sibling of ffmpeg_bin)."""
    ffprobe_bin = str(Path(ffmpeg_bin).parent / "ffprobe")
    if not Path(ffprobe_bin).exists() and not Path(ffprobe_bin + ".exe").exists():
        ffprobe_bin = "ffprobe"
    cmd = [
        ffprobe_bin, "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height",
        "-of", "csv=p=0:s=x",
        str(video_path),
    ]
    try:
        out = subprocess.check_output(cmd, stderr=subprocess.PIPE, timeout=30).decode().strip()
        w, h = out.split("x")
        return int(w), int(h)
    except Exception:
        return 0, 0


def build_crop_vf(
    band_lo: float, band_hi: float,
    h_trim_left: float = 0.0, h_trim_right: float = 0.0,
    fps: float | None = None,
) -> str:
    """Build FFmpeg -vf string to crop subtitle band + horizontal trim.

    band_lo/band_hi: fraction from bottom of frame (0=bottom edge, 1=top).
    """
    strip_h = band_hi - band_lo
    y_offset = 1.0 - band_hi  # from top

    parts = [f"crop=iw:ih*{strip_h:.6f}:0:ih*{y_offset:.6f}"]

    wfrac = max(0.02, 1.0 - h_trim_left - h_trim_right)
    if h_trim_left > 1e-9 or h_trim_right > 1e-9:
        parts.append(f"crop=iw*{wfrac:.6f}:ih:iw*{h_trim_left:.6f}:0")

    if fps is not None and fps > 0:
        parts.append(f"fps={fps}")

    return ",".join(parts)


def probe_frames_to_memory(
    video_path: Path,
    timestamps_sec: list[float],
    ffmpeg_bin: str,
    vf: str = "",
    log: Callable[[str], None] | None = None,
) -> list:
    """Extract probe frames to memory via FFmpeg pipe (no temp files).

    Returns list of BGR numpy arrays (one per successful timestamp).
    """
    import cv2
    import numpy as np

    frames: list = []
    for i, t in enumerate(timestamps_sec):
        cmd = [
            ffmpeg_bin, "-y", "-ss", f"{t:.3f}", "-i", str(video_path),
        ]
        if vf:
            cmd += ["-vf", vf]
        cmd += ["-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"]

        try:
            proc = subprocess.run(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30,
            )
            if proc.returncode != 0 or not proc.stdout:
                continue
            buf = np.frombuffer(proc.stdout, dtype=np.uint8)
            img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
            if img is not None and img.size > 0:
                frames.append(img)
        except (subprocess.TimeoutExpired, OSError) as exc:
            if log:
                log(f"ffmpeg_frames: probe frame {i} @ {t:.2f}s failed: {exc}")
            continue
    return frames


def _probe_vf_frame_shape(
    video_path: Path,
    ffmpeg_bin: str,
    vf: str,
) -> tuple[int, int, int]:
    """Return (width, height, channels) for one frame after ``vf``."""
    import cv2
    import numpy as np

    cmd = [
        ffmpeg_bin, "-ss", "0.5", "-i", str(video_path),
        "-vf", vf, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-",
    ]
    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        if proc.returncode == 0 and proc.stdout:
            buf = np.frombuffer(proc.stdout, dtype=np.uint8)
            img = cv2.imdecode(buf, cv2.IMREAD_UNCHANGED)
            if img is not None and img.size > 0:
                if img.ndim == 2:
                    return int(img.shape[1]), int(img.shape[0]), 1
                if img.shape[2] == 1:
                    return int(img.shape[1]), int(img.shape[0]), 1
                return int(img.shape[1]), int(img.shape[0]), 3
    except Exception:
        pass
    return 0, 0, 0


def _vf_with_fps(vf: str, scan_fps: float) -> str:
    if scan_fps > 0 and not re.search(r"(?:^|,)fps=", vf):
        return f"{vf},fps={scan_fps}"
    return vf


def iter_vf_frames(
    video_path: Path,
    ffmpeg_bin: str,
    vf: str,
    scan_fps: float,
    *,
    log: Callable[[str], None] | None = None,
) -> Iterator[tuple[int, float, "np.ndarray"]]:
    """Stream preprocessed frames via FFmpeg rawvideo pipe (no PNG folder).

    Yields ``(frame_index, timestamp_sec, ndarray)`` where ndarray is gray (H,W) or BGR (H,W,3).
    """
    import numpy as np

    vf_full = _vf_with_fps(vf, scan_fps)
    out_w, out_h, channels = _probe_vf_frame_shape(video_path, ffmpeg_bin, vf_full)
    if out_w <= 0 or out_h <= 0 or channels not in (1, 3):
        if log:
            log("ffmpeg_frames: vf probe failed, falling back to cv2 VideoCapture")
        for idx, (ts, frame) in enumerate(
            _fallback_cv2_iter(video_path, scan_fps, vf_full, log)
        ):
            yield idx, ts, frame
        return

    pix_fmt = "gray" if channels == 1 else "bgr24"
    frame_size = out_w * out_h * channels
    cmd = [
        ffmpeg_bin, "-i", str(video_path),
        "-vf", vf_full,
        "-an", "-sn", "-dn",
        "-f", "rawvideo", "-pix_fmt", pix_fmt, "-",
    ]

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=frame_size * 4,
        )
    except OSError as exc:
        if log:
            log(f"ffmpeg_frames: pipe start failed ({exc}), falling back to cv2")
        for idx, (ts, frame) in enumerate(
            _fallback_cv2_iter(video_path, scan_fps, vf_full, log)
        ):
            yield idx, ts, frame
        return

    frame_idx = 0
    try:
        assert proc.stdout is not None
        while True:
            raw = proc.stdout.read(frame_size)
            if len(raw) < frame_size:
                break
            if channels == 1:
                frame = np.frombuffer(raw, dtype=np.uint8).reshape((out_h, out_w))
            else:
                frame = np.frombuffer(raw, dtype=np.uint8).reshape((out_h, out_w, 3))
            ts = frame_idx / scan_fps if scan_fps > 0 else 0.0
            yield frame_idx, ts, frame.copy()
            frame_idx += 1
    finally:
        if proc.stdout:
            proc.stdout.close()
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

    if log:
        log(f"ffmpeg_frames: pipe stream done — {frame_idx} frame(s)")


def _compute_output_dimensions(
    video_path: Path, ffmpeg_bin: str, vf: str,
) -> tuple[int, int]:
    """Run a 1-frame ffmpeg to determine output width/height after vf filters."""
    import cv2
    import numpy as np

    cmd = [
        ffmpeg_bin, "-ss", "0.5", "-i", str(video_path),
        "-vf", vf, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-",
    ]
    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        if proc.returncode == 0 and proc.stdout:
            buf = np.frombuffer(proc.stdout, dtype=np.uint8)
            img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
            if img is not None:
                return img.shape[1], img.shape[0]
    except Exception:
        pass
    return 0, 0


def iter_cropped_frames(
    video_path: Path,
    ffmpeg_bin: str,
    crop_vf: str,
    scan_fps: float,
    log: Callable[[str], None] | None = None,
) -> Generator[tuple[float, "np.ndarray"], None, None]:
    """Stream cropped subtitle-region frames via FFmpeg rawvideo pipe."""
    for _idx, ts, frame in iter_vf_frames(
        video_path, ffmpeg_bin, crop_vf, scan_fps, log=log
    ):
        yield ts, frame


def _fallback_cv2_iter(
    video_path: Path,
    scan_fps: float,
    crop_vf: str,
    log: Callable[[str], None] | None = None,
) -> Generator[tuple[float, "np.ndarray"], None, None]:
    """Fallback: use cv2.VideoCapture when FFmpeg pipe is unavailable.

    Parses crop_vf to approximate the crop region (band_lo/band_hi style).
    """
    import cv2
    import re
    import numpy as np

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        if log:
            log(f"ffmpeg_frames: cv2 fallback also failed to open {video_path}")
        return

    native_fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    scan_step = max(1, int(round(native_fps / scan_fps)))

    # Try to parse band parameters from crop_vf "crop=iw:ih*H:0:ih*Y"
    band_hi_match = re.search(r"crop=iw:ih\*([0-9.]+):0:ih\*([0-9.]+)", crop_vf)
    strip_h_frac = 0.2
    y_offset_frac = 0.8
    if band_hi_match:
        strip_h_frac = float(band_hi_match.group(1))
        y_offset_frac = float(band_hi_match.group(2))

    # Horizontal trim
    htrim_match = re.search(r"crop=iw\*([0-9.]+):ih:iw\*([0-9.]+):0", crop_vf)
    h_wfrac = 1.0
    h_left = 0.0
    if htrim_match:
        h_wfrac = float(htrim_match.group(1))
        h_left = float(htrim_match.group(2))

    frame_idx = 0
    output_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if frame_idx % scan_step == 0:
            ih, iw = frame.shape[:2]
            # Vertical crop
            h = max(1, int(round(ih * strip_h_frac)))
            top = max(0, int(round(ih * y_offset_frac)))
            strip = frame[top:top + h, :]
            # Horizontal trim
            if h_wfrac < 1.0 - 1e-9:
                sw = strip.shape[1]
                x0 = int(sw * h_left)
                x1 = int(sw * (h_left + h_wfrac))
                strip = strip[:, x0:x1]
            ts = output_idx / scan_fps
            yield ts, strip
            output_idx += 1
        frame_idx += 1
    cap.release()

    if log:
        log(f"ffmpeg_frames: cv2 fallback done — {output_idx} frames")
