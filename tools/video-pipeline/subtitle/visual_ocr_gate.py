"""OpenCV text-change gate + shared post-processing for visual OCR engines."""

from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path
from typing import Callable

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


def build_cues_from_opencv(
    frame_files: list[Path],
    frame_interval_sec: float,
    *,
    framediff_threshold: float,
    white_thresh: int,
    progressbar: Callable,
    log: Callable[[str], None],
    label: str = "Step1",
) -> tuple[list[dict], list[dict]]:
    """
    Sequential OpenCV pass → cue shells with start/end gaps.

    Each cue: {start, end, ocr_idx, ocr_path, select_reason}
    """
    import cv2

    threshold = float(framediff_threshold)
    cues: list[dict] = []
    debug_rows: list[dict] = []
    state: dict | None = None

    def _close_state() -> None:
        nonlocal state
        if state is None:
            return
        cues.append(
            {
                "start": float(state["start"]),
                "end": float(state["last_text_t"]),
                "ocr_idx": int(state["ocr_idx"]),
                "ocr_path": str(state["ocr_path"]),
                "select_reason": state.get("select_reason", "appear"),
            }
        )
        state = None

    total = len(frame_files)
    log_every = max(1, total // 20)
    t0 = time.time()

    for idx, fpath in enumerate(
        progressbar(frame_files, total=total, desc="OpenCV text-change")
    ):
        ts = idx * frame_interval_sec
        img = cv2.imread(str(fpath))
        row = {
            "frame_index": idx,
            "frame_png": fpath.name,
            "timestamp_sec": ts,
            "opencv_change_score": None,
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
            state = {
                "start": ts,
                "last_text_t": ts,
                "key_mask": mask,
                "ocr_idx": idx,
                "ocr_path": fpath,
                "select_reason": "appear",
            }
            row["ocr_skipped"] = False
            row["select_reason"] = "appear"
            row["opencv_change_score"] = 0.0
            debug_rows.append(row)
        else:
            score = mask_change_score(mask, state["key_mask"])
            row["opencv_change_score"] = score
            if score >= threshold:
                _close_state()
                state = {
                    "start": ts,
                    "last_text_t": ts,
                    "key_mask": mask,
                    "ocr_idx": idx,
                    "ocr_path": fpath,
                    "select_reason": "change",
                }
                row["ocr_skipped"] = False
                row["select_reason"] = "change"
                debug_rows.append(row)
            else:
                state["last_text_t"] = ts
                row["select_reason"] = "same"
                debug_rows.append(row)

        done = idx + 1
        if done == 1 or done % log_every == 0 or done == total:
            log(
                f"{label}: OpenCV progress {done}/{total} "
                f"cues={len(cues) + (1 if state else 0)} "
                f"elapsed={time.time() - t0:.0f}s"
            )

    _close_state()
    log(
        f"{label}: OpenCV done — {total} frames → {len(cues)} cue(s) "
        f"(threshold={threshold:.2f}) elapsed={time.time() - t0:.0f}s"
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
