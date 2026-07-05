"""
Cache HF / torch riêng cho FLUX text-to-image (video_image_flux.py).

Tách khỏi cache/omnivoice — OmniVoice giữ nguyên pipeline_cache.py.

Ưu tiên:
  1. FLUX_CACHE_ROOT (env — Nest thường set uploads/flux-cache)
  2. $AUDIO_DATA_ROOT/flux-cache hoặc $UPLOAD_DIR/flux-cache
  3. <repo>/tools/video-pipeline/cache/flux
  4. /var/tmp/kitools-flux
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


def _ensure_writable_dir(path: Path) -> Path:
    resolved = path.expanduser().resolve()
    resolved.mkdir(parents=True, exist_ok=True)
    probe = resolved / ".write_probe"
    probe.write_text("ok", encoding="utf-8")
    probe.unlink(missing_ok=True)
    return resolved


def _fallback_candidates() -> list[Path]:
    out: list[Path] = []

    for key in ("AUDIO_DATA_ROOT", "KITLABS_AUDIO_DATA_ROOT", "UPLOAD_DIR"):
        raw = (os.getenv(key) or "").strip()
        if raw:
            out.append(Path(raw).expanduser() / "flux-cache")

    out.append(_DEFAULT_FLUX_CACHE_ROOT)
    out.append(Path("/var/tmp/kitools-flux"))
    return out


def resolve_flux_cache_root() -> Path:
    raw = (os.getenv("FLUX_CACHE_ROOT") or "").strip()
    if raw:
        return _ensure_writable_dir(Path(raw))

    errors: list[str] = []
    for candidate in _fallback_candidates():
        try:
            resolved = _ensure_writable_dir(candidate)
            if candidate == _DEFAULT_FLUX_CACHE_ROOT:
                log.warning("flux cache root=%s", resolved)
            else:
                log.warning(
                    "flux cache fallback → %s (repo cache/flux không ghi được)",
                    resolved,
                )
            return resolved
        except OSError as exc:
            errors.append(f"{candidate}: {exc}")

    raise PermissionError(
        "Không ghi được FLUX cache. Set FLUX_CACHE_ROOT trong .env Nest, ví dụ:\n"
        "  FLUX_CACHE_ROOT=/var/cache/kitools-flux\n"
        + "\n".join(errors)
    )


def configure_flux_cache_env() -> Path:
    """Ghi đè HF/torch env cho process FLUX (không đụng cache/omnivoice)."""
    global _configured
    base = resolve_flux_cache_root()

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
        log.warning("flux HF_HOME=%s", hf_home)
    return base
