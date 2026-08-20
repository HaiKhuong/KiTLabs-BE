"""
Step 1 – PaddleOCR engine: visual subtitle extraction.

Flow:
  1) probe PNG → auto-detect crop band
  2) probe native FPS → extract @ min(scan_fps, native)
  3) OpenCV light detector (appear/same/change/blank) → start/end có ngắt
  4) PaddleOCR chỉ khi appear/change → clean / merge → noise filter → .zh.srt

Usage:
    from step1_paddleocr import configure_step1_paddleocr, run as paddleocr_run
    configure_step1_paddleocr(...)
    srt_path = paddleocr_run(video_path)
"""

from __future__ import annotations

import contextlib
import json
import re
import shutil
import time
from pathlib import Path
from typing import Any, Callable

from subtitle.visual_ocr_gate import (
    annotate_opencv_debug,
    build_cues_from_opencv,
    cues_from_shells_and_ocr,
    finalize_gated_cues,
    merge_cue_shells_by_mask,
    rescue_low_conf_gated,
    resolve_extract_fps,
    write_gated_debug_jsonl,
    write_srt_cues,
)
from subtitle.watermark import should_skip_text

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
    progressbar: Callable,
    get_media_duration_ms: Callable,
    fmt_time: Callable,
    get_zh_srt_path: Callable[[], Path],
    log_dir: Path,
    # OCR engine
    lang: str,
    use_gpu: bool,
    use_angle_cls: bool,
    workers: int,
    # Crop band / geometry
    subtitle_crop_band_hi: float,
    crop_probe_frames: int,
    crop_probe_h_trim_left_frac: float,
    crop_probe_h_trim_right_frac: float,
    max_strip_height_ratio: float,
    # Sampling — target max; runtime clamp to native FPS
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
    # OpenCV text-change gate
    framediff_threshold: float = 8.0,
    framediff_skip_blank: bool = True,
    ink_change_threshold: float = 0.15,
    change_confirm_frames: int = 2,
    mask_merge_iou: float = 0.72,
    workers_max: int = 6,
    # Noise filter (drop short cues; 0 = disable drop)
    noise_min_duration_ms: int = 150,
) -> None:
    """Populate module config. Call before run()."""
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
        lang=str(lang),
        use_gpu=bool(use_gpu),
        use_angle_cls=bool(use_angle_cls),
        workers=max(1, int(workers)),
        subtitle_crop_band_hi=float(subtitle_crop_band_hi),
        crop_probe_frames=max(1, int(crop_probe_frames)),
        crop_probe_h_trim_left_frac=max(0.0, min(0.49, float(crop_probe_h_trim_left_frac))),
        crop_probe_h_trim_right_frac=max(0.0, min(0.49, float(crop_probe_h_trim_right_frac))),
        max_strip_height_ratio=float(max_strip_height_ratio),
        fps=max(0.1, float(fps)),
        min_duration_ms=max(0, int(min_duration_ms)),
        framediff_threshold=max(0.0, float(framediff_threshold)),
        framediff_skip_blank=bool(framediff_skip_blank),
        ink_change_threshold=max(0.0, float(ink_change_threshold)),
        change_confirm_frames=max(1, int(change_confirm_frames)),
        mask_merge_iou=max(0.0, min(1.0, float(mask_merge_iou))),
        workers_max=max(1, int(workers_max)),
        noise_min_duration_ms=max(0, int(noise_min_duration_ms)),
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
    return should_skip_text(text, _SKIP_COMPILED)


# ──────────────────────────────────────────────
# Geometry / ffmpeg helpers (identical to EasyOCR)
# ──────────────────────────────────────────────

def _h_trim_crop_vf() -> str:
    hl = _cfg["crop_probe_h_trim_left_frac"]
    hr = _cfg["crop_probe_h_trim_right_frac"]
    wfrac = max(0.02, 1.0 - hl - hr)
    return f"crop=iw*{wfrac:.6f}:ih:iw*{hl:.6f}:0"


