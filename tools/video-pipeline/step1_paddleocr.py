"""
Step 1 – PaddleOCR engine: visual subtitle extraction using PP-OCRv6 with Frame Difference
frame selection (chỉ OCR khi subtitle thực sự thay đổi).

Usage:
    from step1_paddleocr import configure_step1_paddleocr, run as paddleocr_run

    configure_step1_paddleocr(
        log=log, ffmpeg_bin=FFMPEG_BIN, get_media_duration_ms=get_media_duration_ms,
        fmt_time=fmt_time, get_zh_srt_path=get_zh_srt_path, log_dir=LOG_DIR,
        lang=PADDLEOCR_LANG, use_gpu=PADDLEOCR_USE_GPU, ...
    )
    srt_path = paddleocr_run(video_path)
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any, Callable

_cfg: dict[str, Any] = {}
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

def configure_step1_paddleocr(
    *,
    log: Callable[[str], None],
    run_command: Callable,
    ffmpeg_bin: str,
    get_media_duration_ms: Callable,
    fmt_time: Callable,
    get_zh_srt_path: Callable[[], Path],
    log_dir: Path,
    # OCR engine
    lang: str,
    use_gpu: bool,
    use_angle_cls: bool,
    # Crop band / geometry
    subtitle_crop_band_hi: float,
    crop_probe_frames: int,
    crop_probe_h_trim_left_frac: float,
    crop_probe_h_trim_right_frac: float,
    max_strip_height_ratio: float,
    # Frame Difference (Module 1)
    scan_fps: float,
    framediff_threshold: float,
    framediff_skip_blank: bool,
    # Batch inference
    batch_size: int,
    # Confidence / rescue
    min_confidence: float,
    low_conf_floor: float,
    bridge_frames: int,
    bridge_min_match: int,
    # Dedup / merge
    fuzzy_threshold: float,
    merge_gap_ms: int,
    min_duration_ms: int,
    # Preprocessing
    gray_contrast: float,
    gray_brightness: float,
    gray_gamma: float,
    luma_suppress: float,
    white_thresh: int,
    histeq_strength: float,
    gray_invert: bool,
    unsharp: str,
) -> None:
    """Populate module config. Call before run()."""
    _cfg.clear()
    _cfg.update(
        log=log,
        run_command=run_command,
        ffmpeg_bin=str(ffmpeg_bin),
        get_media_duration_ms=get_media_duration_ms,
        fmt_time=fmt_time,
        get_zh_srt_path=get_zh_srt_path,
        log_dir=Path(log_dir),
        lang=str(lang),
        use_gpu=bool(use_gpu),
        use_angle_cls=bool(use_angle_cls),
        subtitle_crop_band_hi=float(subtitle_crop_band_hi),
        crop_probe_frames=max(1, int(crop_probe_frames)),
        crop_probe_h_trim_left_frac=max(0.0, min(0.49, float(crop_probe_h_trim_left_frac))),
        crop_probe_h_trim_right_frac=max(0.0, min(0.49, float(crop_probe_h_trim_right_frac))),
        max_strip_height_ratio=float(max_strip_height_ratio),
        scan_fps=max(0.1, float(scan_fps)),
        framediff_threshold=float(framediff_threshold),
        framediff_skip_blank=bool(framediff_skip_blank),
        batch_size=max(1, int(batch_size)),
        min_confidence=float(min_confidence),
        low_conf_floor=float(low_conf_floor),
        bridge_frames=max(0, int(bridge_frames)),
        bridge_min_match=max(1, int(bridge_min_match)),
        fuzzy_threshold=float(fuzzy_threshold),
        merge_gap_ms=int(merge_gap_ms),
        min_duration_ms=max(1, int(min_duration_ms)),
        gray_contrast=float(gray_contrast),
        gray_brightness=float(gray_brightness),
        gray_gamma=float(gray_gamma),
        luma_suppress=float(luma_suppress),
        white_thresh=int(white_thresh),
        histeq_strength=float(histeq_strength),
        gray_invert=bool(gray_invert),
        unsharp=str(unsharp or ""),
    )
    _rebuild_skip_regexes()


def run(video_path: Path) -> Path:
    """Run PaddleOCR subtitle extraction. Returns path to generated .zh.srt file."""
    return _ocr_with_paddleocr(video_path)


# ──────────────────────────────────────────────
# Skip-regex helpers
# ──────────────────────────────────────────────

def _rebuild_skip_regexes() -> None:
    global _SKIP_COMPILED
    compiled = []
    for p in BUILTIN_SKIP_REGEXES:
        try:
            compiled.append(re.compile(p))
        except re.error:
            pass
    _SKIP_COMPILED = compiled


def _should_skip_merged_text(text: str) -> bool:
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
# Image preprocessing (OpenCV)
# ──────────────────────────────────────────────

def _preprocess_strip(bgr_strip, for_probe: bool = False):
    """
    Preprocess dải ảnh BGR trước PaddleOCR.
    for_probe=True: luôn grayscale + eq (chuẩn hóa vị trí bbox).
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
# Geometry / probe helpers
# ──────────────────────────────────────────────

