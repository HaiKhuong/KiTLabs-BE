"""OpenCV text-change gate + shared post-processing for visual OCR engines."""

from __future__ import annotations

import json
import subprocess
import time
from collections.abc import Iterable
from pathlib import Path
from typing import Any, Callable

from subtitle.normalize import clean_text, same_subtitle_line
from subtitle.watermark import should_skip_text


def ffprobe_bin(ffmpeg_bin: str) -> str:
    ffmpeg = Path(ffmpeg_bin)
    for cand in (ffmpeg.with_name("ffprobe.exe"), ffmpeg.with_name("ffprobe")):
        if cand.exists():
            return str(cand)
    return "ffprobe"


def probe_native_fps(
    video_path: Path,
    *,
    ffmpeg_bin: str,
    log: Callable[[str], None] | None = None,
    label: str = "Step1",
) -> float | None:
    """Return avg/r_frame_rate as float, or None if probe fails."""
    try:
        result = subprocess.run(
            [
                ffprobe_bin(ffmpeg_bin), "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=avg_frame_rate,r_frame_rate",
                "-of", "json",
                str(video_path),
            ],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        if result.returncode != 0 or not (result.stdout or "").strip():
            return None
        data = json.loads(result.stdout)
        streams = data.get("streams") or []
        if not streams:
            return None
        stream = streams[0]
        for key in ("avg_frame_rate", "r_frame_rate"):
            raw = str(stream.get(key) or "").strip()
            if not raw or raw in ("0/0", "N/A"):
                continue
            if "/" in raw:
                num_s, den_s = raw.split("/", 1)
                num, den = float(num_s), float(den_s)
                if den > 0 and num > 0:
                    return num / den
            else:
                val = float(raw)
                if val > 0:
                    return val
    except Exception as exc:
        if log:
            log(f"{label}: native FPS probe failed: {exc}")
    return None


def resolve_extract_fps(
    video_path: Path,
    target_fps: float,
    *,
    ffmpeg_bin: str,
    log: Callable[[str], None],
    label: str = "Step1",
) -> tuple[float, float | None]:
    """Target scan fps clamped to native; returns (extract_fps, native_fps|None)."""
    target = float(target_fps)
    native = probe_native_fps(video_path, ffmpeg_bin=ffmpeg_bin, log=log, label=label)
    if native is not None and native > 0:
        effective = min(target, native)
    else:
        effective = target
    effective = max(0.5, float(effective))
    if target < 5.0:
        log(
            f"{label}: WARNING scan_fps={target:.2f} < 5 — "
            "có thể miss subtitle ngắn (~0.2–0.4s)"
        )
    return effective, native


def to_gray_u8(img):
    import cv2
    import numpy as np

    arr = np.asarray(img)
    if arr.ndim == 2:
        return arr
    if arr.ndim == 3 and arr.shape[2] == 1:
        return arr[:, :, 0]
    if arr.ndim == 3 and arr.shape[2] >= 3:
        return cv2.cvtColor(arr, cv2.COLOR_BGR2GRAY)
    return arr.astype("uint8")


def build_text_mask(img, *, white_thresh: int = 0):
    """Binary text mask on preprocessed crop strip."""
    import cv2
    import numpy as np

    gray = to_gray_u8(img)
    wt = int(white_thresh or 0)
    if wt > 0:
        _, binary = cv2.threshold(gray, max(0, min(254, wt)), 255, cv2.THRESH_BINARY)
    else:
        blur = cv2.GaussianBlur(gray, (3, 3), 0)
        _, binary = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        if float(np.mean(binary)) > 127:
            binary = 255 - binary

    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 2))
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel, iterations=1)
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=1)

    n_labels, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    if n_labels <= 1:
        return np.zeros_like(gray, dtype=np.uint8)

    h, w = gray.shape[:2]
    min_area = max(8, int(h * w * 0.0008))
    out = np.zeros_like(binary)
    for lab in range(1, n_labels):
        area = int(stats[lab, cv2.CC_STAT_AREA])
        if area < min_area:
            continue
        bw = int(stats[lab, cv2.CC_STAT_WIDTH])
        bh = int(stats[lab, cv2.CC_STAT_HEIGHT])
        if bw < 2 or bh < 2:
            continue
        out[labels == lab] = 255
    return out


