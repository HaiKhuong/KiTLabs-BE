"""Windows: CTranslate2/faster-whisper cần cublas64_12.dll trên DLL search path.

PyTorch cu12x đã ship DLL đó trong site-packages/torch/lib, nhưng CTranslate2
không đọc thư mục đó. Máy chỉ có driver CUDA 13 (không cài CUDA Toolkit) sẽ
lỗi "cublas64_12.dll is not found" rồi Whisper rơi CPU.
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

log = logging.getLogger("cuda-dlls")
_registered: list[str] = []


def _prepend_path(directory: str) -> None:
    current = os.environ.get("PATH", "")
    parts = current.split(os.pathsep) if current else []
    if directory in parts:
        return
    os.environ["PATH"] = directory + (os.pathsep + current if current else "")


def _add_dir(directory: Path) -> None:
    if not directory.is_dir():
        return
    resolved = str(directory.resolve())
    if resolved in _registered:
        return
    _prepend_path(resolved)
    if sys.platform == "win32" and hasattr(os, "add_dll_directory"):
        try:
            os.add_dll_directory(resolved)
        except OSError as exc:
            log.debug("add_dll_directory failed %s: %s", resolved, exc)
            return
    _registered.append(resolved)


def _candidate_dirs() -> list[Path]:
    dirs: list[Path] = []
    try:
        import torch

        dirs.append(Path(torch.__file__).resolve().parent / "lib")
    except Exception:
        pass
    try:
        import ctranslate2

        dirs.append(Path(ctranslate2.__file__).resolve().parent)
    except Exception:
        pass
    cuda_home = (os.environ.get("CUDA_PATH") or os.environ.get("CUDA_HOME") or "").strip()
    if cuda_home:
        dirs.append(Path(cuda_home) / "bin")
    site = Path(sys.prefix) / "Lib" / "site-packages"
    for rel in (
        Path("nvidia") / "cublas" / "bin",
        Path("nvidia") / "cuda_runtime" / "bin",
        Path("nvidia") / "cudnn" / "bin",
    ):
        dirs.append(site / rel)
    return dirs


def ensure_windows_cuda_dlls() -> list[str]:
    """Register CUDA 12 runtime DLLs so CTranslate2 can use GPU on Windows."""
    if sys.platform != "win32":
        return list(_registered)
    for directory in _candidate_dirs():
        marker = directory / "cublas64_12.dll"
        sibling = directory / "ctranslate2.dll"
        if marker.is_file() or sibling.is_file() or directory.name.lower() == "bin":
            _add_dir(directory)
        elif directory.is_dir() and any(directory.glob("cublas*.dll")):
            _add_dir(directory)
    if _registered:
        log.debug("CUDA DLL dirs: %s", _registered)
    return list(_registered)


ensure_windows_cuda_dlls()
