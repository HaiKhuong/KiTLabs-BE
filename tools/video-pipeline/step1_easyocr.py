"""
Step 1 – EasyOCR engine: visual subtitle extraction from the cropped subtitle region.

Usage:
    from step1_easyocr import configure_step1_easyocr, run as easyocr_run

    configure_step1_easyocr(
        log=log, run_command=run_command, ffmpeg_bin=FFMPEG_BIN,
        progressbar=progressbar, get_media_duration_ms=get_media_duration_ms,
        fmt_time=fmt_time, get_zh_srt_path=get_zh_srt_path, log_dir=LOG_DIR,
        lang=EASYOCR_LANG, gpu=EASYOCR_GPU, fps=EASYOCR_FPS, ...
    )
    srt_path = easyocr_run(video_path)
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any, Callable, List

from subtitle.normalize import clean_text, same_subtitle_line
from subtitle.watermark import build_skip_regexes, should_skip_text

_cfg: dict[str, Any] = {}

# Compiled skip-regex list; rebuilt inside configure_step1_easyocr().
_SKIP_COMPILED: list = []

BUILTIN_SKIP_REGEXES = (
    r"(?i)^\s*(订阅|点赞|收藏|分享|转发|AlCheng动漫)\s*$",
    r"(?i)^\s*会员\s*\d*\s*$",
    r"(?i)^\s*温馨提示\s*$",
    r"^\s*\d{1,2}:\d{2}(:\d{2})?\s*[-–~至]\s*\d{1,2}:\d{2}(:\d{2})?\s*$",
)


# ──────────────────────────────────────────────
# Public API
# ──────────────────────────────────────────────

def configure_step1_easyocr(
    *,
    log: Callable[[str], None],
    run_command: Callable,
    ffmpeg_bin: str,
    progressbar: Callable,
    get_media_duration_ms: Callable,
    fmt_time: Callable,
    get_zh_srt_path: Callable[[], Path],
    log_dir: Path,
    # OCR engine
    lang: list,
    gpu: bool,
    workers: int,
    # Crop band / geometry
    subtitle_crop_band_hi: float,
    crop_probe_frames: int,
    crop_probe_h_trim_left_frac: float,
    crop_probe_h_trim_right_frac: float,
    max_strip_height_ratio: float,
    # Sampling
    fps: float,
    min_duration_ms: int,
    # Confidence / rescue
    min_confidence: float,
    low_conf_floor: float,
    bridge_frames: int,
    bridge_min_match: int,
    # Dedup / merge
    fuzzy_threshold: float,
    merge_gap_ms: int,
    # Preprocessing
    gray_contrast: float,
    gray_brightness: float,
    gray_gamma: float,
    luma_suppress: float,
    white_thresh: int,
    histeq_strength: float,
    gray_invert: bool,
    unsharp: str,
    # Skip regex
    text_skip_defaults_on: bool,
    text_skip_regexes_json: str,
) -> None:
    """Populate module config and rebuild skip-regex list. Call before run()."""
    _cfg.clear()
    _cfg.update(
        log=log,
        run_command=run_command,
        ffmpeg_bin=str(ffmpeg_bin),
        progressbar=progressbar,
        get_media_duration_ms=get_media_duration_ms,
        fmt_time=fmt_time,
        get_zh_srt_path=get_zh_srt_path,
        log_dir=Path(log_dir),
        lang=list(lang),
        gpu=bool(gpu),
        workers=max(1, int(workers)),
        subtitle_crop_band_hi=float(subtitle_crop_band_hi),
        crop_probe_frames=max(1, int(crop_probe_frames)),
        crop_probe_h_trim_left_frac=max(0.0, min(0.49, float(crop_probe_h_trim_left_frac))),
        crop_probe_h_trim_right_frac=max(0.0, min(0.49, float(crop_probe_h_trim_right_frac))),
        max_strip_height_ratio=float(max_strip_height_ratio),
        fps=float(fps),
        min_duration_ms=max(1, int(min_duration_ms)),
        min_confidence=float(min_confidence),
        low_conf_floor=float(low_conf_floor),
        bridge_frames=max(0, int(bridge_frames)),
        bridge_min_match=max(1, int(bridge_min_match)),
        fuzzy_threshold=float(fuzzy_threshold),
        merge_gap_ms=int(merge_gap_ms),
        gray_contrast=float(gray_contrast),
        gray_brightness=float(gray_brightness),
        gray_gamma=float(gray_gamma),
        luma_suppress=float(luma_suppress),
        white_thresh=int(white_thresh),
        histeq_strength=float(histeq_strength),
        gray_invert=bool(gray_invert),
        unsharp=str(unsharp or ""),
        text_skip_defaults_on=bool(text_skip_defaults_on),
        text_skip_regexes_json=str(text_skip_regexes_json or "[]"),
    )
    _rebuild_skip_regexes()


def run(video_path: Path) -> Path:
    """Run EasyOCR subtitle extraction. Returns path to generated .zh.srt file."""
    return _ocr_with_easyocr(video_path)


def get_skip_text_fn() -> Callable[[str], bool]:
    """Return the current _should_skip_merged_text callable (used by PaddleOCR if desired)."""
    return _should_skip_merged_text


# ──────────────────────────────────────────────
# Skip-regex helpers
# ──────────────────────────────────────────────

def _rebuild_skip_regexes() -> None:
    global _SKIP_COMPILED
    patterns: list[str] = []
    if _cfg.get("text_skip_defaults_on", True):
        patterns.extend(BUILTIN_SKIP_REGEXES)
    raw = (_cfg.get("text_skip_regexes_json") or "").strip()
    if raw and raw != "[]":
        try:
            extra = json.loads(raw)
        except json.JSONDecodeError as e:
            _cfg["log"](f"Step1 EasyOCR: text-skip-regexes-json invalid JSON: {e}")
            extra = []
        if isinstance(extra, list):
            for item in extra:
                s = str(item).strip()
                if s:
                    patterns.append(s)
    compiled = []
    for p in patterns:
        try:
            compiled.append(re.compile(p))
        except re.error as e:
            _cfg["log"](f"Step1 EasyOCR: skip-regex compile failed for {p!r}: {e}")
    _SKIP_COMPILED = compiled


def _should_skip_merged_text(text: str) -> bool:
    """True nếu block (đã gộp) fullmatch một trong các regex skip."""
    t = re.sub(r"\s+", " ", (text or "").strip())
    if not t:
        return True
    for cre in _SKIP_COMPILED:
        try:
            if cre.fullmatch(t):
                return True
        except re.error:
            continue
    return False


# ──────────────────────────────────────────────
# Geometry / ffmpeg helpers
# ──────────────────────────────────────────────

def _h_trim_crop_vf() -> str:
    hl = _cfg["crop_probe_h_trim_left_frac"]
    hr = _cfg["crop_probe_h_trim_right_frac"]
    wfrac = max(0.02, 1.0 - hl - hr)
    return f"crop=iw*{wfrac:.6f}:ih:iw*{hl:.6f}:0"


def _ffmpeg_gray_post_eq_suffix() -> str:
    """Histeq / unsharp / negate suffix cho ffmpeg vf."""
    parts = []
    hs = float(_cfg.get("histeq_strength") or 0.0)
    if hs > 1e-9:
        parts.append(f"histeq=strength={min(1.0, max(0.0, hs)):.6f}")
    us = (_cfg.get("unsharp") or "").strip()
    if us and us.lower() not in ("0", "off", "none", "false"):
        if re.fullmatch(r"[-\d.:]+", us):
            parts.append(f"unsharp={us}")
        else:
            _cfg["log"](f"Step1 EasyOCR: bỏ qua unsharp (ký tự không hợp lệ): {us!r}")
    if _cfg.get("gray_invert"):
        parts.append("negate")
    return ("," + ",".join(parts)) if parts else ""


def _crop_ffmpeg_vf(band_lo: float, band_hi: float) -> str:
    """Dải đáy → crop ngang → preprocess → ffmpeg vf string cho cropped.mp4."""
    lo, hi = float(band_lo), float(band_hi)
    if hi <= lo + 1e-9:
        raise ValueError("EasyOCR crop band: need band_hi > band_lo")
    dh = hi - lo
    y_from_top = 1.0 - hi
    vert = f"crop=iw:ih*{dh:.6f}:0:ih*{y_from_top:.6f}"
    htrim = _h_trim_crop_vf()

    wt = int(_cfg.get("white_thresh") or 0)
    if wt > 0:
        thresh_vf = f"format=gray,lut=y='if(gt(val\\,{max(0, min(254, wt))}),255,0)'"
        return f"{vert},{htrim},{thresh_vf}"

    ls = max(0.0, min(1.0, float(_cfg.get("luma_suppress") or 0.0)))
    if ls > 1e-9:
        y_factor = max(0.0, 1.0 - ls)
        luma_vf = f"format=yuv444p,lutyuv=y='clip(val*{y_factor:.6f}\\,0\\,255)',format=rgb24"
        return f"{vert},{htrim},{luma_vf}"

    c = float(_cfg["gray_contrast"])
    b = float(_cfg["gray_brightness"])
    g = float(_cfg["gray_gamma"])
    post = _ffmpeg_gray_post_eq_suffix()
    return f"{vert},{htrim},format=gray,eq=contrast={c:.6f}:brightness={b:.6f}:gamma={g:.6f}{post}"


def _probe_timestamps_sec(duration_ms, n_frames: int) -> list[float]:
    n = max(1, n_frames)
    if duration_ms and duration_ms > 8000:
        d_sec = duration_ms / 1000.0
        cap = max(0.5, d_sec * 0.95)
        lo_frac, hi_frac = 0.02, 0.90
        if n == 1:
            return [min(max(0.25, d_sec * 0.12), cap)]
        out = []
        for k in range(n):
            frac = lo_frac + (hi_frac - lo_frac) * (k / (n - 1))
            out.append(min(max(0.25, d_sec * frac), cap))
        return out
    fixed = [0.25, 0.5, 0.85, 1.2, 1.8, 2.5, 3.5, 5.0, 6.5, 8.0, 10.0, 12.0, 15.0, 20.0, 28.0, 38.0, 50.0, 65.0]
    return fixed[:n]


def _extract_probe_frames(video_path: Path, out_dir: Path, n_frames: int) -> list[Path]:
    """Lưu PNG probe đã crop ngang."""
    import cv2

    out_dir.mkdir(parents=True, exist_ok=True)
    duration_ms = _cfg["get_media_duration_ms"](video_path)
    times = _probe_timestamps_sec(duration_ms, n_frames)
    probe_vf = _h_trim_crop_vf()
    paths = []
    for i, t in enumerate(times):
        p = out_dir / f"probe_{i:02d}.png"
        _cfg["run_command"](
            [_cfg["ffmpeg_bin"], "-y", "-ss", f"{t:.3f}", "-i", str(video_path),
             "-vf", probe_vf, "-vframes", "1", "-q:v", "2", str(p)],
            f"EasyOCR probe frame {i} @ {t:.2f}s",
        )
        if p.exists() and p.stat().st_size > 0:
            img = cv2.imread(str(p))
            if img is not None and img.size > 0:
                paths.append(p)
            else:
                try:
                    p.unlink(missing_ok=True)
                except TypeError:
                    if p.exists():
                        p.unlink()
    return paths


# ──────────────────────────────────────────────
# Image preprocessing (OpenCV)
# ──────────────────────────────────────────────

def _preprocess_strip(bgr_strip, for_probe: bool = False):
    """
    Preprocess dải ảnh BGR trước EasyOCR.
    for_probe=True: luôn grayscale + eq (chuẩn hóa cho detect bbox).
    for_probe=False: áp white_thresh / luma_suppress / grayscale+eq.
    """
    import cv2
    import numpy as np

    if not for_probe:
        wt = int(_cfg.get("white_thresh") or 0)
        if wt > 0:
            gray_raw = cv2.cvtColor(bgr_strip, cv2.COLOR_BGR2GRAY)
            _, out = cv2.threshold(gray_raw, max(0, min(254, wt)), 255, cv2.THRESH_BINARY)
            return out

        ls = max(0.0, min(1.0, float(_cfg.get("luma_suppress") or 0.0)))
        if ls > 1e-9:
            y_factor = max(0.0, 1.0 - ls)
            ycrcb = cv2.cvtColor(bgr_strip, cv2.COLOR_BGR2YCrCb).astype(np.float32)
            ycrcb[:, :, 0] = np.clip(ycrcb[:, :, 0] * y_factor, 0, 255)
            return cv2.cvtColor(ycrcb.astype(np.uint8), cv2.COLOR_YCrCb2BGR)

    gray = cv2.cvtColor(bgr_strip, cv2.COLOR_BGR2GRAY)
    x = gray.astype(np.float32) / 255.0
    g = max(float(_cfg.get("gray_gamma", 1.2)), 0.01)
    x = np.power(np.clip(x, 0, 1), 1.0 / g) * 255.0
    c = float(_cfg.get("gray_contrast", 2.0))
    b = float(_cfg.get("gray_brightness", -0.15))
    x = (x - 128.0) * c + 128.0 + b * 255.0
    out = np.clip(x, 0, 255).astype(np.uint8)

    hs = float(_cfg.get("histeq_strength") or 0.0)
    if hs > 1e-9:
        eqf = cv2.equalizeHist(out)
        out = cv2.addWeighted(out, 1.0 - hs, eqf, min(1.0, max(0.0, hs)), 0)

    us = (_cfg.get("unsharp") or "").strip()
    if us and us.lower() not in ("0", "off", "none", "false") and re.fullmatch(r"[-\d.:]+", us):
        try:
            parts = [float(p) for p in us.split(":")]
            amt = max(0.05, min(2.5, float(parts[2]) if len(parts) >= 3 else 0.75))
        except (ValueError, IndexError):
            amt = 0.75
        blur = cv2.GaussianBlur(out, (0, 0), sigmaX=1.15)
        out = np.clip(cv2.addWeighted(out, 1.0 + amt, blur, -amt, 0), 0, 255).astype(np.uint8)

    if _cfg.get("gray_invert"):
        out = 255 - out
    return out


# ──────────────────────────────────────────────
# Crop band auto-detect
# ──────────────────────────────────────────────

def _detect_crop_band(video_path: Path, reader, ocr_dir: Path):
    """
    Detect subtitle band (lo, hi) tính từ đáy frame bằng EasyOCR trên probe frames.
    Trả về (lo, hi): 0 = sát đáy, 1 = đỉnh frame.
    """
    import cv2

    hi_max = float(_cfg["subtitle_crop_band_hi"])
    strip_max = float(_cfg.get("max_strip_height_ratio") or 0.05)
    fallback_hi = hi_max
    fallback_lo = max(0.0, fallback_hi - strip_max)

    SCAN_HI = 0.4
    PAD = 0.015
    HI_OUTLIER_MIN = hi_max + 0.05
    lo_floor = 0.0

    log = _cfg["log"]
    log_dir = _cfg["log_dir"]

    probe_dir = ocr_dir / "probe_src"
    shutil.rmtree(probe_dir, ignore_errors=True)
    debug_probe_dir = log_dir / "easyocr_crop_probe"
    shutil.rmtree(debug_probe_dir, ignore_errors=True)
    debug_probe_dir.mkdir(parents=True, exist_ok=True)

    frame_paths = _extract_probe_frames(video_path, probe_dir, _cfg["crop_probe_frames"])
    if not frame_paths:
        shutil.rmtree(debug_probe_dir, ignore_errors=True)
        log(f"Step1 EasyOCR: crop detect — không lấy được frame mẫu, fallback lo={fallback_lo:.3f} hi={fallback_hi:.3f}")
        return fallback_lo, fallback_hi

    all_lo: list[float] = []
    all_hi: list[float] = []
    for fp in frame_paths:
        img = cv2.imread(str(fp))
        try:
            fp.unlink()
        except OSError:
            pass
        if img is None:
            continue
        ih, iw = img.shape[:2]
        if ih < 40 or iw < 40:
            continue
        try:
            cv2.imwrite(str(debug_probe_dir / fp.name), img)
        except Exception:
            pass
        scan_top = int(ih * (1.0 - SCAN_HI))
        scan_strip = img[scan_top:, :]
        gray = _preprocess_strip(scan_strip, for_probe=True)
        try:
            results = reader.readtext(gray, detail=1)
        except Exception:
            continue
        frame_boxes = []
        for item in results:
            if not item or len(item) < 3:
                continue
            box, text, conf = item[0], item[1], item[2]
            conf_f = float(conf)
            text_s = str(text or "").strip()
            if conf_f < float(_cfg["min_confidence"]):
                log(f"Step1 EasyOCR: crop detect [{fp.name}] skip conf={conf_f:.2f} text=\"{text_s[:30]}\"")
                continue
            if not text_s or _should_skip_merged_text(text_s):
                continue
            ys = [float(pt[1]) for pt in box]
            y_top_frame = scan_top + min(ys)
            y_bot_frame = scan_top + max(ys)
            hi_cand = (ih - y_top_frame) / ih
            lo_cand = max(0.0, (ih - y_bot_frame) / ih)
            if hi_cand > HI_OUTLIER_MIN:
                continue
            all_hi.append(hi_cand)
            all_lo.append(lo_cand)
            frame_boxes.append((conf_f, text_s, lo_cand, hi_cand))
        if frame_boxes:
            parts = " | ".join(f"conf={c:.2f} lo={l:.3f} hi={h:.3f} \"{t[:20]}\"" for c, t, l, h in frame_boxes)
            log(f"Step1 EasyOCR: crop detect [{fp.name}] {parts}")

    shutil.rmtree(probe_dir, ignore_errors=True)

    if not all_hi:
        log(f"Step1 EasyOCR: crop detect — không tìm thấy text, fallback lo={fallback_lo:.3f} hi={fallback_hi:.3f}")
        return fallback_lo, fallback_hi

    n = len(all_hi)
    all_hi_s = sorted(all_hi)
    all_lo_s = sorted(all_lo)
    det_hi = min(1.0, all_hi_s[min(n - 1, int(n * 0.95))] + PAD)
    det_lo = max(lo_floor, all_lo_s[max(0, int(n * 0.05))] - PAD)
    log(
        f"Step1 EasyOCR: crop detect dist "
        f"hi=[{all_hi_s[0]:.3f}…{all_hi_s[-1]:.3f}] p95={all_hi_s[min(n-1,int(n*0.95))]:.3f} "
        f"lo=[{all_lo_s[0]:.3f}…{all_lo_s[-1]:.3f}] p5={all_lo_s[max(0,int(n*0.05))]:.3f} n={n}"
    )
    if strip_max > 0:
        det_lo = max(lo_floor, det_hi - strip_max)
    if det_hi <= det_lo + 1e-9:
        log(f"Step1 EasyOCR: crop detect — dải không hợp lệ, fallback lo={fallback_lo:.3f} hi={fallback_hi:.3f}")
        return fallback_lo, fallback_hi
    log(f"Step1 EasyOCR: crop detect lo={det_lo:.3f} hi={det_hi:.3f} strip_pct={(det_hi - det_lo) * 100:.1f} n_boxes={n}")
    return det_lo, det_hi


# ──────────────────────────────────────────────
# Reading order sort
# ──────────────────────────────────────────────

def _readtext_sort_for_join(results):
    """Sort EasyOCR bboxes: same row left→right, rows top→bottom."""
    if not results:
        return results

    def key_fn(item):
        bbox = item[0]
        ys = [float(p[1]) for p in bbox]
        xs = [float(p[0]) for p in bbox]
        my = sum(ys) / max(len(ys), 1)
        return (int(my // 12), min(xs))

    return sorted(results, key=key_fn)


# ──────────────────────────────────────────────
# Main OCR pipeline
# ──────────────────────────────────────────────

def _ocr_with_easyocr(video_path: Path) -> Path:
    """Step1: extract subtitles via EasyOCR on the cropped subtitle region."""
    import concurrent.futures

    log = _cfg["log"]
    log("Step1: OCR (EasyOCR)…")

    try:
        import easyocr
    except ImportError:
        raise RuntimeError("easyocr chưa được cài đặt. Run: pip install easyocr opencv-python-headless")

    ocr_dir = _cfg["log_dir"] / "step1_ocr"
    frames_dir = ocr_dir / "frames"
    shutil.rmtree(ocr_dir, ignore_errors=True)
    ocr_dir.mkdir(parents=True, exist_ok=True)

    reader = easyocr.Reader(_cfg["lang"], gpu=_cfg["gpu"])
    log(
        f"Step1 EasyOCR: gray eq contrast={_cfg['gray_contrast']:.3f} "
        f"brightness={_cfg['gray_brightness']:.3f} gamma={_cfg['gray_gamma']:.3f}"
    )

    band_lo, band_hi = _detect_crop_band(video_path, reader, ocr_dir)
    if band_hi <= band_lo + 1e-9:
        raise RuntimeError(f"Step1 EasyOCR: invalid crop band lo={band_lo} hi={band_hi}")

    log(f"Step1 EasyOCR: crop apply lo={band_lo:.3f} hi={band_hi:.3f} strip_pct={(band_hi - band_lo) * 100:.1f}")

    frames_dir.mkdir(parents=True, exist_ok=True)

    # 1. Crop + preprocess subtitle region → cropped.mp4
    crop_video = ocr_dir / "cropped.mp4"
    _cfg["run_command"](
        [_cfg["ffmpeg_bin"], "-y", "-i", str(video_path),
         "-vf", _crop_ffmpeg_vf(band_lo, band_hi),
         "-an", "-c:v", "libx264", "-crf", "23", "-preset", "ultrafast", str(crop_video)],
        "EasyOCR: crop subtitle region",
    )

    # 2. Extract frames at target FPS
    _cfg["run_command"](
        [_cfg["ffmpeg_bin"], "-y", "-i", str(crop_video),
         "-vf", f"fps={_cfg['fps']}", str(frames_dir / "frame_%05d.png")],
        "EasyOCR: extract frames",
    )

    frame_files = sorted(frames_dir.glob("frame_*.png"))
    if not frame_files:
        raise RuntimeError("Step1 EasyOCR: no frames extracted.")

    # 3. OCR (parallel ThreadPoolExecutor)
    frame_interval_sec = 1.0 / _cfg["fps"]
    min_conf = _cfg["min_confidence"]
    low_floor = _cfg["low_conf_floor"]

    def _serialize_boxes(results):
        return [
            {"bbox": [[float(p[0]), float(p[1])] for p in item[0]] if item[0] else [],
             "text": item[1], "confidence": float(item[2])}
            for item in (results or [])
        ]

    def ocr_frame(idx_path):
        idx, fpath = idx_path
        timestamp_sec = idx * frame_interval_sec
        debug_row = {
            "frame_index": idx, "frame_png": fpath.name,
            "timestamp_sec": timestamp_sec,
            "easyocr_min_confidence": min_conf,
            "raw_readtext_order": [], "sorted_reading_order": [],
            "joined_after_filter": "", "error": None,
        }
        try:
            results = reader.readtext(str(fpath), detail=1)
            debug_row["raw_readtext_order"] = _serialize_boxes(results)
            sorted_results = _readtext_sort_for_join(results)
            debug_row["sorted_reading_order"] = _serialize_boxes(sorted_results)
            texts = [t.strip() for _b, t, conf in sorted_results if conf >= min_conf and t.strip()]
            joined = " ".join(texts)
            debug_row["joined_after_filter"] = joined
            low_texts = [t.strip() for _b, t, conf in sorted_results if low_floor <= conf < min_conf and t.strip()]
            return timestamp_sec, joined, " ".join(low_texts), debug_row
        except Exception as exc:
            debug_row["error"] = str(exc)
            return timestamp_sec, "", "", debug_row

    raw_results: list = []
    low_conf_candidates: list = []
    debug_rows: list = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=_cfg["workers"]) as pool:
        indexed = list(enumerate(frame_files))
        futures = {pool.submit(ocr_frame, item): item[0] for item in indexed}
        for fut in _cfg["progressbar"](
            concurrent.futures.as_completed(futures), total=len(futures), desc="EasyOCR frames"
        ):
            ts, text, low_text, dbg = fut.result()
            debug_rows.append(dbg)
            if text:
                raw_results.append((ts, text))
            elif low_text:
                low_conf_candidates.append((ts, low_text))

    # Low-confidence rescue (cluster voting)
    bridge_frames = _cfg["bridge_frames"]
    bridge_min = _cfg["bridge_min_match"]
    fuzzy_thr = _cfg["fuzzy_threshold"]
    if low_conf_candidates and bridge_min > 0:
        all_cands = sorted(raw_results + low_conf_candidates, key=lambda x: x[0])
        rescued = 0
        for ts, text in low_conf_candidates:
            window = bridge_frames * frame_interval_sec
            neighbors = [tx for t, tx in all_cands if abs(t - ts) <= window and t != ts]
            matches = sum(1 for tx in neighbors if same_subtitle_line(text, tx, fuzzy_thr))
            if matches >= bridge_min:
                raw_results.append((ts, text))
                rescued += 1
        if rescued:
            log(f"Step1 EasyOCR: rescued {rescued} low-confidence frame(s) via cluster voting.")

    raw_results.sort(key=lambda x: x[0])
    debug_rows.sort(key=lambda r: r["frame_index"])
    ocr_debug_path = ocr_dir / "frame_ocr_raw.jsonl"
    with open(ocr_debug_path, "w", encoding="utf8") as _df:
        for row in debug_rows:
            _df.write(json.dumps(row, ensure_ascii=False) + "\n")
    log(f"Step1 EasyOCR: debug log → {ocr_debug_path} ({len(debug_rows)} frames)")

    # 4. Text cleaning (uses shared normalize module)
    cleaned = [(ts, clean_text(t)) for ts, t in raw_results]
    cleaned = [(ts, t) for ts, t in cleaned if t]
    if not cleaned:
        raise RuntimeError("Step1 EasyOCR: no text survived cleaning.")

    # 5. Group + dedup
    merge_gap_ms = _cfg["merge_gap_ms"]
    groups: list = []
    for ts, text in cleaned:
        if groups and same_subtitle_line(groups[-1][2], text, fuzzy_thr):
            groups[-1][1] = ts + frame_interval_sec
            if len(text) > len(groups[-1][2]):
                groups[-1][2] = text
        else:
            groups.append([ts, ts + frame_interval_sec, text])

    merged: list = []
    for block in groups:
        if merged and same_subtitle_line(merged[-1][2], block[2], fuzzy_thr) and (block[0] - merged[-1][1]) * 1000 <= merge_gap_ms:
            merged[-1][1] = block[1]
            if len(block[2]) > len(merged[-1][2]):
                merged[-1][2] = block[2]
        else:
            merged.append(list(block))

    if not merged:
        raise RuntimeError("Step1 EasyOCR: no subtitle groups after dedup.")

    kept = []
    skipped = 0
    for start, end, text in merged:
        if should_skip_text(text, _SKIP_COMPILED):
            skipped += 1
        else:
            kept.append((start, end, text))
    if skipped:
        log(f"Step1 EasyOCR: skipped {skipped} block(s) (regex skip filter)")
    if not kept:
        raise RuntimeError("Step1 EasyOCR: all subtitle blocks removed by regex skip filter.")

    # 6. Export SRT
    min_dur = _cfg["min_duration_ms"]
    fmt_time = _cfg["fmt_time"]
    srt_path = _cfg["get_zh_srt_path"]()
    with open(srt_path, "w", encoding="utf8") as f:
        for i, (start, end, text) in enumerate(kept, 1):
            if (end - start) * 1000 < min_dur:
                end = start + min_dur / 1000.0
            f.write(f"{i}\n{fmt_time(start)} --> {fmt_time(end)}\n{text}\n\n")
    log(f"Step1 EasyOCR: done — {len(kept)} blocks → {srt_path}")
    return srt_path