def is_blank_mask(mask, min_ink_ratio: float = 0.0015) -> bool:
    import numpy as np

    if mask is None or mask.size == 0:
        return True
    ink = float(np.count_nonzero(mask)) / float(mask.size)
    return ink < min_ink_ratio


def mask_change_score(mask_a, mask_b) -> float:
    """MAD on 0/255 masks (0–255)."""
    import numpy as np

    if mask_a is None or mask_b is None:
        return 255.0
    if mask_a.shape != mask_b.shape:
        return 255.0
    a = mask_a.astype(np.float32)
    b = mask_b.astype(np.float32)
    return float(np.mean(np.abs(a - b)))


def mask_ink_change_ratio(mask_a, mask_b) -> float:
    """Fraction of ink pixels that differ (0–1). Robust vs 1–2px mask jitter."""
    import numpy as np

    if mask_a is None or mask_b is None:
        return 1.0
    if mask_a.shape != mask_b.shape:
        return 1.0
    a = mask_a > 0
    b = mask_b > 0
    ink = np.logical_or(a, b)
    ink_count = int(ink.sum())
    if ink_count <= 0:
        return 0.0
    xor = np.logical_xor(a, b)
    return float(xor.sum()) / float(ink_count)


def mask_iou(mask_a, mask_b) -> float:
    """IoU on binary ink regions (0–1)."""
    import numpy as np

    if mask_a is None or mask_b is None:
        return 0.0
    if mask_a.shape != mask_b.shape:
        return 0.0
    a = mask_a > 0
    b = mask_b > 0
    inter = int(np.logical_and(a, b).sum())
    union = int(np.logical_or(a, b).sum())
    if union <= 0:
        return 1.0
    return float(inter) / float(union)


def resolve_opencv_change_threshold(
    framediff_threshold: float,
    ink_change_threshold: float | None,
) -> tuple[float, str]:
    """Return (threshold, metric) where metric is ink_ratio or mad."""
    if ink_change_threshold is not None and float(ink_change_threshold) > 0:
        return float(ink_change_threshold), "ink_ratio"
    return float(framediff_threshold), "mad"


def merge_cue_shells_by_mask(
    cue_shells: list[dict],
    *,
    white_thresh: int,
    merge_iou: float,
    log: Callable[[str], None],
    label: str = "Step1",
    short_gap_sec: float = 0.25,
) -> tuple[list[dict], int]:
    """
    Merge consecutive OpenCV cue shells with similar masks before OCR.

    Cuts redundant Paddle/EasyOCR calls when the gate flickers on the same subtitle.
    """
    if merge_iou <= 0 or len(cue_shells) <= 1:
        return cue_shells, 0

    import cv2

    def _load_mask(path) -> object | None:
        img = cv2.imread(str(path))
        if img is None:
            return None
        return build_text_mask(img, white_thresh=white_thresh)

    merged: list[dict] = [dict(cue_shells[0])]
    skipped = 0
    prev_mask = cue_shells[0].get("ocr_mask")
    if prev_mask is None:
        prev_mask = _load_mask(merged[0]["ocr_path"])
    gap_iou_floor = max(0.45, float(merge_iou) - 0.15)

    for cue in cue_shells[1:]:
        curr_mask = cue.get("ocr_mask")
        if curr_mask is None:
            curr_mask = _load_mask(cue["ocr_path"])
        gap_sec = float(cue["start"]) - float(merged[-1]["end"])
        should_merge = False
        if prev_mask is not None and curr_mask is not None:
            iou = mask_iou(prev_mask, curr_mask)
            if iou >= float(merge_iou):
                should_merge = True
            elif gap_sec <= float(short_gap_sec) and iou >= gap_iou_floor:
                should_merge = True
        if should_merge:
            merged[-1]["end"] = float(cue["end"])
            skipped += 1
            continue
        merged.append(dict(cue))
        prev_mask = curr_mask if curr_mask is not None else _load_mask(cue["ocr_path"])

    if skipped:
        log(
            f"{label}: mask merge IoU>={merge_iou:.2f} — "
            f"{len(cue_shells)} cue shell(s) → {len(merged)} OCR frame(s) "
            f"(skipped {skipped})"
        )
    return merged, skipped


