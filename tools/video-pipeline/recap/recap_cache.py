"""HF / torch cache cho recap pipeline — CỐ ĐỊNH tại repo cache:
  tools/video-pipeline/cache/huggingface/hub

Mục tiêu:
  * Mọi model HF (OpenCLIP ViT-B-32, faster-whisper…) nằm MỘT chỗ trong repo cache.
  * Tái sử dụng model đã tải (KHÔNG tải lại).
  * Không rải cache ra ~/.cache (/var/www/.cache) hay chỗ khác.

Cách dùng: `import recap_cache  # noqa: F401` ở DÒNG ĐẦU mọi entrypoint recap,
TRƯỚC khi import torch / open_clip / faster_whisper / transformers.

Nếu tiến trình không ghi được repo cache (Errno 13) → sửa quyền OS:
  chown -R <user_chay_nest> tools/video-pipeline/cache
(fallback /tmp chỉ để không crash; sẽ phải tải lại ở tmp.)
"""

from __future__ import annotations

import logging
import os
import sys
import tempfile
from pathlib import Path

log = logging.getLogger("recap.cache")

# recap/ → video-pipeline/ → video-pipeline/cache
_PIPELINE_DIR = Path(__file__).resolve().parent.parent
_REPO_CACHE_ROOT = _PIPELINE_DIR / "cache"

_configured = False


def _is_writable(hub: Path) -> bool:
    """True nếu có thể tạo/ghi file trong hub (kể cả khi hub đã tồn tại do user khác tạo)."""
    try:
        hub.mkdir(parents=True, exist_ok=True)
        probe = hub / ".recap_write_probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
        return True
    except Exception:
        return False


def resolve_cache_root() -> Path:
    """Repo cache là chính; cho phép override; fallback /tmp nếu Permission denied."""
    override = (
        os.environ.get("RECAP_HF_CACHE_DIR")
        or os.environ.get("KITLABS_PYTHON_CACHE_DIR")
        or ""
    ).strip()
    candidates: list[Path] = []
    if override and override not in ("/path", "path"):
        candidates.append(Path(override).expanduser().resolve())
    candidates.append(_REPO_CACHE_ROOT.resolve())

    for root in candidates:
        if _is_writable(root / "huggingface" / "hub"):
            return root

    fallback = Path(tempfile.gettempdir()) / "kitlabs-recap-cache"
    log.warning(
        "repo cache %s không ghi được (Permission denied) → fallback %s "
        "(sẽ tải lại; sửa quyền: chown -R <user> %s)",
        _REPO_CACHE_ROOT,
        fallback,
        _REPO_CACHE_ROOT,
    )
    return fallback


def configure() -> Path:
    """Đặt HF_HOME / HUGGINGFACE_HUB_CACHE / TRANSFORMERS_CACHE / TORCH_HOME → repo cache."""
    global _configured
    root = resolve_cache_root()
    hf_home = root / "huggingface"
    hub = hf_home / "hub"
    torch_home = root / "torch"

    hub.mkdir(parents=True, exist_ok=True)
    torch_home.mkdir(parents=True, exist_ok=True)

    os.environ["HF_HOME"] = str(hf_home)
    os.environ["HUGGINGFACE_HUB_CACHE"] = str(hub)
    os.environ["TRANSFORMERS_CACHE"] = str(hub)
    os.environ["TORCH_HOME"] = str(torch_home)
    # Không ép XDG_CACHE_HOME (tránh lib mkdir base/huggingface gây Errno 17/13).
    os.environ.pop("XDG_CACHE_HOME", None)

    # XET session hay Permission denied trên Linux → dùng HTTP download thường.
    if (os.environ.get("HF_HUB_DISABLE_XET") or "").strip() == "":
        os.environ["HF_HUB_DISABLE_XET"] = "1"

    if sys.platform == "win32":
        os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")

    if not _configured:
        _configured = True
        log.debug("recap cache HF_HOME=%s HUB=%s", hf_home, hub)
    return root


configure()
