"""Adaptive keyframe selection + cheap OpenCV/NumPy quality scores."""

from __future__ import annotations

import logging
import shutil
import subprocess
from pathlib import Path
from typing import Any

LOG = logging.getLogger("recap.keyframes")

VISUAL_VERSION = "kf2"


def probe_timestamps(start_sec: float, end_sec: float, *, min_span_for_multi: float = 2.0) -> list[float]:
    """1 mid point for short shots; 15/50/85% for longer (never exactly start/end)."""
    start = float(start_sec)
    end = max(start + 0.05, float(end_sec))
    dur = end - start
    if dur < min_span_for_multi:
        return [round(start + dur * 0.5, 3)]
    fracs = (0.15, 0.50, 0.85) if dur >= 3.0 else (0.30, 0.70)
    return [round(start + dur * f, 3) for f in fracs]


def _clip01(v: float) -> float:
    return max(0.0, min(1.0, float(v)))


def score_gray_array(
    gray: Any,
    *,
    t: float,
    start_sec: float,
    end_sec: float,
    prev_gray: Any | None = None,
) -> dict[str, float]:
    """Quality metrics in [0, 1] from a 2D uint8 grayscale array."""
    import numpy as np

    arr = np.asarray(gray, dtype=np.float32)
    if arr.ndim == 3:
        arr = arr.mean(axis=2)
    mean = float(arr.mean()) / 255.0
    std = float(arr.std()) / 128.0
    contrast = _clip01(std)
    brightness = _clip01(mean)
    gy, gx = np.gradient(arr)
    lap_var = float((gx * gx + gy * gy).mean())
    # Sharp frames have high gradient energy; normalize loosely.
    blur = _clip01(1.0 - min(lap_var / 800.0, 1.0))
    try:
        import cv2  # type: ignore

        lap = cv2.Laplacian(arr.astype("uint8"), cv2.CV_64F)
        lap_v = float(lap.var())
        blur = _clip01(1.0 - min(lap_v / 400.0, 1.0))
    except Exception:
        pass

    motion = 0.0
    if prev_gray is not None:
        prev = np.asarray(prev_gray, dtype=np.float32)
        if prev.ndim == 3:
            prev = prev.mean(axis=2)
        if prev.shape == arr.shape:
            motion = _clip01(float(np.abs(arr - prev).mean()) / 80.0)

    edge = min(abs(t - start_sec), abs(end_sec - t))
    transition_risk = _clip01(1.0 - min(edge / 0.12, 1.0)) if edge < 0.12 else 0.0
    brightness_ok = _clip01(1.0 - abs(brightness - 0.52) * 1.6)
    stability = _clip01(1.0 - motion)
    confidence = (
        0.35 * (1.0 - blur)
        + 0.20 * brightness_ok
        + 0.15 * contrast
        + 0.15 * (1.0 - transition_risk)
        + 0.15 * stability
    )
    return {
        "blur": round(blur, 4),
        "brightness": round(brightness, 4),
        "contrast": round(_clip01(contrast), 4),
        "motion": round(motion, 4),
        "visualChange": round(motion, 4),
        "transitionRisk": round(transition_risk, 4),
        "confidence": round(_clip01(confidence), 4),
    }


def quality_shot_from_probes(probes: list[dict[str, Any]]) -> dict[str, float]:
    if not probes:
        return {
            "blur": 0.5,
            "brightness": 0.5,
            "contrast": 0.5,
            "motion": 0.0,
            "visualChange": 0.0,
            "transitionRisk": 0.0,
        }
    motions = [float(p["metrics"].get("motion") or 0) for p in probes]
    visual = max(motions) if motions else 0.0
    best = max(probes, key=lambda p: float(p["metrics"].get("confidence") or 0))
    q = dict(best["metrics"])
    q["motion"] = round(sum(motions) / max(1, len(motions)), 4)
    q["visualChange"] = round(visual, 4)
    q.pop("confidence", None)
    return {
        "blur": float(q.get("blur") or 0),
        "brightness": float(q.get("brightness") or 0),
        "contrast": float(q.get("contrast") or 0),
        "motion": float(q.get("motion") or 0),
        "visualChange": float(q.get("visualChange") or 0),
        "transitionRisk": float(q.get("transitionRisk") or 0),
    }


