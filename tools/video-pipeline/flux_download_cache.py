#!/usr/bin/env python3
"""
Tải FLUX.1-schnell vào tools/video-pipeline/cache (một lần).

Repo Hub có ~57GB nếu tải FULL (flux1-schnell.safetensors 23.8GB + transformer/ ~23GB trùng + T5…).
Script này chỉ tải layout diffusers (FluxPipeline) — ~32–36GB trên disk.

Usage (từ tools/video-pipeline, trong venv):
  export HF_TOKEN=hf_...
  python flux_download_cache.py
"""

from __future__ import annotations

import os
import sys

import flux_cache  # noqa: F401 — HF cache → tools/video-pipeline/cache
from flux_cache import FLUX_CACHE_ROOT, resolve_hf_token

MODEL_ID = "black-forest-labs/FLUX.1-schnell"

# Diffusers FluxPipeline — bỏ flux1-schnell.safetensors + ae.safetensors ở root (trùng transformer/vae)
ALLOW_PATTERNS = [
    "model_index.json",
    "scheduler/**",
    "tokenizer/**",
    "tokenizer_2/**",
    "text_encoder/**",
    "text_encoder_2/**",
    "transformer/**",
    "vae/**",
]


def main() -> None:
    from huggingface_hub import snapshot_download

    token = resolve_hf_token()
    if not token:
        print("ERROR: thiếu HF_TOKEN (Accept license FLUX.1-schnell trên Hub)", file=sys.stderr)
        sys.exit(1)

    print(f"[flux-download] cache root: {FLUX_CACHE_ROOT}", file=sys.stderr)
    print(
        f"[flux-download] Tải {MODEL_ID} (diffusers only, ~32–36 GiB, không tải bản single-file trùng 23.8GB)…",
        file=sys.stderr,
    )

    path = snapshot_download(
        MODEL_ID,
        token=token,
        allow_patterns=ALLOW_PATTERNS,
    )
    print(f"[flux-download] Done: {path}", file=sys.stderr)


if __name__ == "__main__":
    main()