def _ffmpeg_gray_post_eq_suffix() -> str:
    parts = []
    hs = float(_cfg.get("histeq_strength") or 0.0)
    if hs > 1e-9:
        parts.append(f"histeq=strength={min(1.0, max(0.0, hs)):.6f}")
    us = (_cfg.get("unsharp") or "").strip()
    if us and us.lower() not in ("0", "off", "none", "false"):
        if re.fullmatch(r"[-\d.:]+", us):
            parts.append(f"unsharp={us}")
        else:
            _cfg["log"](f"Step1 PaddleOCR: bỏ qua unsharp (ký tự không hợp lệ): {us!r}")
    if _cfg.get("gray_invert"):
        parts.append("negate")
    return ("," + ",".join(parts)) if parts else ""


def _crop_ffmpeg_vf(band_lo: float, band_hi: float) -> str:
    """Dải đáy → crop ngang → preprocess → ffmpeg vf string cho cropped.mp4."""
    lo, hi = float(band_lo), float(band_hi)
    if hi <= lo + 1e-9:
        raise ValueError("PaddleOCR crop band: need band_hi > band_lo")
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
    """Lưu PNG probe đã crop ngang (giống EasyOCR)."""
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
            f"PaddleOCR probe frame {i} @ {t:.2f}s",
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
# Image preprocessing (OpenCV) — giống EasyOCR
# ──────────────────────────────────────────────

def _preprocess_strip(bgr_strip, for_probe: bool = False):
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
# PaddleOCR helpers (engine-only difference)
# ──────────────────────────────────────────────

def _disable_paddle_onednn() -> None:
    """PaddlePaddle 3.3.x + oneDNN/MKLDNN crashes on CPU OCR (ConvertPirAttribute2RuntimeAttribute)."""
    import os

    # Must be set before predictor create; PaddleX still needs enable_mkldnn=False too.
    os.environ.setdefault("FLAGS_use_mkldnn", "0")
    os.environ.setdefault("FLAGS_onednn", "0")
    os.environ.setdefault("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT", "0")


def _quiet_paddle_loggers() -> None:
    """Lower Paddle/PaddleX chatter (model cache, download hints) on stderr."""
    import logging
    import warnings

    warnings.filterwarnings("ignore", message=r".*No ccache found.*")
    warnings.filterwarnings("ignore", message=r".*ccache.*")
    for logger_name in ("paddlex", "paddle", "paddleocr", "ppocr", "urllib3", "huggingface_hub"):
        logging.getLogger(logger_name).setLevel(logging.ERROR)


@contextlib.contextmanager
def _suppress_paddle_stderr():
    """Mute fd=2 spam while Paddle loads cached models (each worker/process)."""
    import os

    stderr_fd = 2
    try:
        devnull = os.open(os.devnull, os.O_WRONLY)
    except OSError:
        yield
        return
    saved = os.dup(stderr_fd)
    try:
        os.dup2(devnull, stderr_fd)
        yield
    finally:
        os.dup2(saved, stderr_fd)
        os.close(saved)
        os.close(devnull)


def _init_paddle_ocr_engine(**kwargs):
    """Construct PaddleOCR without PaddleX model-cache noise on stderr."""
    from paddleocr import PaddleOCR

    _quiet_paddle_loggers()
    with _suppress_paddle_stderr():
        return PaddleOCR(**kwargs)


