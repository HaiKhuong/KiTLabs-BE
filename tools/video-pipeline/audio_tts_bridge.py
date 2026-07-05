"""Shared OmniVoice synthesize entry — dùng bởi daemon và CLI one-shot."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict


def run_synthesize_payload(payload: Dict[str, Any]) -> None:
    mode = str(payload.get("mode") or "pauses").strip().lower()
    if mode == "direct":
        _synthesize_direct(payload)
    else:
        _synthesize_with_pauses(payload)

    out_wav = Path(str(payload["out_wav"]))
    if not out_wav.is_file() or out_wav.stat().st_size <= 0:
        raise RuntimeError(f"OmniVoice did not produce output: {out_wav}")


def _resolve_device_map(raw: str) -> str:
    s = str(raw or "").strip()
    if s:
        return s
    try:
        import torch

        return "cuda:0" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def _synthesize_direct(payload: Dict[str, Any]) -> None:
    from audio_tts_with_pauses import _apply_playback_speed, _prepare_ref_audio_for_omnivoice, _resolve_playback_speed
    from audio_tts_worker import run_synthesis

    out = Path(str(payload["out_wav"]))
    ref_prepared = _prepare_ref_audio_for_omnivoice(str(payload["ref_audio"]))
    run_synthesis(
        text=str(payload.get("text") or ""),
        out=str(out),
        ref_audio=str(ref_prepared),
        ref_text=str(payload.get("ref_text") or ""),
        model_id=str(payload.get("model_id") or os.getenv("OMNIVOICE_MODEL_ID", "k2-fsa/OmniVoice")),
        device_map=_resolve_device_map(str(payload.get("device_map") or "")),
        dtype=str(payload.get("dtype_str") or payload.get("dtype") or "float16"),
        language=str(payload.get("language") or "vietnamese"),
        num_step=int(payload.get("num_step") or 8),
        guidance_scale=float(payload.get("guidance_scale") or 2.0),
        seed=payload.get("seed"),
    )
    speed = _resolve_playback_speed(payload.get("playback_speed"))
    _apply_playback_speed(out, speed)


def _synthesize_with_pauses(payload: Dict[str, Any]) -> None:
    from audio_tts_with_pauses import synthesize_with_pause_settings

    kwargs = {k: v for k, v in payload.items() if v is not None and k != "mode"}
    synthesize_with_pause_settings(**kwargs)
