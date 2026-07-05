"""
Cache HF / torch cho FLUX text-to-image (riêng, không đụng pipeline_cache.py).

Mặc định: tools/video-pipeline/cache/flux (ngang hàng cache/omnivoice)
Token: HF_TOKEN

Kích thước kỳ vọng (Linux + symlink): ~23–34 GiB cho FLUX.1-schnell (một revision).
Tránh HF_HUB_DISABLE_SYMLINKS trên Linux — mỗi lần tải/revision sẽ COPY full file → 2×–3× disk.
"""

from __future__ import annotations

import os
import sys
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
    # Cùng cây với hub — tránh tải model 2 lần (hub + thư mục transformers legacy dưới HF_HOME).
    os.environ["TRANSFORMERS_CACHE"] = str(hub)
    os.environ["TORCH_HOME"] = str(torch_home)

    # Chỉ Windows cần tắt symlink. Linux/WSL: BẮT BUỘC symlink để blobs dedup (~23GB, không phải 54GB+).
    if sys.platform == "win32":
        os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")
    else:
        os.environ.pop("HF_HUB_DISABLE_SYMLINKS", None)

    resolve_hf_token()
    return base


configure_flux_cache_env()
