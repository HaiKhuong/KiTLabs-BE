"""
Cache HF / torch cho OmniVoice, translate, voice TTS.

Mặc định: <repo>/tools/video-pipeline/cache/omnivoice
Ghi đè: OMNIVOICE_CACHE_ROOT hoặc KITLABS_PYTHON_CACHE_DIR

FLUX text-to-image cấu hình cache trong video_image_flux.py (cache/flux).

  cache/
  ├── omnivoice/   ← pipeline_cache.py
  └── flux/        ← video_image_flux.py
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

def _resolve_log_level() -> int:
    name = (os.getenv("OMNIVOICE_LOG_LEVEL") or "WARNING").strip().upper()
    return getattr(logging, name, logging.WARNING)


if not logging.getLogger().handlers:
    logging.basicConfig(
        level=_resolve_log_level(),
        format="[pipeline-cache] %(message)s",
        stream=sys.stderr,
        force=True,
    )
log = logging.getLogger("pipeline-cache")

_PIPELINE_DIR = Path(__file__).resolve().parent
_DEFAULT_CACHE_ROOT = _PIPELINE_DIR / "cache" / "omnivoice"
_configured = False


def resolve_omnivoice_cache_root() -> Path:
    raw = (
        os.getenv("OMNIVOICE_CACHE_ROOT")
        or os.getenv("KITLABS_PYTHON_CACHE_DIR")
        or ""
    ).strip()
    if raw:
        return Path(raw).expanduser().resolve()
    return _DEFAULT_CACHE_ROOT.resolve()


def configure_omnivoice_cache_env() -> Path:
    """Đặt HF_HOME / hub / torch về cùng một cây thư mục OmniVoice (idempotent)."""
    global _configured
    base = resolve_omnivoice_cache_root()
    hf_home = base / "huggingface"
    hub = hf_home / "hub"
    torch_home = base / "torch"
    hf_home.mkdir(parents=True, exist_ok=True)
    hub.mkdir(parents=True, exist_ok=True)
    torch_home.mkdir(parents=True, exist_ok=True)

    os.environ.setdefault("HF_HOME", str(hf_home))
    os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(hub))
    os.environ.setdefault("TRANSFORMERS_CACHE", str(hf_home))
    os.environ.setdefault("TORCH_HOME", str(torch_home))
    os.environ.setdefault("XDG_CACHE_HOME", str(base))
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")

    if not _configured:
        _configured = True
        log.debug(
            "omnivoice cache root=%s HF_HOME=%s HUB=%s",
            base,
            os.environ.get("HF_HOME", ""),
            os.environ.get("HUGGINGFACE_HUB_CACHE", ""),
        )
    return base


# Import từ script OmniVoice / voice workflow.
configure_omnivoice_cache_env()
