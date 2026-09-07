"""Movie recap pipeline v2 — full run (legacy) or use step_*.py for individual steps."""

from __future__ import annotations

import argparse
import sys
import traceback
from pathlib import Path

print("[RECAP] boot", flush=True)

import recap_cache  # noqa: F401

from pipeline_cache import load_json
from recap_pipeline import run_all_steps


def main() -> int:
    parser = argparse.ArgumentParser(description="KiTLabs movie recap pipeline (full run)")
    parser.add_argument("--video", required=True)
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--config", required=True)
    args = parser.parse_args()

    video = Path(args.video).resolve()
    work_dir = Path(args.work_dir).resolve()
    cfg = load_json(Path(args.config))

    try:
        out_mp4 = run_all_steps(video, work_dir, cfg)
        print(f"DONE: {out_mp4}", flush=True)
        return 0
    except Exception as exc:
        print(f"[RECAP_FAILED] {exc}", file=sys.stderr)
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    raise SystemExit(main())
