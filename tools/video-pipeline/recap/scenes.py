from __future__ import annotations

import hashlib
import logging
import os
import subprocess
import urllib.request
from pathlib import Path
from typing import Any

LOG = logging.getLogger("recap.scenes")

# Upstream TransNetV2 weights (git-lfs). pip install often ships LFS pointer stubs.
# Checksums from https://github.com/soCzech/TransNetV2/issues/1#issuecomment-647357796
_TRANSNET_WEIGHT_FILES = {
    "saved_model.pb": "8ac2a52c5719690d512805b6eaf5ce12097c1d8860b3d9de245dcbbc3100f554",
    "variables/variables.data-00000-of-00001": (
        "b8c9dc3eb807583e6215cabee9ca61737b3eb1bceff68418b43bf71459669367"
    ),
    "variables/variables.index": "8b99e28b4ad11372d9a1ad9703298c2e370df14859da4245fdbe818e92dd403f",
}
_TRANSNET_WEIGHT_BASE_URLS = (
    "https://media.githubusercontent.com/media/soCzech/TransNetV2/master/inference/transnetv2-weights",
    "https://raw.githubusercontent.com/soCzech/TransNetV2/master/inference/transnetv2-weights",
)


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


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _looks_like_lfs_pointer(path: Path) -> bool:
    try:
        if path.stat().st_size > 1024:
            return False
        head = path.read_bytes()[:80]
        return head.startswith(b"version https://git-lfs.github.com")
    except Exception:
        return False


def _weights_dir_valid(weights_dir: Path) -> bool:
    if not weights_dir.is_dir():
        return False
    for rel, expected in _TRANSNET_WEIGHT_FILES.items():
        path = weights_dir / rel
        if not path.is_file() or _looks_like_lfs_pointer(path):
            return False
        try:
            if _sha256_file(path) != expected:
                return False
        except Exception:
            return False
    return True


def _default_weights_cache() -> Path:
    env = (os.environ.get("TRANSNET_WEIGHTS_DIR") or "").strip()
    if env:
        return Path(env).expanduser().resolve()
    # tools/video-pipeline/.cache/transnetv2-weights
    return (Path(__file__).resolve().parents[1] / ".cache" / "transnetv2-weights").resolve()


def _download_weight_file(rel: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    last_err: Exception | None = None
    for base in _TRANSNET_WEIGHT_BASE_URLS:
        url = f"{base}/{rel}"
        try:
            LOG.info("Downloading TransNet weight %s …", rel)
            urllib.request.urlretrieve(url, tmp)
            expected = _TRANSNET_WEIGHT_FILES[rel]
            digest = _sha256_file(tmp)
            if digest != expected:
                raise RuntimeError(f"checksum mismatch for {rel}: got {digest}")
            tmp.replace(dest)
            return
        except Exception as exc:
            last_err = exc
            LOG.warning("TransNet weight download failed (%s): %s", url, exc)
            try:
                tmp.unlink(missing_ok=True)
            except Exception:
                pass
    raise RuntimeError(f"Failed to download TransNet weight {rel}: {last_err}")


def ensure_transnet_weights() -> Path:
    """
    Return a directory with valid TransNetV2 SavedModel weights.
    Re-downloads git-lfs blobs when pip left pointer stubs in site-packages.
    """
    cache = _default_weights_cache()
    if _weights_dir_valid(cache):
        return cache

    # Try packaged location first (may already be real weights)
    try:
        import transnetv2  # type: ignore

        pkg_dir = Path(transnetv2.__file__).resolve().parent / "transnetv2-weights"
        if _weights_dir_valid(pkg_dir):
            return pkg_dir
        if pkg_dir.is_dir():
            LOG.warning(
                "Packaged TransNet weights look corrupted/LFS stubs (%s); downloading to %s",
                pkg_dir,
                cache,
            )
    except Exception:
        pass

    for rel in _TRANSNET_WEIGHT_FILES:
        dest = cache / rel
        if dest.is_file() and not _looks_like_lfs_pointer(dest):
            try:
                if _sha256_file(dest) == _TRANSNET_WEIGHT_FILES[rel]:
                    continue
            except Exception:
                pass
        _download_weight_file(rel, dest)

    if not _weights_dir_valid(cache):
        raise RuntimeError(f"TransNet weights still invalid after download: {cache}")
    LOG.info("TransNet weights ready at %s", cache)
    return cache


def _transnet_v2(video: Path, work_dir: Path) -> list[dict[str, Any]]:
    """Optional TransNet V2 via transnetv2 package (TensorFlow upstream)."""
    try:
        from transnetv2 import TransNetV2  # type: ignore
    except Exception as exc:
        raise RuntimeError(f"transnetv2 import failed: {exc}") from exc

    try:
        weights_dir = ensure_transnet_weights()
        model = TransNetV2(str(weights_dir))
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
