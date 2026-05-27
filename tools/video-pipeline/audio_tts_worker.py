"""Shared OmniVoice TTS invocation for CLI and long-running daemon."""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any, Optional


def resolve_device_map(raw: str) -> str:
    s = str(raw or "").strip()
    if s:
        return s
    try:
        import torch

        return "cuda:0" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def run_synthesis(
    *,
    text: str,
    out: str,
    ref_audio: str,
    ref_text: str = "",
    model_id: str = "",
    device_map: str = "",
    dtype: str = "float16",
    language: str = "vietnamese",
    num_step: int = 8,
    guidance_scale: float = 2.0,
    seed: Optional[int] = None,
) -> str:
    from omnivoice_tts import synthesize_to_wav

    mid = str(model_id or os.getenv("OMNIVOICE_MODEL_ID", "k2-fsa/OmniVoice")).strip()
    if not mid:
        raise ValueError("model_id is empty")

    ref_path = str(Path(ref_audio).resolve())
    if not Path(ref_path).is_file():
        raise FileNotFoundError(f"ref_audio not found: {ref_path}")

    out_path = Path(out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    dev = resolve_device_map(device_map)

    synthesize_to_wav(
        text=str(text or ""),
        out_wav=str(out_path),
        ref_audio=ref_path,
        ref_text=str(ref_text or ""),
        model_id=mid,
        device_map=dev,
        dtype_str=str(dtype or "float16"),
        language=str(language or "vietnamese"),
        num_step=int(num_step) if num_step is not None else 8,
        guidance_scale=float(guidance_scale) if guidance_scale is not None else 2.0,
        seed=int(seed) if seed is not None else None,
    )
    return str(out_path.resolve())


def run_synthesis_from_payload(payload: dict[str, Any]) -> str:
    seed_raw = payload.get("seed")
    seed: Optional[int] = int(seed_raw) if seed_raw is not None and str(seed_raw).strip() != "" else None
    return run_synthesis(
        text=str(payload.get("text") or ""),
        out=str(payload.get("out") or ""),
        ref_audio=str(payload.get("ref_audio") or ""),
        ref_text=str(payload.get("ref_text") or ""),
        model_id=str(payload.get("model_id") or ""),
        device_map=str(payload.get("device_map") or ""),
        dtype=str(payload.get("dtype") or "float16"),
        language=str(payload.get("language") or "vietnamese"),
        num_step=int(payload.get("num_step") or 8),
        guidance_scale=float(payload.get("guidance_scale") or 2.0),
        seed=seed,
    )
