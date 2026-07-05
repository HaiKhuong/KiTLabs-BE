"""
Cache HF / torch riêng cho FLUX text-to-image (video_image_flux.py).

Tách khỏi cache/omnivoice — OmniVoice / translate giữ nguyên folder cũ.

Mặc định: <repo>/tools/video-pipeline/cache/flux
Ghi đè: FLUX_CACHE_ROOT (đường dẫn tuyệt đối khuyến nghị trên server).
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

if not logging.getLogger().handlers:
    logging.basicConfig(
        level=logging.WARNING,
        format="[flux-cache] %(message)s",
        stream=sys.stderr,
        force=True,
    )
log = logging.getLogger("flux-cache")

_PIPELINE_DIR = Path(__file__).resolve().parent
_DEFAULT_FLUX_CACHE_ROOT = _PIPELINE_DIR / "cache" / "flux"
_configured = False


def resolve_flux_cache_root() -> Path:
    raw = (os.getenv("FLUX_CACHE_ROOT") or "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    return _DEFAULT_FLUX_CACHE_ROOT.resolve()


def configure_flux_cache_env() -> Path:
    """Ghi đè HF/torch env cho process FLUX (folder riêng, không đụng omnivoice)."""
    global _configured
    base = resolve_flux_cache_root()
    base.mkdir(parents=True, exist_ok=True)

    hf_home = base / "huggingface"
    hub = hf_home / "hub"
    torch_home = base / "torch"
    torch_home.mkdir(parents=True, exist_ok=True)

    os.environ["HF_HOME"] = str(hf_home)
    os.environ["HUGGINGFACE_HUB_CACHE"] = str(hub)
    os.environ["TRANSFORMERS_CACHE"] = str(hub)
    os.environ["TORCH_HOME"] = str(torch_home)
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")

    if not _configured:
        _configured = True
        log.warning("flux cache root=%s HF_HOME=%s", base, hf_home)
    return base
