"""
OmniVoice Vietnamese TTS (splendor1811/omnivoice-vietnamese) — dùng cho Step3 trong auto_vietsub_pro.

Cài: pip install omnivoice
Tham khảo: https://huggingface.co/splendor1811/omnivoice-vietnamese
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Optional, Tuple

# Cache theo (model_id, device_map, dtype_str)
_session_model: Optional[Any] = None
_session_model_key: Optional[Tuple[str, str, str]] = None
# Cache prompt theo (resolved ref_audio, ref_text)
_session_prompt: Optional[Any] = None
_session_prompt_key: Optional[Tuple[str, str]] = None


def _resolve_hf_token() -> str:
    # Ưu tiên HF_TOKEN; fallback các tên env phổ biến.
    token = (
        os.getenv("HF_TOKEN")
        or os.getenv("HUGGINGFACE_HUB_TOKEN")
        or os.getenv("HUGGING_FACE_HUB_TOKEN")
        or ""
    )
    token = str(token).strip()
    if token:
        # Đồng bộ để các lib HF downstream dùng cùng token.
        os.environ.setdefault("HF_TOKEN", token)
        os.environ.setdefault("HUGGINGFACE_HUB_TOKEN", token)
    return token


def reset_omnivoice_session() -> None:
    """Xoá cache model/prompt (vd. đổi checkpoint hoặc giọng mẫu giữa các lần chạy trong cùng process)."""
    global _session_model, _session_model_key, _session_prompt, _session_prompt_key
    _session_model = None
    _session_model_key = None
    _session_prompt = None
    _session_prompt_key = None


def _resolve_dtype(dtype_str: str):
    import torch

    s = (dtype_str or "float16").strip().lower()
    if s in ("float16", "fp16"):
        return torch.float16
    if s in ("bfloat16", "bf16"):
        return torch.bfloat16
    if s in ("float32", "fp32"):
        return torch.float32
    raise ValueError(f"omnivoice: dtype không hỗ trợ: {dtype_str!r}")


def _get_model(*, model_id: str, device_map: str, dtype_str: str):
    global _session_model, _session_model_key
    try:
        import torch
        from omnivoice import OmniVoice
    except ImportError as e:
        raise RuntimeError(
            "OmniVoice: cần gói omnivoice (pip install omnivoice). "
            "Xem https://huggingface.co/splendor1811/omnivoice-vietnamese"
        ) from e

    mid = str(model_id or "").strip()
    if not mid:
        raise ValueError("omnivoice: model_id rỗng.")
    dev = str(device_map or "cuda:0").strip() or "cuda:0"
    dt = str(dtype_str or "float16").strip() or "float16"
    key = (mid, dev, dt)
    if _session_model is not None and _session_model_key == key:
        return _session_model

    global _session_prompt, _session_prompt_key
    _session_prompt = None
    _session_prompt_key = None

    dtype = _resolve_dtype(dt)
    hf_token = _resolve_hf_token()
    load_kwargs = dict(
        device_map=dev,
        dtype=dtype,
    )
    if hf_token:
        # Một số bản nhận `token`, số khác nhận `use_auth_token`.
        load_kwargs["token"] = hf_token
    try:
        _session_model = OmniVoice.from_pretrained(
            mid,
            **load_kwargs,
        )
    except TypeError:
        if hf_token:
            load_kwargs.pop("token", None)
            load_kwargs["use_auth_token"] = hf_token
            _session_model = OmniVoice.from_pretrained(
                mid,
                **load_kwargs,
            )
        else:
            raise
    _session_model_key = key
    return _session_model


def ensure_voice_clone_prompt(
    *,
    ref_audio: str | Path,
    ref_text: str,
    model_id: str,
    device_map: str,
    dtype_str: str,
) -> Any:
    """Tạo / cache voice_clone_prompt từ file giọng mẫu + transcript (nên transcript khớp audio)."""
    global _session_prompt, _session_prompt_key
    ra = str(Path(ref_audio).resolve())
    if not Path(ra).is_file():
        raise FileNotFoundError(f"OmniVoice: không tìm thấy ref_audio: {ra}")
    rt = str(ref_text or "")
    pk = (ra, rt)
    if _session_prompt is not None and _session_prompt_key == pk:
        return _session_prompt

    model = _get_model(model_id=model_id, device_map=device_map, dtype_str=dtype_str)
    _session_prompt = model.create_voice_clone_prompt(ref_audio=ra, ref_text=rt)
    _session_prompt_key = pk
    return _session_prompt


def synthesize_to_wav(
    *,
    text: str,
    out_wav: str | Path,
    ref_audio: str | Path,
    ref_text: str,
    model_id: str,
    device_map: str,
    dtype_str: str = "float16",
    language: str = "vietnamese",
    num_step: Optional[int] = 8,
    guidance_scale: Optional[float] = 2.0,
) -> None:
    """
    Sinh một đoạn thoại, ghi WAV mono 24 kHz (theo model card).
    Dùng cached model + voice prompt khi ref_audio/ref_text/model không đổi.
    """
    try:
        import numpy as np
        import soundfile as sf
        import torch
    except ImportError as e:
        raise RuntimeError(
            "OmniVoice: cần torch + soundfile để lưu WAV (pip install soundfile)."
        ) from e

    out = Path(out_wav)
    out.parent.mkdir(parents=True, exist_ok=True)

    model = _get_model(model_id=model_id, device_map=device_map, dtype_str=dtype_str)
    ref_audio_path = str(Path(ref_audio).resolve())
    if not Path(ref_audio_path).is_file():
        raise FileNotFoundError(f"OmniVoice: không tìm thấy ref_audio: {ref_audio_path}")

    t = str(text or "").strip()
    if not t:
        raise ValueError("OmniVoice: text rỗng.")

    gen_kw: dict = dict(
        text=t,
        ref_audio=ref_audio_path,
    )
    rt = str(ref_text or "").strip()
    if rt:
        gen_kw["ref_text"] = rt

    lang = str(language or "").strip()
    if lang:
        gen_kw["language"] = lang
    if (
        num_step is not None
        and guidance_scale is not None
        and int(num_step) > 0
    ):
        try:
            from omnivoice import OmniVoiceGenerationConfig

            gen_kw["generation_config"] = OmniVoiceGenerationConfig(
                num_step=int(num_step),
                guidance_scale=float(guidance_scale),
            )
        except Exception:
            # Một số phiên bản có thể khác tên / không có class — gọi generate mặc định.
            pass

    try:
        audio = model.generate(**gen_kw)
    except TypeError:
        # Một số bản OmniVoice không nhận language / generation_config.
        slim_kw = {"text": t, "ref_audio": ref_audio_path}
        if rt:
            slim_kw["ref_text"] = rt
        audio = model.generate(**slim_kw)

    # Theo mẫu official: audio là list[np.ndarray] shape (T,) at 24kHz.
    if isinstance(audio, (list, tuple)) and len(audio) > 0:
        wave = audio[0]
    else:
        wave = audio

    if isinstance(wave, torch.Tensor):
        wave_np = wave.detach().to(dtype=torch.float32).cpu().numpy()
    else:
        wave_np = np.asarray(wave, dtype=np.float32)

    if wave_np.ndim == 0:
        raise RuntimeError("OmniVoice: audio output rỗng/không hợp lệ (scalar).")
    if wave_np.ndim > 1:
        # Giữ theo mẫu out mono: [T]. Nếu có batch/channel thì dẹt về 1 chiều.
        wave_np = wave_np.reshape(-1)

    sf.write(str(out), wave_np, 24000)