def _create_paddle_ocr(
    *,
    lang: str | None = None,
    use_gpu: bool | None = None,
    use_angle_cls: bool | None = None,
    log: Callable[[str], None] | None = None,
):
    """Init PaddleOCR for 2.x and 3.x; disable doc preprocess + oneDNN (CPU crash workaround)."""
    _disable_paddle_onednn()

    lang = str(lang if lang is not None else _cfg["lang"])
    use_gpu = bool(_cfg["use_gpu"] if use_gpu is None else use_gpu)
    use_angle = bool(_cfg["use_angle_cls"] if use_angle_cls is None else use_angle_cls)
    log_fn = log or _cfg.get("log") or (lambda _m: None)

    try:
        ocr = _init_paddle_ocr_engine(
            lang=lang,
            device="gpu" if use_gpu else "cpu",
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=use_angle,
            text_rec_score_thresh=0.0,
            enable_mkldnn=False,  # bypass Paddle 3.3.x oneDNN/PIR bug
        )
        log_fn(f"Step1 PaddleOCR: engine=3.x lang={lang} gpu={use_gpu} mkldnn=False textline_orient={use_angle}")
        return ocr
    except TypeError as exc:
        log_fn(f"Step1 PaddleOCR: 3.x init failed ({exc}); fallback 2.x API")

    try:
        return _init_paddle_ocr_engine(
            lang=lang,
            use_angle_cls=use_angle,
            use_gpu=use_gpu,
            show_log=False,
            enable_mkldnn=False,
        )
    except TypeError:
        try:
            return _init_paddle_ocr_engine(lang=lang, use_angle_cls=use_angle, enable_mkldnn=False)
        except TypeError:
            return _init_paddle_ocr_engine(lang=lang, use_angle_cls=use_angle)


def _ensure_bgr3(img):
    """PaddleOCR expects 3-channel; grayscale (H,W) fails — EasyOCR does not."""
    import cv2
    import numpy as np

    if img is None:
        return None
    arr = np.asarray(img)
    if arr.ndim == 2:
        return cv2.cvtColor(arr, cv2.COLOR_GRAY2BGR)
    if arr.ndim == 3 and arr.shape[2] == 1:
        return cv2.cvtColor(arr[:, :, 0], cv2.COLOR_GRAY2BGR)
    if arr.ndim == 3 and arr.shape[2] == 4:
        return cv2.cvtColor(arr, cv2.COLOR_BGRA2BGR)
    return arr


def _page_get(page, key: str):
    if page is None:
        return None
    if isinstance(page, dict):
        return page.get(key)
    for accessor in (
        lambda: page.get(key) if hasattr(page, "get") else None,
        lambda: page[key] if hasattr(page, "__getitem__") else None,
        lambda: getattr(page, key, None),
        lambda: (getattr(page, "json", None) or {}).get(key) if hasattr(page, "json") else None,
    ):
        try:
            val = accessor()
            if val is not None:
                return val
        except Exception:
            continue
    return None


def _parse_line(item):
    bbox = item[0]
    rec = item[1]
    text = str(rec[0]) if rec else ""
    conf = float(rec[1]) if rec and len(rec) > 1 else 0.0
    return bbox, text, conf


def _paddle_result_to_lines(result) -> list:
    """Normalize PaddleOCR 2.x / 3.x → list of (bbox, text, conf)."""
    import numpy as np

    if result is None:
        return []
    if hasattr(result, "rec_texts") or (
        hasattr(result, "get") and not isinstance(result, (list, tuple))
    ):
        result = [result]
    try:
        result = list(result)
    except TypeError:
        return []
    if not result:
        return []

    first = result[0]
    if first is None:
        return []

    looks_v3 = bool(
        isinstance(first, dict)
        or hasattr(first, "rec_texts")
        or (hasattr(first, "__getitem__") and _page_get(first, "rec_texts") is not None)
    )

    if looks_v3:
        out: list = []
        for page in result:
            texts = list(_page_get(page, "rec_texts") or [])
            scores = list(_page_get(page, "rec_scores") or [])
            polys = list(_page_get(page, "dt_polys") or _page_get(page, "rec_polys") or [])
            for i, text in enumerate(texts):
                conf = float(scores[i]) if i < len(scores) else 0.0
                poly = polys[i] if i < len(polys) else None
                if poly is None:
                    bbox = [[0.0, 0.0], [0.0, 0.0], [0.0, 0.0], [0.0, 0.0]]
                else:
                    pts = np.asarray(poly, dtype=np.float32).reshape(-1, 2)
                    bbox = [[float(x), float(y)] for x, y in pts]
                out.append((bbox, str(text or ""), conf))
        return out

    page_lines = first if first is not None else []
    out = []
    for item in page_lines or []:
        if not item or len(item) < 2:
            continue
        out.append(_parse_line(item))
    return out


