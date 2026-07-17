"""
Cache HF / torch chung cho pipeline (Whisper, OmniVoice, VoxCPM2, Translate, Image…).

Một root duy nhất:
  tools/video-pipeline/cache/
  ├── huggingface/hub/   ← HF models (whisper, omnivoice, voxcpm2, flux, z-image…)
  └── torch/

Ghi đè: KITLABS_PYTHON_CACHE_DIR hoặc OMNIVOICE_CACHE_ROOT (legacy alias).

Import sớm ở mọi entrypoint Python để tránh tải về ~/.cache/huggingface.
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
_DEFAULT_CACHE_ROOT = _PIPELINE_DIR / "cache"
_configured = False


def resolve_pipeline_cache_root() -> Path:
    raw = (
        os.getenv("KITLABS_PYTHON_CACHE_DIR")
        or os.getenv("OMNIVOICE_CACHE_ROOT")  # legacy alias
        or ""
    ).strip()
    if raw and raw not in ("/path", "path"):
        return Path(raw).expanduser().resolve()
    return _DEFAULT_CACHE_ROOT.resolve()


# Alias cũ — một số script vẫn gọi tên này.
def resolve_omnivoice_cache_root() -> Path:
    return resolve_pipeline_cache_root()


def _repair_cache_path(path: Path) -> None:
    """Xóa path nếu tồn tại nhưng không phải thư mục (file/symlink hỏng → FileExistsError Errno 17)."""
    if path.is_symlink() or (path.exists() and not path.is_dir()):
        log.warning("cache path không phải thư mục, xóa: %s", path)
        path.unlink()


def configure_pipeline_cache_env() -> Path:
    """
    Đặt HF/torch cache → tools/video-pipeline/cache (một chỗ).

    Không mkdir `huggingface/` trước — HuggingFace tự tạo; tạo sẵn gây FileExistsError
    khi lib gọi os.mkdir(.../huggingface) không có exist_ok (đặc biệt với XDG_CACHE_HOME).
    """
    global _configured
    base = resolve_pipeline_cache_root()
    hf_home = base / "huggingface"
    hub = hf_home / "hub"
    torch_home = base / "torch"

    base.mkdir(parents=True, exist_ok=True)
    torch_home.mkdir(parents=True, exist_ok=True)
    _repair_cache_path(hf_home)
    _repair_cache_path(hub)

    os.environ["HF_HOME"] = str(hf_home)
    os.environ["HUGGINGFACE_HUB_CACHE"] = str(hub)
    os.environ["TRANSFORMERS_CACHE"] = str(hub)
    os.environ["TORCH_HOME"] = str(torch_home)
    # Không ép XDG_CACHE_HOME về $HOME — trùng cache ngoài repo.
    # Không set XDG_CACHE_HOME=base — lib mkdir base/huggingface dễ Errno 17.
    os.environ.pop("XDG_CACHE_HOME", None)

    # huggingface_hub xet_get hay gặp Permission denied (os error 13) trên Linux
    # khi cache/xet session không ghi được. Mặc định tắt XET → HTTP download thường.
    # Bật lại: HF_HUB_DISABLE_XET=0
    if (os.getenv("HF_HUB_DISABLE_XET") or "").strip() == "":
        os.environ["HF_HUB_DISABLE_XET"] = "1"

    if sys.platform == "win32":
        os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")
    else:
        os.environ.pop("HF_HUB_DISABLE_SYMLINKS", None)

    if not _configured:
        _configured = True
        log.debug(
            "pipeline cache root=%s HF_HOME=%s HUB=%s",
            base,
            os.environ.get("HF_HOME", ""),
            os.environ.get("HUGGINGFACE_HUB_CACHE", ""),
        )
    return base


# Alias cũ.
def configure_omnivoice_cache_env() -> Path:
    return configure_pipeline_cache_env()


configure_pipeline_cache_env()
