from __future__ import annotations

import logging
import subprocess
from pathlib import Path
from typing import Any

LOG = logging.getLogger("recap.scenes")


def detect_shots(video: Path, work_dir: Path, movie_dur: float) -> list[dict[str, Any]]:
    """TransNet V2 when available; else FFmpeg scene filter / fixed grid."""
    try:
        shots = _transnet_v2(video, work_dir)
        if shots:
            return _merge_short_shots(shots, min_sec=1.5)
    except Exception as exc:
        LOG.warning("TransNet V2 failed (%s); falling back", exc)

    try:
        shots = _ffmpeg_scene(video, movie_dur)
        if shots:
            return _merge_short_shots(shots, min_sec=1.5)
    except Exception as exc:
        LOG.warning("FFmpeg scene detect failed (%s); using fixed grid", exc)

    return _fixed_grid(movie_dur, step=3.0)


def _merge_short_shots(shots: list[dict[str, Any]], min_sec: float) -> list[dict[str, Any]]:
    if not shots:
        return shots
    merged: list[dict[str, Any]] = []
    cur = dict(shots[0])
    for nxt in shots[1:]:
        dur = float(cur["endSec"]) - float(cur["startSec"])
        if dur < min_sec:
            cur["endSec"] = nxt["endSec"]
            cur["endFrame"] = nxt.get("endFrame", cur.get("endFrame"))
        else:
            merged.append(cur)
            cur = dict(nxt)
    merged.append(cur)
    # reindex
    out = []
    for i, s in enumerate(merged):
        out.append(
            {
                "id": i,
                "startSec": float(s["startSec"]),
                "endSec": float(s["endSec"]),
                "startFrame": s.get("startFrame"),
                "endFrame": s.get("endFrame"),
            }
        )
    return out


def _fixed_grid(movie_dur: float, step: float = 3.0) -> list[dict[str, Any]]:
    shots = []
    t = 0.0
    i = 0
    while t < movie_dur - 0.05:
        end = min(movie_dur, t + step)
        shots.append({"id": i, "startSec": t, "endSec": end})
        t = end
        i += 1
    return shots


def _ffmpeg_scene(video: Path, movie_dur: float, threshold: float = 0.35) -> list[dict[str, Any]]:
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_frames",
        "-select_streams",
        "v:0",
        "-of",
        "csv=p=0",
        "-f",
        "lavfi",
        f"movie={video},select=gt(scene\\,{threshold})",
    ]
    # More portable approach: ffmpeg showinfo
    cmd = [
        "ffmpeg",
        "-i",
        str(video),
        "-filter:v",
        f"select='gt(scene,{threshold})',showinfo",
        "-f",
        "null",
        "-",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    times: list[float] = [0.0]
    for line in (proc.stderr or "").splitlines():
        if "pts_time:" in line:
            try:
                part = line.split("pts_time:")[1].split()[0]
                times.append(float(part))
            except Exception:
                continue
    times.append(float(movie_dur))
    times = sorted(set(max(0.0, t) for t in times if t <= movie_dur + 0.5))
    shots = []
    for i in range(len(times) - 1):
        if times[i + 1] - times[i] < 0.2:
            continue
        shots.append({"id": len(shots), "startSec": times[i], "endSec": times[i + 1]})
    return shots or _fixed_grid(movie_dur)


def _transnet_v2(video: Path, work_dir: Path) -> list[dict[str, Any]]:
    """Optional TransNet V2 via transnetv2 package (TensorFlow upstream)."""
    try:
        from transnetv2 import TransNetV2  # type: ignore
    except Exception as exc:
        raise RuntimeError(f"transnetv2 import failed: {exc}") from exc

    try:
        model = TransNetV2()
        _video_frames, single_frame_predictions, _ = model.predict_video(str(video))
        scenes = model.predictions_to_scenes(single_frame_predictions)
        fps = _probe_fps(video)
        shots = []
        for i, (a, b) in enumerate(scenes):
            shots.append(
                {
                    "id": i,
                    "startFrame": int(a),
                    "endFrame": int(b),
                    "startSec": float(a) / fps,
                    "endSec": float(b) / fps,
                }
            )
        if not shots:
            raise RuntimeError("TransNet V2 returned 0 scenes")
        LOG.info("TransNet V2 detected %d shots (work=%s)", len(shots), work_dir)
        return shots
    except Exception as exc:
        raise RuntimeError(f"TransNet V2 predict failed: {exc}") from exc


def _probe_fps(video: Path) -> float:
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=r_frame_rate",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(video),
    ]
    raw = subprocess.check_output(cmd, text=True).strip().splitlines()[0]
    if "/" in raw:
        a, b = raw.split("/", 1)
        return float(a) / max(float(b), 1e-6)
    return float(raw) or 25.0
