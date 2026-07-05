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
    if raw:
        return Path(raw).expanduser().resolve()
    return _DEFAULT_CACHE_ROOT.resolve()


def _ensure_cache_dir(path: Path) -> None:
    """Tạo thư mục cache; sửa khi path tồn tại nhưng là file (gây FileExistsError: Errno 17)."""
    if path.exists() and not path.is_dir():
        log.warning("cache path là file, xóa và tạo lại thư mục: %s", path)
        path.unlink()
    path.mkdir(parents=True, exist_ok=True)


def configure_omnivoice_cache_env() -> Path:
    """Đặt HF/torch cache → cache/omnivoice (ghi đè env Nest/FLUX kế thừa)."""
    global _configured
    base = resolve_omnivoice_cache_root()
    hf_home = base / "huggingface"
    hub = hf_home / "hub"
    torch_home = base / "torch"

    for path in (base, hf_home, hub, torch_home):
        _ensure_cache_dir(path)

    # Ghi đè — không dùng setdefault (Nest có thể set HF_HOME cho FLUX).
    os.environ["HF_HOME"] = str(hf_home)
    os.environ["HUGGINGFACE_HUB_CACHE"] = str(hub)
    os.environ["TRANSFORMERS_CACHE"] = str(hub)
    os.environ["TORCH_HOME"] = str(torch_home)
    os.environ["XDG_CACHE_HOME"] = str(base)

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