def _persist_ocr_frame(img, ocr_frames_dir: Path, frame_index: int) -> Path:
    import cv2

    ocr_frames_dir.mkdir(parents=True, exist_ok=True)
    path = ocr_frames_dir / f"ocr_{frame_index:05d}.png"
    to_write = img
    if img is not None and getattr(img, "ndim", 0) == 2:
        to_write = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    cv2.imwrite(str(path), to_write)
    return path


def _opencv_gate_core(
    frame_source: Iterable[tuple[int, float, Any, str, Path | None]],
    *,
    total: int,
    frame_interval_sec: float,
    framediff_threshold: float,
    white_thresh: int,
    progressbar: Callable,
    log: Callable[[str], None],
    label: str,
    ink_change_threshold: float | None,
    change_confirm_frames: int,
    min_cue_hold_frames: int,
    ocr_frames_dir: Path | None = None,
) -> tuple[list[dict], list[dict], int]:
    """Shared OpenCV gate loop for disk paths or ffmpeg pipe stream."""
    change_thr, change_metric = resolve_opencv_change_threshold(
        framediff_threshold, ink_change_threshold
    )
    confirm = max(1, int(change_confirm_frames))
    min_hold = max(1, int(min_cue_hold_frames))
    cues: list[dict] = []
    debug_rows: list[dict] = []
    state: dict | None = None
    pending_change = 0
    scanned = 0
    ocr_save_dir = Path(ocr_frames_dir) if ocr_frames_dir else None

    def _ocr_path_for(idx: int, img, existing: Path | None) -> Path | None:
        if existing is not None:
            return existing
        if ocr_save_dir is None:
            return None
        return _persist_ocr_frame(img, ocr_save_dir, idx)

    def _close_state() -> None:
        nonlocal state, pending_change
        if state is None:
            return
        cues.append(
            {
                "start": float(state["start"]),
                "end": float(state["last_text_t"]),
                "ocr_idx": int(state["ocr_idx"]),
                "ocr_path": str(state["ocr_path"]),
                "select_reason": state.get("select_reason", "appear"),
                "ocr_mask": state.get("ocr_mask"),
            }
        )
        state = None
        pending_change = 0

    total_hint = max(1, int(total))
    log_every = max(1, total_hint // 20)
    t0 = time.time()
    if change_metric == "ink_ratio":
        log(
            f"{label}: OpenCV gate metric=ink_ratio threshold={change_thr:.3f} "
            f"confirm_frames={confirm} min_hold_frames={min_hold}"
        )
    else:
        log(
            f"{label}: OpenCV gate metric=mad threshold={change_thr:.2f} "
            f"confirm_frames={confirm}"
        )

    for idx, ts, img, frame_label, ocr_path in progressbar(
        frame_source, total=total_hint, desc="OpenCV text-change"
    ):
        scanned = idx + 1
        row = {
            "frame_index": idx,
            "frame_png": frame_label,
            "timestamp_sec": ts,
            "opencv_change_score": None,
            "opencv_change_metric": change_metric,
            "is_blank": None,
            "ocr_skipped": True,
            "select_reason": "skip",
            "extract_fps": 1.0 / frame_interval_sec if frame_interval_sec > 0 else None,
        }
        if img is None:
            row["select_reason"] = "imread_failed"
            row["is_blank"] = True
            debug_rows.append(row)
            if state is not None:
                _close_state()
            continue

        mask = build_text_mask(img, white_thresh=white_thresh)
        blank = is_blank_mask(mask)
        row["is_blank"] = blank

        if blank:
            row["select_reason"] = "blank"
            row["opencv_change_score"] = 0.0
            debug_rows.append(row)
            if state is not None:
                _close_state()
            continue

        if state is None:
            pending_change = 0
            ocr_path = _ocr_path_for(idx, img, ocr_path)
            state = {
                "start": ts,
                "last_text_t": ts,
                "key_mask": mask,
                "ocr_idx": idx,
                "ocr_path": ocr_path,
                "ocr_mask": mask,
                "select_reason": "appear",
                "frame_count": 1,
            }
            row["ocr_skipped"] = False
            row["select_reason"] = "appear"
            row["opencv_change_score"] = 0.0
            debug_rows.append(row)
        else:
            if change_metric == "ink_ratio":
                score = mask_ink_change_ratio(mask, state["key_mask"])
                is_change = score >= change_thr
            else:
                score = mask_change_score(mask, state["key_mask"])
                is_change = score >= change_thr
            row["opencv_change_score"] = score
            if is_change and int(state.get("frame_count", 1)) < min_hold:
                is_change = False
                row["select_reason"] = "hold"
            if is_change:
                pending_change += 1
                if pending_change >= confirm:
                    _close_state()
                    saved_path = _ocr_path_for(idx, img, ocr_path)
                    state = {
                        "start": ts,
                        "last_text_t": ts,
                        "key_mask": mask,
                        "ocr_idx": idx,
                        "ocr_path": saved_path,
                        "ocr_mask": mask,
                        "select_reason": "change",
                        "frame_count": 1,
                    }
                    pending_change = 0
                    row["ocr_skipped"] = False
                    row["select_reason"] = "change"
                    debug_rows.append(row)
                else:
                    state["last_text_t"] = ts
                    state["key_mask"] = mask
                    state["frame_count"] = int(state.get("frame_count", 1)) + 1
                    row["select_reason"] = "change_pending"
                    debug_rows.append(row)
            else:
                pending_change = 0
                state["last_text_t"] = ts
                state["key_mask"] = mask
                state["frame_count"] = int(state.get("frame_count", 1)) + 1
                row["select_reason"] = row.get("select_reason") or "same"
                debug_rows.append(row)

        done = idx + 1
        if done == 1 or done % log_every == 0 or done >= total_hint:
            log(
                f"{label}: OpenCV progress {done}/{total_hint} "
                f"cues={len(cues) + (1 if state else 0)} "
                f"elapsed={time.time() - t0:.0f}s"
            )

    _close_state()
    _thr_label = f"{change_thr:.3f}" if change_metric == "ink_ratio" else f"{change_thr:.2f}"
    log(
        f"{label}: OpenCV done — {scanned} frames → {len(cues)} cue(s) "
        f"(metric={change_metric}, threshold={_thr_label}) "
        f"elapsed={time.time() - t0:.0f}s"
    )
    return cues, debug_rows, scanned


def build_cues_from_opencv_stream(
    frame_iter: Iterable[tuple[int, float, Any]],
    frame_interval_sec: float,
    *,
    ocr_frames_dir: Path,
    total_estimate: int,
    framediff_threshold: float,
    white_thresh: int,
    progressbar: Callable,
    log: Callable[[str], None],
    label: str = "Step1",
    ink_change_threshold: float | None = 0.20,
    change_confirm_frames: int = 3,
    min_cue_hold_frames: int = 3,
) -> tuple[list[dict], list[dict], int]:
    """OpenCV gate over ffmpeg pipe stream; persist PNG only for appear/change frames."""

    def _source():
        for idx, ts, img in frame_iter:
            yield idx, ts, img, f"stream_{idx:05d}", None

    return _opencv_gate_core(
        _source(),
        total=total_estimate,
        frame_interval_sec=frame_interval_sec,
        framediff_threshold=framediff_threshold,
        white_thresh=white_thresh,
        progressbar=progressbar,
        log=log,
        label=label,
        ink_change_threshold=ink_change_threshold,
        change_confirm_frames=change_confirm_frames,
        min_cue_hold_frames=min_cue_hold_frames,
        ocr_frames_dir=ocr_frames_dir,
    )


def build_cues_from_opencv(
    frame_files: list[Path],
    frame_interval_sec: float,
    *,
    framediff_threshold: float,
    white_thresh: int,
    progressbar: Callable,
    log: Callable[[str], None],
    label: str = "Step1",
    ink_change_threshold: float | None = 0.20,
    change_confirm_frames: int = 3,
    min_cue_hold_frames: int = 3,
) -> tuple[list[dict], list[dict]]:
    """
    Sequential OpenCV pass over PNG folder → cue shells with start/end gaps.

    Each cue: {start, end, ocr_idx, ocr_path, select_reason}
    """
    import cv2

    def _source():
        for idx, fpath in enumerate(frame_files):
            ts = idx * frame_interval_sec
            img = cv2.imread(str(fpath))
            yield idx, ts, img, fpath.name, fpath

    cues, debug_rows, _scanned = _opencv_gate_core(
        _source(),
        total=len(frame_files),
        frame_interval_sec=frame_interval_sec,
        framediff_threshold=framediff_threshold,
        white_thresh=white_thresh,
        progressbar=progressbar,
        log=log,
        label=label,
        ink_change_threshold=ink_change_threshold,
        change_confirm_frames=change_confirm_frames,
        min_cue_hold_frames=min_cue_hold_frames,
    )
    return cues, debug_rows


def annotate_opencv_debug(
    opencv_debug: list[dict],
    cue_shells: list[dict],
    *,
    native_fps: float | None,
    extract_fps: float,
) -> None:
    ocr_idx_set = {c["ocr_idx"] for c in cue_shells}
    for row in opencv_debug:
        row["native_fps"] = native_fps
        row["extract_fps"] = extract_fps
        if row["frame_index"] in ocr_idx_set and row.get("select_reason") in ("appear", "change"):
            row["ocr_skipped"] = False


def rescue_low_conf_gated(
    ocr_by_idx: dict[int, tuple[float, str]],
    low_conf_by_idx: dict[int, str],
    *,
    frame_interval_sec: float,
    bridge_frames: int,
    bridge_min_match: int,
    fuzzy_threshold: float,
) -> int:
    if not low_conf_by_idx or bridge_min_match <= 0:
        return 0
    all_cands = sorted(
        list(ocr_by_idx.values())
        + [(idx * frame_interval_sec, tx) for idx, tx in low_conf_by_idx.items()],
        key=lambda x: x[0],
    )
    rescued = 0
    for idx, text in list(low_conf_by_idx.items()):
        ts = idx * frame_interval_sec
        window = bridge_frames * frame_interval_sec
        neighbors = [tx for t, tx in all_cands if abs(t - ts) <= window and t != ts]
        matches = sum(1 for tx in neighbors if same_subtitle_line(text, tx, fuzzy_threshold))
        if matches >= bridge_min_match:
            ocr_by_idx[idx] = (ts, text)
            rescued += 1
    return rescued


def cues_from_shells_and_ocr(
    cue_shells: list[dict],
    ocr_by_idx: dict[int, tuple[float, str]],
) -> list[list]:
    raw_cues: list = []
    for cue in cue_shells:
        idx = cue["ocr_idx"]
        hit = ocr_by_idx.get(idx)
        if not hit:
            continue
        _ts, text = hit
        cleaned = clean_text(text)
        if not cleaned:
            continue
        start, end = float(cue["start"]), float(cue["end"])
        if end < start:
            end = start
        raw_cues.append([start, end, cleaned])
    return raw_cues


def merge_cues_with_gap(
    cues: list,
    *,
    merge_gap_ms: int,
    fuzzy_threshold: float,
) -> list:
    merged: list = []
    for block in cues:
        if (
            merged
            and same_subtitle_line(merged[-1][2], block[2], fuzzy_threshold)
            and (block[0] - merged[-1][1]) * 1000 <= merge_gap_ms
        ):
            merged[-1][1] = block[1]
            if len(block[2]) > len(merged[-1][2]):
                merged[-1][2] = block[2]
        else:
            merged.append(list(block))
    return merged


def filter_skip_regex(
    cues: list,
    skip_compiled: list,
    *,
    log: Callable[[str], None],
    label: str = "Step1",
) -> list:
    kept = []
    skipped = 0
    for start, end, text in cues:
        if should_skip_text(text, skip_compiled):
            skipped += 1
        else:
            kept.append((start, end, text))
    if skipped:
        log(f"{label}: skipped {skipped} block(s) (regex skip filter)")
    return kept


def apply_noise_filter(
    cues: list,
    *,
    noise_min_duration_ms: int,
    fuzzy_threshold: float,
    log: Callable[[str], None],
    label: str = "Step1",
) -> list:
    """Drop ultra-short cues, then merge consecutive duplicate texts."""
    noise_ms = int(noise_min_duration_ms or 0)

    kept = []
    dropped = 0
    for start, end, text in cues:
        dur_ms = (end - start) * 1000.0
        if noise_ms > 0 and dur_ms < noise_ms:
            dropped += 1
            continue
        kept.append([float(start), float(end), str(text)])
    if dropped:
        log(f"{label}: noise filter dropped {dropped} short cue(s) (<{noise_ms}ms)")

    if not kept:
        return []

    merged = [list(kept[0])]
    merges = 0
    for start, end, text in kept[1:]:
        if same_subtitle_line(merged[-1][2], text, fuzzy_threshold):
            merged[-1][1] = end
            if len(text) > len(merged[-1][2]):
                merged[-1][2] = text
            merges += 1
        else:
            merged.append([start, end, text])
    if merges:
        log(f"{label}: noise filter merged {merges} consecutive duplicate cue(s)")
    return [(a, b, t) for a, b, t in merged]


def write_gated_debug_jsonl(
    path: Path,
    opencv_debug: list[dict],
    ocr_debug_rows: list[dict],
    *,
    ocr_kind: str,
) -> None:
    with open(path, "w", encoding="utf8") as f:
        for row in opencv_debug:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
        for row in sorted(ocr_debug_rows, key=lambda r: r["frame_index"]):
            out = dict(row)
            out["kind"] = ocr_kind
            f.write(json.dumps(out, ensure_ascii=False) + "\n")


def write_srt_cues(
    cues: list,
    srt_path: Path,
    *,
    fmt_time: Callable[[float], str],
    min_duration_ms: int = 0,
) -> Path:
    min_dur = int(min_duration_ms or 0)
    with open(srt_path, "w", encoding="utf8") as f:
        for i, (start, end, text) in enumerate(cues, 1):
            if min_dur > 0 and (end - start) * 1000 < min_dur:
                end = start + min_dur / 1000.0
            f.write(f"{i}\n{fmt_time(start)} --> {fmt_time(end)}\n{text}\n\n")
    return srt_path


def finalize_gated_cues(
    raw_cues: list,
    *,
    merge_gap_ms: int,
    fuzzy_threshold: float,
    skip_compiled: list,
    noise_min_duration_ms: int,
    log: Callable[[str], None],
    label: str = "Step1",
) -> list:
    """Merge gap → skip regex → noise filter."""
    if not raw_cues:
        return []
    merged = merge_cues_with_gap(
        raw_cues, merge_gap_ms=merge_gap_ms, fuzzy_threshold=fuzzy_threshold
    )
    kept = filter_skip_regex(merged, skip_compiled, log=log, label=label)
    return apply_noise_filter(
        kept,
        noise_min_duration_ms=noise_min_duration_ms,
        fuzzy_threshold=fuzzy_threshold,
        log=log,
        label=label,
    )
