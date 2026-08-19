"""Quick TransNet V2 health check — run from tools/video-pipeline:

  python recap/check_transnet.py --video /path/to/clip.mp4
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

RECAP_DIR = Path(__file__).resolve().parent
PIPELINE_DIR = RECAP_DIR.parent
if str(RECAP_DIR) not in sys.path:
    sys.path.insert(0, str(RECAP_DIR))
if str(PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(PIPELINE_DIR))


def _ok(msg: str) -> None:
    print(f"  OK  {msg}")


def _fail(msg: str) -> None:
    print(f"  FAIL  {msg}")


def _warn(msg: str) -> None:
    print(f"  WARN  {msg}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Check TransNet V2 prerequisites")
    parser.add_argument("--video", type=Path, help="Optional short mp4 to run inference")
    args = parser.parse_args()

    print("=== TransNet V2 diagnostics ===\n")

    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    if ffmpeg and ffprobe:
        _ok(f"ffmpeg={ffmpeg}")
    else:
        _fail(f"ffmpeg/ffprobe missing (ffmpeg={ffmpeg}, ffprobe={ffprobe})")

    try:
        import ffmpeg as _ffmpeg_py  # noqa: F401

        _ok(f"ffmpeg-python={getattr(_ffmpeg_py, '__file__', '?')}")
    except ImportError:
        _warn("ffmpeg-python not installed — predict_video fallback will fail")

    try:
        import tensorflow as tf

        gpus = tf.config.list_physical_devices("GPU")
        _ok(f"tensorflow={tf.__version__} gpus={len(gpus)}")
    except Exception as exc:
        _fail(f"tensorflow import: {exc}")
        return 1

    try:
        from transnetv2 import TransNetV2  # type: ignore

        _ok(f"transnetv2 package={TransNetV2.__module__}")
    except Exception as exc:
        _fail(f"transnetv2 import: {exc}")
        return 1

    try:
        from scenes import ensure_transnet_weights, _extract_transnet_frames

        weights = ensure_transnet_weights()
        _ok(f"weights={weights}")
    except Exception as exc:
        _fail(f"weights: {exc}")
        return 1

    if not args.video:
        print("\nTip: pass --video /path/to/file.mp4 to test inference")
        return 0

    video = args.video.expanduser().resolve()
    if not video.is_file():
        _fail(f"video not found: {video}")
        return 1

    print(f"\n=== Inference test on {video.name} ===\n")
    try:
        from scenes import _transnet_v2

        shots = _transnet_v2(video, video.parent)
        _ok(f"TransNet detected {len(shots)} shots")
        if shots:
            print(f"       first shot: {shots[0]['startSec']:.2f}s – {shots[0]['endSec']:.2f}s")
        return 0
    except Exception as exc:
        _fail(f"inference: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
