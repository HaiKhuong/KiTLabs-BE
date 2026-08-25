"""Download a HuggingFace repo into the pipeline hub cache. Progress on stdout."""
from __future__ import annotations

import argparse
import os
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--cache-dir", required=True)
    args = parser.parse_args()

    os.makedirs(args.cache_dir, exist_ok=True)
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

    from huggingface_hub import snapshot_download

    token = (os.getenv("HF_TOKEN") or os.getenv("HUGGING_FACE_HUB_TOKEN") or "").strip() or None
    print(f"DOWNLOAD_START repo={args.repo}", flush=True)
    snapshot_download(
        repo_id=args.repo,
        cache_dir=args.cache_dir,
        token=token,
    )
    print(f"DOWNLOAD_DONE repo={args.repo}", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"DOWNLOAD_FAILED {exc}", file=sys.stderr, flush=True)
        raise SystemExit(1)
