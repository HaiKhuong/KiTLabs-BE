"""
Cache HF / torch cho FLUX / Z-Image — dùng chung pipeline_cache (một root).

Mặc định: tools/video-pipeline/cache/huggingface/hub
Token: HF_TOKEN
"""

from __future__ import annotations

import os
from pathlib import Path

import pipeline_cache  # noqa: F401 — set HF_* trước khi import diffusers

from pipeline_cache import resolve_pipeline_cache_root

FLUX_CACHE_ROOT = resolve_pipeline_cache_root()


def resolve_hf_token() -> str | None:
    token = (
        os.getenv("HF_TOKEN")
        or os.getenv("HUGGINGFACE_HUB_TOKEN")
        or os.getenv("HUGGING_FACE_HUB_TOKEN")
        or ""
    )
    token = str(token).strip()
    if token:
        os.environ.setdefault("HF_TOKEN", token)
        os.environ.setdefault("HUGGINGFACE_HUB_TOKEN", token)
    return token or None


def configure_flux_cache_env() -> Path:
    """Alias — cache đã cấu hình bởi pipeline_cache."""
    resolve_hf_token()
    return FLUX_CACHE_ROOT


configure_flux_cache_env()