def _run_paddle_ocr(ocr, img, *, cls: bool = True, log_errors: bool = False) -> list:
    """Run PaddleOCR; always feed 3-channel BGR. Returns (bbox, text, conf)."""
    bgr = _ensure_bgr3(img)
    if bgr is None or getattr(bgr, "size", 0) == 0:
        return []

    raw = None
    err = None

    # 3.x predict() — never pass cls= (invalid kw)
    if hasattr(ocr, "predict"):
        try:
            raw = ocr.predict(bgr, text_rec_score_thresh=0.0)
        except TypeError:
            try:
                raw = ocr.predict(bgr)
            except Exception as exc:
                err = exc
        except Exception as exc:
            err = exc

    if raw is None:
        try:
            raw = ocr.ocr(bgr, cls=cls)
            err = None
        except TypeError:
            try:
                raw = ocr.ocr(bgr)
                err = None
            except Exception as exc:
                err = exc
        except Exception as exc:
            err = exc

    if err is not None and log_errors:
        _cfg["log"](f"Step1 PaddleOCR: OCR error: {type(err).__name__}: {err}")
    if raw is None:
        return []

    lines = _paddle_result_to_lines(raw)
    if log_errors and not lines:
        preview = type(raw).__name__
        try:
            if isinstance(raw, (list, tuple)) and raw:
                preview = f"{preview}[0]={type(raw[0]).__name__}"
                sample = raw[0]
                keys = None
                if isinstance(sample, dict):
                    keys = list(sample.keys())[:12]
                elif hasattr(sample, "keys"):
                    keys = list(sample.keys())[:12]
                if keys:
                    preview += f" keys={keys}"
        except Exception:
            pass
        _cfg["log"](f"Step1 PaddleOCR: OCR returned 0 lines (raw={preview})")
    return lines


def _readtext_sort_for_join(lines):
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
# Crop band auto-detect (giống EasyOCR, OCR = Paddle)
# ──────────────────────────────────────────────

def _detect_crop_band(video_path: Path, ocr, ocr_dir: Path):
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
            try:
                cv2.imwrite(str(debug_probe_dir / f"{fp.stem}_scan.png"), _ensure_bgr3(gray))
            except Exception:
                pass
            lines = _run_paddle_ocr(
                ocr, gray, cls=_cfg["use_angle_cls"], log_errors=(len(all_hi) == 0)
            )
        except Exception as exc:
            log(f"Step1 PaddleOCR: crop detect [{fp.name}] exception: {exc}")
            continue
        frame_boxes = []
        for bbox, text, conf in lines:
            conf_f = float(conf)
            text_s = str(text or "").strip()
            if conf_f < float(_cfg["min_confidence"]):
                log(f"Step1 PaddleOCR: crop detect [{fp.name}] skip conf={conf_f:.2f} text=\"{text_s[:30]}\"")
                continue
            if not text_s or _should_skip_merged_text(text_s):
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
# Parallel OCR workers (ProcessPool — Paddle không thread-safe)
# ──────────────────────────────────────────────

_pool_ocr = None
_pool_min_conf = 0.5
_pool_low_floor = 0.0
_pool_use_cls = True
_pool_frame_interval = 0.5


def _pool_worker_init(
    lang: str,
    use_gpu: bool,
    use_angle: bool,
    min_conf: float,
    low_floor: float,
    use_cls: bool,
    frame_interval: float,
) -> None:
    global _pool_ocr, _pool_min_conf, _pool_low_floor, _pool_use_cls, _pool_frame_interval
    _pool_min_conf = float(min_conf)
    _pool_low_floor = float(low_floor)
    _pool_use_cls = bool(use_cls)
    _pool_frame_interval = float(frame_interval)
    _pool_ocr = _create_paddle_ocr(
        lang=lang,
        use_gpu=use_gpu,
        use_angle_cls=use_angle,
        log=lambda _m: None,
    )


