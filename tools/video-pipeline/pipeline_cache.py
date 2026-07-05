"""
Cache HF / torch cho OmniVoice, translate, voice TTS.

Mặc định: <repo>/tools/video-pipeline/cache/omnivoice
Ghi đè: OMNIVOICE_CACHE_ROOT hoặc KITLABS_PYTHON_CACHE_DIR

FLUX text-to-image: flux_cache.py → cache/flux (tách riêng).

  cache/
  ├── omnivoice/   ← pipeline_cache.py
  └── flux/        ← flux_cache.py
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
    if raw and raw not in ("/path", "path"):
        return Path(raw).expanduser().resolve()
    return _DEFAULT_CACHE_ROOT.resolve()


def _repair_cache_path(path: Path) -> None:
    """Xóa path nếu tồn tại nhưng không phải thư mục (gây FileExistsError Errno 17)."""
    if path.exists() and not path.is_dir():
        log.warning("cache path là file, xóa: %s", path)
        path.unlink()


def configure_omnivoice_cache_env() -> Path:
    """
    Đặt HF/torch cache → cache/omnivoice.

    Không mkdir `huggingface/` trước — HuggingFace tự tạo; tạo sẵn gây FileExistsError
    khi lib gọi os.mkdir(.../huggingface) không có exist_ok (đặc biệt với XDG_CACHE_HOME).
    """
    global _configured
    base = resolve_omnivoice_cache_root()
    hf_home = base / "huggingface"
    hub = hf_home / "hub"
    torch_home = base / "torch"

    base.mkdir(parents=True, exist_ok=True)
    torch_home.mkdir(parents=True, exist_ok=True)
    _repair_cache_path(hf_home)
    _repair_cache_path(hub)

    # Ghi đè env Nest/FLUX — subprocess Voice không dùng cache FLUX.
    os.environ["HF_HOME"] = str(hf_home)
    os.environ["HUGGINGFACE_HUB_CACHE"] = str(hub)
    os.environ["TRANSFORMERS_CACHE"] = str(hub)
    os.environ["TORCH_HOME"] = str(torch_home)
    # Không set XDG_CACHE_HOME=base — lib sẽ mkdir base/huggingface và đụng thư mục đã tạo sẵn.
    os.environ.pop("XDG_CACHE_HOME", None)

    if sys.platform == "win32":
        os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")
    else:
        os.environ.pop("HF_HUB_DISABLE_SYMLINKS", None)

    if not _configured:
        _configured = True
        log.debug(
            "omnivoice cache root=%s HF_HOME=%s HUB=%s",
            base,
            os.environ.get("HF_HOME", ""),
            os.environ.get("HUGGINGFACE_HUB_CACHE", ""),
        )
    return base


configure_omnivoice_cache_env()
