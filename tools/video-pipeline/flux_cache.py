"""
Cache HF / torch cho FLUX text-to-image (riêng, không đụng pipeline_cache.py).

Mặc định: tools/video-pipeline/cache/flux (ngang hàng cache/omnivoice)
Token: HF_TOKEN
"""

from __future__ import annotations

import os
from pathlib import Path

_PIPELINE_DIR = Path(__file__).resolve().parent
FLUX_CACHE_ROOT = (_PIPELINE_DIR / "cache" / "flux").resolve()


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
    """HF/torch cache → cache/flux (cố định)."""
    base = FLUX_CACHE_ROOT
    hf_home = base / "huggingface"
    hub = hf_home / "hub"
    torch_home = base / "torch"
    for path in (hf_home, hub, torch_home):
        path.mkdir(parents=True, exist_ok=True)
    os.environ["HF_HOME"] = str(hf_home)
    os.environ["HUGGINGFACE_HUB_CACHE"] = str(hub)
    os.environ["TRANSFORMERS_CACHE"] = str(hf_home)
    os.environ["TORCH_HOME"] = str(torch_home)
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")
    resolve_hf_token()
    return base


configure_flux_cache_env()