def _pool_ocr_one(item: tuple) -> tuple:
    """OCR one frame in a worker process. item=(idx, path_str)."""
    import cv2

    idx, fpath_str = item
    fpath = Path(fpath_str)
    timestamp_sec = idx * _pool_frame_interval
    debug_row = {
        "frame_index": idx,
        "frame_png": fpath.name,
        "timestamp_sec": timestamp_sec,
        "paddleocr_min_confidence": _pool_min_conf,
        "raw_readtext_order": [],
        "sorted_reading_order": [],
        "joined_after_filter": "",
        "error": None,
    }
    try:
        img = cv2.imread(str(fpath))
        if img is None:
            debug_row["error"] = "cv2.imread failed"
            return timestamp_sec, "", "", debug_row
        lines = _run_paddle_ocr(_pool_ocr, img, cls=_pool_use_cls)
        ser = [
            {
                "bbox": [[float(p[0]), float(p[1])] for p in box] if box else [],
                "text": text,
                "confidence": float(conf),
            }
            for box, text, conf in (lines or [])
        ]
        debug_row["raw_readtext_order"] = ser
        sorted_results = _readtext_sort_for_join(lines)
        debug_row["sorted_reading_order"] = [
            {
                "bbox": [[float(p[0]), float(p[1])] for p in box] if box else [],
                "text": text,
                "confidence": float(conf),
            }
            for box, text, conf in (sorted_results or [])
        ]
        texts = [
            str(t).strip()
            for _b, t, conf in sorted_results
            if conf >= _pool_min_conf and str(t).strip()
        ]
        joined = " ".join(texts)
        debug_row["joined_after_filter"] = joined
        low_texts = [
            str(t).strip()
            for _b, t, conf in sorted_results
            if _pool_low_floor <= conf < _pool_min_conf and str(t).strip()
        ]
        return timestamp_sec, joined, " ".join(low_texts), debug_row
    except Exception as exc:
        debug_row["error"] = str(exc)
        return timestamp_sec, "", "", debug_row


# ──────────────────────────────────────────────
# Main OCR pipeline
# ──────────────────────────────────────────────