def select_primary_secondary(
    probes: list[dict[str, Any]],
    *,
    duration_sec: float,
    min_shot_sec_for_secondary: float = 3.5,
    motion_threshold: float = 0.22,
    max_secondary: int = 1,
    primary_conf_floor: float = 0.42,
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    if not probes:
        return None, []
    ranked = sorted(probes, key=lambda p: float(p["metrics"].get("confidence") or 0), reverse=True)
    primary = ranked[0]
    secondary: list[dict[str, Any]] = []
    visual = max(float(p["metrics"].get("motion") or 0) for p in probes)
    conf = float(primary["metrics"].get("confidence") or 0)
    need = duration_sec >= min_shot_sec_for_secondary and (
        visual >= motion_threshold or conf < primary_conf_floor
    )
    if need and max_secondary > 0:
        for p in ranked[1:]:
            if abs(float(p["t"]) - float(primary["t"])) < 0.35:
                continue
            secondary.append(p)
            if len(secondary) >= max_secondary:
                break
    return primary, secondary


def _ffmpeg_grab(video: Path, t: float, dest: Path) -> bool:
    dest.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg",
        "-y",
        "-ss",
        f"{t:.3f}",
        "-i",
        str(video),
        "-frames:v",
        "1",
        "-q:v",
        "4",
        str(dest),
    ]
    try:
        subprocess.check_call(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return dest.is_file() and dest.stat().st_size > 0
    except Exception:
        return False


def _load_gray(path: Path) -> Any | None:
    try:
        import cv2  # type: ignore

        img = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
        return img
    except Exception:
        pass
    try:
        from PIL import Image
        import numpy as np

        im = Image.open(path).convert("L")
        return np.asarray(im)
    except Exception:
        return None


def primary_keyframe_name(shot_id: int) -> str:
    return f"shot_{int(shot_id):05d}.jpg"


def secondary_keyframe_name(shot_id: int, index: int = 1) -> str:
    return f"shot_{int(shot_id):05d}_s{index}.jpg"


def extract_adaptive_keyframes(
    video: Path,
    shots: list[dict[str, Any]],
    out_dir: Path,
    *,
    min_shot_sec_for_secondary: float = 3.5,
    motion_threshold: float = 0.22,
    max_secondary: int = 1,
) -> list[Path]:
    """Write primary JPG (+ optional secondary). Mutates shots with keyframes/quality."""
    out_dir.mkdir(parents=True, exist_ok=True)
    primary_paths: list[Path] = []
    for s in shots:
        sid = int(s["id"])
        start = float(s.get("startSec") or 0)
        end = float(s.get("endSec") or start)
        duration = max(0.05, end - start)
        s["durationSec"] = round(duration, 3)
        times = probe_timestamps(start, end)
        probes: list[dict[str, Any]] = []
        prev = None
        tmp_dir = out_dir / "_probe"
        tmp_dir.mkdir(parents=True, exist_ok=True)
        for i, t in enumerate(times):
            tmp = tmp_dir / f"{sid:05d}_{i}.jpg"
            ok = tmp.is_file() and tmp.stat().st_size > 0
            if not ok:
                ok = _ffmpeg_grab(video, t, tmp)
            if not ok:
                continue
            gray = _load_gray(tmp)
            metrics = (
                score_gray_array(gray, t=t, start_sec=start, end_sec=end, prev_gray=prev)
                if gray is not None
                else {
                    "blur": 0.4,
                    "brightness": 0.5,
                    "contrast": 0.4,
                    "motion": 0.0,
                    "visualChange": 0.0,
                    "transitionRisk": 0.0,
                    "confidence": 0.4,
                }
            )
            probes.append({"t": t, "path": tmp, "metrics": metrics})
            prev = gray

        primary, extras = select_primary_secondary(
            probes,
            duration_sec=duration,
            min_shot_sec_for_secondary=min_shot_sec_for_secondary,
            motion_threshold=motion_threshold,
            max_secondary=max_secondary,
        )
        dest = out_dir / primary_keyframe_name(sid)
        if primary and Path(primary["path"]).is_file():
            if Path(primary["path"]).resolve() != dest.resolve():
                shutil.copyfile(primary["path"], dest)
        elif not dest.exists():
            mid = start + duration * 0.5
            _ffmpeg_grab(video, mid, dest)
        primary_paths.append(dest)

        sec_names: list[str] = []
        for j, extra in enumerate(extras, start=1):
            sdest = out_dir / secondary_keyframe_name(sid, j)
            src = Path(extra["path"])
            if src.is_file():
                shutil.copyfile(src, sdest)
                sec_names.append(sdest.name)

        s["keyframes"] = {
            "primary": dest.name if dest.exists() else primary_keyframe_name(sid),
            "secondary": sec_names,
        }
        s["quality"] = quality_shot_from_probes(probes)

    probe_root = out_dir / "_probe"
    if probe_root.is_dir():
        shutil.rmtree(probe_root, ignore_errors=True)

    while len(primary_paths) < len(shots) and primary_paths:
        primary_paths.append(primary_paths[-1])
    return primary_paths


def list_keyframe_paths_for_shot(shot: dict[str, Any], keyframes_dir: Path) -> list[Path]:
    kf = shot.get("keyframes") if isinstance(shot.get("keyframes"), dict) else {}
    names = [kf.get("primary") or primary_keyframe_name(int(shot["id"]))]
    for n in kf.get("secondary") or []:
        names.append(str(n))
    out: list[Path] = []
    for name in names:
        p = keyframes_dir / str(name)
        if p.is_file():
            out.append(p)
        else:
            fallback = keyframes_dir / primary_keyframe_name(int(shot["id"]))
            if fallback.is_file() and fallback not in out:
                out.append(fallback)
    return out