def _h_trim_crop_vf() -> str:
    hl = _cfg["crop_probe_h_trim_left_frac"]
    hr = _cfg["crop_probe_h_trim_right_frac"]
    wfrac = max(0.02, 1.0 - hl - hr)
    return f"crop=iw*{wfrac:.6f}:ih:iw*{hl:.6f}:0"


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
    """Lưu PNG probe frames crop ngang."""
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
             "-vf", probe_vf, "-frames:v", "1", "-q:v", "2", str(p)],
            f"PaddleOCR probe frame {i} @ {t:.2f}s",
        )
        if p.exists() and p.stat().st_size > 0:
            img = cv2.imread(str(p))
            if img is not None and img.size > 0:
                paths.append(p)
            else:
                if p.exists():
                    p.unlink()
    return paths


def _crop_band_bgr(img_bgr, band_lo: float, band_hi: float):
    """Cắt dải dọc [band_lo, band_hi] từ đáy frame."""
    ih, iw = img_bgr.shape[:2]
    if ih < 4 or iw < 4:
        return None
    lo, hi = float(band_lo), float(band_hi)
    if hi <= lo + 1e-9 or hi > 1.0 + 1e-9:
        return None
    h = max(1, int(round(ih * (hi - lo))))
    top = max(0, ih - int(round(ih * hi)))
    if h < 2 or top >= ih:
        return None
    return img_bgr[top: top + h, :]


def _parse_line(item):
    """PaddleOCR 3.x: [[pt,...], (text, conf)] → (bbox, text, conf)."""
    bbox = item[0]
    rec = item[1]
    text = str(rec[0]) if rec else ""
    conf = float(rec[1]) if rec and len(rec) > 1 else 0.0
    return bbox, text, conf