def _ocr_with_paddleocr(video_path: Path) -> Path:
    """Step1: OpenCV gate + PaddleOCR on change; cues with gaps; noise filter."""
    import gc
    import os
    from concurrent.futures import ProcessPoolExecutor, as_completed

    log = _cfg["log"]
    log("Step1: OCR (PaddleOCR)…")

    try:
        from paddleocr import PaddleOCR  # noqa: F401
    except ImportError:
        raise RuntimeError(
            "paddleocr chưa được cài đặt.\n"
            "  GPU: pip install paddlepaddle-gpu paddleocr\n"
            "  CPU: pip install paddlepaddle paddleocr"
        )

    ocr_dir = _cfg["log_dir"] / "step1_paddleocr"
    frames_dir = ocr_dir / "frames"
    shutil.rmtree(ocr_dir, ignore_errors=True)
    ocr_dir.mkdir(parents=True, exist_ok=True)

    ocr = _create_paddle_ocr()
    log(
        f"Step1 PaddleOCR: gray eq contrast={_cfg['gray_contrast']:.3f} "
        f"brightness={_cfg['gray_brightness']:.3f} gamma={_cfg['gray_gamma']:.3f} "
        f"lang={_cfg['lang']} gpu={_cfg['use_gpu']}"
    )

    band_lo, band_hi = _detect_crop_band(video_path, ocr, ocr_dir)
    if band_hi <= band_lo + 1e-9:
        raise RuntimeError(f"Step1 PaddleOCR: invalid crop band lo={band_lo} hi={band_hi}")

    log(f"Step1 PaddleOCR: crop apply lo={band_lo:.3f} hi={band_hi:.3f} strip_pct={(band_hi - band_lo) * 100:.1f}")

    del ocr
    gc.collect()

    extract_fps, native_fps = resolve_extract_fps(
        video_path,
        float(_cfg["fps"]),
        ffmpeg_bin=str(_cfg["ffmpeg_bin"]),
        log=log,
        label="Step1 PaddleOCR",
    )
    if native_fps is not None:
        log(
            f"Step1 PaddleOCR: native_fps={native_fps:.3f} target={float(_cfg['fps']):.3f} "
            f"→ extract_fps={extract_fps:.3f}"
        )
    else:
        log(f"Step1 PaddleOCR: native_fps=unknown → extract_fps={extract_fps:.3f}")

    frames_dir.mkdir(parents=True, exist_ok=True)
    vf = f"{_crop_ffmpeg_vf(band_lo, band_hi)},fps={extract_fps}"
    log(f"Step1 PaddleOCR: ffmpeg extract cropped frames @ {extract_fps} fps (1 pass)…")
    t_ff = time.time()
    _cfg["run_command"](
        [
            _cfg["ffmpeg_bin"], "-y", "-i", str(video_path),
            "-vf", vf, "-an",
            str(frames_dir / "frame_%05d.png"),
        ],
        "PaddleOCR: extract cropped frames",
    )
    frame_files = sorted(frames_dir.glob("frame_*.png"))
    if not frame_files:
        raise RuntimeError("Step1 PaddleOCR: no frames extracted.")
    log(
        f"Step1 PaddleOCR: extracted {len(frame_files)} frames in {time.time() - t_ff:.0f}s"
    )

    frame_interval_sec = 1.0 / extract_fps
    cue_shells, opencv_debug = build_cues_from_opencv(
        frame_files,
        frame_interval_sec,
        framediff_threshold=float(_cfg["framediff_threshold"]),
        white_thresh=int(_cfg.get("white_thresh") or 0),
        progressbar=_cfg["progressbar"],
        log=log,
        label="Step1 PaddleOCR",
        ink_change_threshold=float(_cfg.get("ink_change_threshold") or 0),
        change_confirm_frames=int(_cfg.get("change_confirm_frames") or 1),
    )
    if not cue_shells:
        raise RuntimeError("Step1 PaddleOCR: OpenCV found no subtitle cues.")

    cue_shells, _mask_merged = merge_cue_shells_by_mask(
        cue_shells,
        white_thresh=int(_cfg.get("white_thresh") or 0),
        merge_iou=float(_cfg.get("mask_merge_iou") or 0),
        log=log,
        label="Step1 PaddleOCR",
    )

    annotate_opencv_debug(
        opencv_debug, cue_shells, native_fps=native_fps, extract_fps=extract_fps
    )

    min_conf = float(_cfg["min_confidence"])
    low_floor = float(_cfg["low_conf_floor"])
    use_angle_cls = bool(_cfg["use_angle_cls"])
    use_gpu = bool(_cfg["use_gpu"])

    if use_gpu:
        n_workers = 1
    else:
        cpu_n = os.cpu_count() or 2
        worker_cap = max(1, int(_cfg.get("workers_max") or 6))
        n_workers = max(1, min(int(_cfg["workers"]), cpu_n, worker_cap))

    jobs = [(c["ocr_idx"], c["ocr_path"]) for c in cue_shells]
    total = len(jobs)
    log_every = max(1, total // 20)
    log(
        f"Step1 PaddleOCR: OCR {total}/{len(frame_files)} change frames "
        f"({total * 100 / max(1, len(frame_files)):.1f}%) with {n_workers} worker(s)…"
    )

    ocr_by_idx: dict[int, tuple] = {}
    low_conf_by_idx: dict[int, str] = {}
    ocr_debug_rows: list = []
    t0 = time.time()
    done = 0

    initargs = (
        str(_cfg["lang"]),
        use_gpu,
        use_angle_cls,
        min_conf,
        low_floor,
        use_angle_cls,
        frame_interval_sec,
    )

    def _consume(idx: int, ts: float, text: str, low_text: str, dbg: dict) -> None:
        nonlocal done
        done += 1
        dbg["opencv_gated"] = True
        ocr_debug_rows.append(dbg)
        if text:
            ocr_by_idx[idx] = (ts, text)
        elif low_text:
            low_conf_by_idx[idx] = low_text
        if done == 1 or done % log_every == 0 or done == total:
            log(
                f"Step1 PaddleOCR: OCR progress {done}/{total} "
                f"({done * 100 / total:.0f}%) high={len(ocr_by_idx)} "
                f"elapsed={time.time() - t0:.0f}s"
            )

    if n_workers <= 1:
        _pool_worker_init(*initargs)
        for item in _cfg["progressbar"](jobs, total=total, desc="PaddleOCR frames"):
            ts, text, low_text, dbg = _pool_ocr_one(item)
            _consume(item[0], ts, text, low_text, dbg)
    else:
        try:
            import multiprocessing as mp
            ctx = mp.get_context("spawn")
        except Exception:
            ctx = None
        with ProcessPoolExecutor(
            max_workers=n_workers,
            mp_context=ctx,
            initializer=_pool_worker_init,
            initargs=initargs,
        ) as pool:
            futures = {pool.submit(_pool_ocr_one, item): item[0] for item in jobs}
            for fut in _cfg["progressbar"](
                as_completed(futures), total=total, desc="PaddleOCR frames"
            ):
                idx = futures[fut]
                ts, text, low_text, dbg = fut.result()
                _consume(idx, ts, text, low_text, dbg)

    log(
        f"Step1 PaddleOCR: OCR done — {done} frames, {len(ocr_by_idx)} high-conf, "
        f"{len(low_conf_by_idx)} low-conf, elapsed={time.time() - t0:.0f}s"
    )

    # Low-confidence rescue on gated frames
    fuzzy_thr = float(_cfg["fuzzy_threshold"])
    rescued = rescue_low_conf_gated(
        ocr_by_idx,
        low_conf_by_idx,
        frame_interval_sec=frame_interval_sec,
        bridge_frames=int(_cfg["bridge_frames"]),
        bridge_min_match=int(_cfg["bridge_min_match"]),
        fuzzy_threshold=fuzzy_thr,
    )
    if rescued:
        log(f"Step1 PaddleOCR: rescued {rescued} low-confidence frame(s) via cluster voting.")

    raw_cues = cues_from_shells_and_ocr(cue_shells, ocr_by_idx)

    write_gated_debug_jsonl(
        ocr_dir / "frame_ocr_raw.jsonl",
        opencv_debug,
        ocr_debug_rows,
        ocr_kind="paddleocr",
    )
    log(f"Step1 PaddleOCR: debug log → {ocr_dir / 'frame_ocr_raw.jsonl'}")

    if not raw_cues:
        raise RuntimeError("Step1 PaddleOCR: no text survived cleaning.")

    kept = finalize_gated_cues(
        raw_cues,
        merge_gap_ms=int(_cfg["merge_gap_ms"]),
        fuzzy_threshold=fuzzy_thr,
        skip_compiled=_SKIP_COMPILED,
        noise_min_duration_ms=int(_cfg.get("noise_min_duration_ms") or 0),
        log=log,
        label="Step1 PaddleOCR",
    )
    if not kept:
        raise RuntimeError("Step1 PaddleOCR: all cues removed by filters.")

    srt_path = _cfg["get_zh_srt_path"]()
    write_srt_cues(
        kept,
        srt_path,
        fmt_time=_cfg["fmt_time"],
        min_duration_ms=int(_cfg.get("min_duration_ms") or 0),
    )
    log(f"Step1 PaddleOCR: done — {len(kept)} blocks → {srt_path}")
    return srt_path
