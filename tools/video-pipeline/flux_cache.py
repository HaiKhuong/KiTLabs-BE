"""
Cache HF / torch riêng cho FLUX — ngang hàng cache/omnivoice (cùng cây cache/).

Mặc định: <repo>/tools/video-pipeline/cache/flux
Ghi đè: FLUX_CACHE_ROOT hoặc KITLABS_FLUX_CACHE_DIR

Cấu trúc (song song omnivoice):
  cache/
  ├── omnivoice/   ← pipeline_cache.py
  └── flux/        ← file này
      ├── huggingface/hub/
      └── torch/
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
_CACHE_DIR = _PIPELINE_DIR / "cache"
_DEFAULT_FLUX_CACHE_ROOT = _CACHE_DIR / "flux"
_configured = False


def resolve_flux_cache_root() -> Path:
    raw = (
        os.getenv("FLUX_CACHE_ROOT")
        or os.getenv("KITLABS_FLUX_CACHE_DIR")
        or ""
    ).strip()
    if raw:
        return Path(raw).expanduser().resolve()
    return _DEFAULT_FLUX_CACHE_ROOT.resolve()


def configure_flux_cache_env() -> Path:
    """HF/torch env cho FLUX — cache/flux (không dùng cache/omnivoice)."""
    global _configured
    base = resolve_flux_cache_root()
    hf_home = base / "huggingface"
    hub = hf_home / "hub"
    torch_home = base / "torch"
    hf_home.mkdir(parents=True, exist_ok=True)
    hub.mkdir(parents=True, exist_ok=True)
    torch_home.mkdir(parents=True, exist_ok=True)

    os.environ["HF_HOME"] = str(hf_home)
    os.environ["HUGGINGFACE_HUB_CACHE"] = str(hub)
    os.environ["TRANSFORMERS_CACHE"] = str(hf_home)
    os.environ["TORCH_HOME"] = str(torch_home)
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")

    if not _configured:
        _configured = True
        log.debug("flux cache root=%s HF_HOME=%s HUB=%s", base, hf_home, hub)
    return base