def _readtext_sort_for_join(lines):
    """Sort PaddleOCR lines: same row left→right, rows top→bottom."""
    if not lines:
        return lines

    def key_fn(item):
        bbox = item[0]
        ys = [float(p[1]) for p in bbox]
        xs = [float(p[0]) for p in bbox]
        my = sum(ys) / max(len(ys), 1)
        return (int(my // 12), min(xs))

    return sorted(lines, key=key_fn)


# ──────────────────────────────────────────────
# Crop band auto-detect
# ──────────────────────────────────────────────

def _detect_crop_band(video_path: Path, ocr, ocr_dir: Path):
    """Detect subtitle band (lo, hi) tính từ đáy frame bằng PaddleOCR probe frames."""
    import cv2

    log = _cfg["log"]
    log_dir = _cfg["log_dir"]
    hi_max = float(_cfg["subtitle_crop_band_hi"])
    strip_max = float(_cfg.get("max_strip_height_ratio") or 0.05)
    fallback_hi = hi_max
    fallback_lo = max(0.0, fallback_hi - strip_max)

    SCAN_HI = 0.4
    PAD = 0.015
    HI_OUTLIER_MIN = hi_max + 0.05
    lo_floor = 0.0

    probe_dir = ocr_dir / "probe_src"
    shutil.rmtree(probe_dir, ignore_errors=True)
    debug_probe_dir = log_dir / "paddleocr_crop_probe"
    shutil.rmtree(debug_probe_dir, ignore_errors=True)
    debug_probe_dir.mkdir(parents=True, exist_ok=True)

    frame_paths = _extract_probe_frames(video_path, probe_dir, _cfg["crop_probe_frames"])
    if not frame_paths:
        shutil.rmtree(debug_probe_dir, ignore_errors=True)
        log(f"Step1 PaddleOCR: crop detect — không lấy được frame mẫu, fallback lo={fallback_lo:.3f} hi={fallback_hi:.3f}")
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
            result = ocr.ocr(gray, cls=True)
            lines = result[0] if result and result[0] else []
        except Exception:
            continue
        frame_boxes = []
        for item in lines:
            if not item or len(item) < 2:
                continue
            bbox, text_s, conf_f = _parse_line(item)
            text_s = text_s.strip()
            if conf_f < float(_cfg["min_confidence"]) or not text_s or _should_skip_merged_text(text_s):
                continue
            ys = [float(pt[1]) for pt in bbox]
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
            log(f"Step1 PaddleOCR: crop detect [{fp.name}] {parts}")

    shutil.rmtree(probe_dir, ignore_errors=True)

    if not all_hi:
        log(f"Step1 PaddleOCR: crop detect — không tìm thấy text, fallback lo={fallback_lo:.3f} hi={fallback_hi:.3f}")
        return fallback_lo, fallback_hi

    n = len(all_hi)
    all_hi_s = sorted(all_hi)
    all_lo_s = sorted(all_lo)
    det_hi = min(1.0, all_hi_s[min(n - 1, int(n * 0.95))] + PAD)
    det_lo = max(lo_floor, all_lo_s[max(0, int(n * 0.05))] - PAD)
    log(
        f"Step1 PaddleOCR: crop detect dist "
        f"hi=[{all_hi_s[0]:.3f}…{all_hi_s[-1]:.3f}] p95={all_hi_s[min(n-1,int(n*0.95))]:.3f} "
        f"lo=[{all_lo_s[0]:.3f}…{all_lo_s[-1]:.3f}] p5={all_lo_s[max(0,int(n*0.05))]:.3f} n={n}"
    )
    if strip_max > 0:
        det_lo = max(lo_floor, det_hi - strip_max)
    if det_hi <= det_lo + 1e-9:
        log(f"Step1 PaddleOCR: crop detect — dải không hợp lệ, fallback lo={fallback_lo:.3f} hi={fallback_hi:.3f}")
        return fallback_lo, fallback_hi
    log(f"Step1 PaddleOCR: crop detect lo={det_lo:.3f} hi={det_hi:.3f} strip_pct={(det_hi - det_lo) * 100:.1f} n_boxes={n}")
    return det_lo, det_hi


# ──────────────────────────────────────────────
# Module 1: Frame Difference frame selector
# ──────────────────────────────────────────────

def _select_change_frames(video_path: Path, band_lo: float, band_hi: float) -> list:
    """
    Scan video bằng cv2.VideoCapture tại scan_fps.
    Trả về list[(timestamp_sec, strip_preprocessed)] chỉ tại các frame có subtitle thay đổi.
    Không tạo file trung gian.
    """
    import cv2
    import numpy as np

    log = _cfg["log"]
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"PaddleOCR frame diff: không mở được video {video_path}")

    native_fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    scan_fps = _cfg["scan_fps"]
    scan_step = max(1, int(round(native_fps / scan_fps)))
    threshold = _cfg["framediff_threshold"]
    skip_blank = _cfg["framediff_skip_blank"]
    hl = _cfg["crop_probe_h_trim_left_frac"]
    hr = _cfg["crop_probe_h_trim_right_frac"]

    prev_gray = None
    change_frames: list = []
    frame_idx = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if frame_idx % scan_step == 0:
            strip = _crop_band_bgr(frame, band_lo, band_hi)
            if strip is None or strip.size == 0:
                frame_idx += 1
                continue
            # Horizontal trim
            ih, iw = strip.shape[:2]
            x0 = int(iw * hl)
            x1 = iw - int(iw * hr)
            if x1 > x0 + 2:
                strip = strip[:, x0:x1]
            # Preprocess for diff (grayscale)
            gray = _preprocess_strip(strip, for_probe=True)
            # Skip blank frames
            if skip_blank and float(np.mean(gray)) < 5:
                prev_gray = gray
                frame_idx += 1
                continue
            if prev_gray is not None:
                mad = (
                    float(np.mean(np.abs(gray.astype(np.float32) - prev_gray.astype(np.float32))))
                    if gray.shape == prev_gray.shape
                    else threshold + 1.0
                )
                if mad >= threshold:
                    ocr_strip = _preprocess_strip(strip, for_probe=False)
                    change_frames.append((frame_idx / native_fps, ocr_strip))
            else:
                ocr_strip = _preprocess_strip(strip, for_probe=False)
                change_frames.append((frame_idx / native_fps, ocr_strip))
            prev_gray = gray
        frame_idx += 1

    cap.release()
    log(
        f"Step1 PaddleOCR: frame diff — {frame_idx} frames read, "
        f"{len(change_frames)} change frames (scan_step={scan_step}, "
        f"native_fps={native_fps:.2f}, threshold={threshold})"
    )
    return change_frames


# ──────────────────────────────────────────────
# Main OCR pipeline
# ──────────────────────────────────────────────

def _ocr_with_paddleocr(video_path: Path) -> Path:
    """Step1: extract subtitles via PaddleOCR + Frame Difference frame selection."""
    from difflib import SequenceMatcher

    log = _cfg["log"]
    log("Step1: OCR (PaddleOCR)…")

    try:
        from paddleocr import PaddleOCR
    except ImportError:
        raise RuntimeError(
            "paddleocr chưa được cài đặt.\n"
            "  GPU: pip install paddlepaddle-gpu paddleocr\n"
            "  CPU: pip install paddlepaddle paddleocr"
        )

    ocr_dir = _cfg["log_dir"] / "step1_paddleocr"
    shutil.rmtree(ocr_dir, ignore_errors=True)
    ocr_dir.mkdir(parents=True, exist_ok=True)

    ocr = PaddleOCR(
        lang=_cfg["lang"],
        use_gpu=_cfg["use_gpu"],
        use_angle_cls=_cfg["use_angle_cls"],
        show_log=False,
    )
    log(f"Step1 PaddleOCR: init lang={_cfg['lang']} gpu={_cfg['use_gpu']} angle_cls={_cfg['use_angle_cls']}")

    # 1. Auto-detect subtitle crop band
    band_lo, band_hi = _detect_crop_band(video_path, ocr, ocr_dir)
    if band_hi <= band_lo + 1e-9:
        raise RuntimeError(f"Step1 PaddleOCR: invalid crop band lo={band_lo} hi={band_hi}")
    log(f"Step1 PaddleOCR: crop band lo={band_lo:.3f} hi={band_hi:.3f} strip_pct={(band_hi - band_lo) * 100:.1f}")

    # 2. Module 1: Frame Difference – chỉ lấy frame có subtitle thay đổi
    change_frames = _select_change_frames(video_path, band_lo, band_hi)
    if not change_frames:
        raise RuntimeError("Step1 PaddleOCR: Frame Difference không tìm được frame thay đổi nào.")

    # 3. Module 2: Batch OCR
    batch_size = _cfg["batch_size"]
    frame_interval_sec = 1.0 / _cfg["scan_fps"]
    min_conf = _cfg["min_confidence"]
    low_floor = _cfg["low_conf_floor"]
    use_angle_cls = _cfg["use_angle_cls"]

    def _ocr_strip(ts, strip):
        try:
            result = ocr.ocr(strip, cls=use_angle_cls)
            lines = result[0] if result and result[0] else []
        except Exception as exc:
            return ts, "", "", {"timestamp_sec": ts, "error": str(exc), "lines": []}
        sorted_lines = _readtext_sort_for_join(lines)
        high_texts, low_texts = [], []
        dbg_lines = []
        for item in sorted_lines:
            if not item or len(item) < 2:
                continue
            bbox, text_s, conf_f = _parse_line(item)
            text_s = text_s.strip()
            dbg_lines.append({"text": text_s, "conf": conf_f})
            if not text_s:
                continue
            if conf_f >= min_conf:
                high_texts.append(text_s)
            elif conf_f >= low_floor:
                low_texts.append(text_s)
        joined = " ".join(high_texts)
        dbg = {"timestamp_sec": ts, "error": None, "lines": dbg_lines, "joined": joined}
        return ts, joined, " ".join(low_texts), dbg

    raw_results: list = []
    low_conf_candidates: list = []
    debug_rows: list = []

    for i in range(0, len(change_frames), batch_size):
        batch = change_frames[i: i + batch_size]
        for ts, strip in batch:
            ts_r, joined, low_joined, dbg = _ocr_strip(ts, strip)
            debug_rows.append(dbg)
            if joined:
                raw_results.append((ts_r, joined))
            elif low_joined:
                low_conf_candidates.append((ts_r, low_joined))

    log(f"Step1 PaddleOCR: OCR done — {len(raw_results)} high-conf, {len(low_conf_candidates)} low-conf candidates")

    # 4. Low-confidence rescue (cluster voting)
    fuzzy_thr = _cfg["fuzzy_threshold"]
    bridge_frames = _cfg["bridge_frames"]
    bridge_min = _cfg["bridge_min_match"]
    if low_conf_candidates and bridge_min > 0:
        all_cands = sorted(raw_results + low_conf_candidates, key=lambda x: x[0])
        rescued = 0
        for ts, text in low_conf_candidates:
            window = bridge_frames * frame_interval_sec
            neighbors = [tx for t, tx in all_cands if abs(t - ts) <= window and t != ts]
            if sum(1 for tx in neighbors if SequenceMatcher(None, text, tx).ratio() * 100 >= fuzzy_thr) >= bridge_min:
                raw_results.append((ts, text))
                rescued += 1
        if rescued:
            log(f"Step1 PaddleOCR: rescued {rescued} low-confidence frame(s) via cluster voting.")

    raw_results.sort(key=lambda x: x[0])

    # Debug log
    ocr_debug_path = ocr_dir / "frame_ocr_raw.jsonl"
    with open(ocr_debug_path, "w", encoding="utf8") as _df:
        for row in sorted(debug_rows, key=lambda r: r["timestamp_sec"]):
            _df.write(json.dumps(row, ensure_ascii=False) + "\n")
    log(f"Step1 PaddleOCR: debug log → {ocr_debug_path} ({len(debug_rows)} frames)")

    # 5. Text cleaning
    _re_keep = re.compile(r"[\w\s\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+")

    def clean_text(t):
        return re.sub(r"\s+", " ", " ".join(_re_keep.findall(t))).strip()

    def same_subtitle_line(prev: str, curr: str) -> bool:
        from collections import Counter
        if SequenceMatcher(None, prev, curr).ratio() * 100 >= fuzzy_thr:
            return True
        a, b = prev.strip(), curr.strip()
        if len(a) < 2 or len(b) < 2:
            return False
        if a.startswith(b) or b.startswith(a):
            return True
        shorter, longer = (a, b) if len(a) <= len(b) else (b, a)
        if len(shorter) >= 4 and shorter in longer:
            return True
        maxlen = max(len(a), len(b), 1)
        if maxlen >= 8 and abs(len(a) - len(b)) <= 2:
            if sum((Counter(a) & Counter(b)).values()) / float(maxlen) >= 0.88:
                return True
        return False

    cleaned = [(ts, clean_text(t)) for ts, t in raw_results]
    cleaned = [(ts, t) for ts, t in cleaned if t]
    if not cleaned:
        raise RuntimeError("Step1 PaddleOCR: không có text nào sau cleaning.")

    # 6. Group + dedup
    merge_gap_ms = _cfg["merge_gap_ms"]
    groups: list = []
    for ts, text in cleaned:
        if groups and same_subtitle_line(groups[-1][2], text):
            groups[-1][1] = ts + frame_interval_sec
            if len(text) > len(groups[-1][2]):
                groups[-1][2] = text
        else:
            groups.append([ts, ts + frame_interval_sec, text])

    merged: list = []
    for block in groups:
        if merged and same_subtitle_line(merged[-1][2], block[2]) and (block[0] - merged[-1][1]) * 1000 <= merge_gap_ms:
            merged[-1][1] = block[1]
            if len(block[2]) > len(merged[-1][2]):
                merged[-1][2] = block[2]
        else:
            merged.append(list(block))

    if not merged:
        raise RuntimeError("Step1 PaddleOCR: không có subtitle group nào sau dedup.")

    kept = []
    skipped = 0
    for start, end, text in merged:
        if _should_skip_merged_text(text):
            skipped += 1
        else:
            kept.append((start, end, text))
    if skipped:
        log(f"Step1 PaddleOCR: skipped {skipped} block(s) (regex skip filter)")
    if not kept:
        raise RuntimeError("Step1 PaddleOCR: tất cả block bị lọc bởi regex skip filter.")

    # 7. Export SRT
    min_dur = _cfg["min_duration_ms"]
    fmt_time = _cfg["fmt_time"]
    srt_path = _cfg["get_zh_srt_path"]()
    with open(srt_path, "w", encoding="utf8") as f:
        for i, (start, end, text) in enumerate(kept, 1):
            if (end - start) * 1000 < min_dur:
                end = start + min_dur / 1000.0
            f.write(f"{i}\n{fmt_time(start)} --> {fmt_time(end)}\n{text}\n\n")
    log(f"Step1 PaddleOCR: done — {len(kept)} blocks → {srt_path}")
    return srt_path
