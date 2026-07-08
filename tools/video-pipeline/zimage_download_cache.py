#!/usr/bin/env python3
"""
Tải Tongyi-MAI/Z-Image-Turbo vào cache (một lần).

Z-Image-Turbo 6B — nhẹ hơn FLUX nhiều (~12GB weights bf16).

Usage (từ tools/video-pipeline, trong venv):
  export HF_TOKEN=hf_...
  python zimage_download_cache.py
"""

from __future__ import annotations

import os
import sys

import flux_cache  # noqa: F401 — HF cache → cache/flux
from flux_cache import FLUX_CACHE_ROOT, resolve_hf_token

MODEL_ID = "Tongyi-MAI/Z-Image-Turbo"

ALLOW_PATTERNS = [
    "model_index.json",
    "scheduler/**",
    "tokenizer/**",
    "tokenizer_2/**",
    "text_encoder/**",
    "text_encoder_2/**",
    "transformer/**",
    "vae/**",
    "*.json",
]


def main() -> None:
    from huggingface_hub import snapshot_download

    token = resolve_hf_token()
    if not token:
        print("ERROR: thiếu HF_TOKEN", file=sys.stderr)
        sys.exit(1)

    print(f"[zimage-download] cache root: {FLUX_CACHE_ROOT}", file=sys.stderr)
    print(f"[zimage-download] Tải {MODEL_ID} (diffusers layout)…", file=sys.stderr)

    path = snapshot_download(
        MODEL_ID,
        token=token,
        allow_patterns=ALLOW_PATTERNS,
    )
    print(f"[zimage-download] Done: {path}", file=sys.stderr)


if __name__ == "__main__":
    main()
