"""HF cache for narrato — same repo cache as recap, without importing recap."""

from __future__ import annotations

import logging
import os
import sys
import tempfile
from pathlib import Path

log = logging.getLogger("narrato.cache")

_PIPELINE_DIR = Path(__file__).resolve().parent.parent
_REPO_CACHE_ROOT = _PIPELINE_DIR / "cache"
_configured = False


def _is_writable(hub: Path) -> bool:
    try:
        hub.mkdir(parents=True, exist_ok=True)
        probe = hub / ".narrato_write_probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
        return True
    except Exception:
        return False


def resolve_cache_root() -> Path:
    override = (
        os.environ.get("NARRATO_HF_CACHE_DIR")
        or os.environ.get("RECAP_HF_CACHE_DIR")
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
    fallback = Path(tempfile.gettempdir()) / "kitlabs-narrato-cache"
    log.warning("repo cache not writable; fallback %s", fallback)
    return fallback


def configure() -> Path:
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
    os.environ.pop("XDG_CACHE_HOME", None)
    if (os.environ.get("HF_HUB_DISABLE_XET") or "").strip() == "":
        os.environ["HF_HUB_DISABLE_XET"] = "1"
    if sys.platform == "win32":
        os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")
    _configured = True
    return root


configure()
