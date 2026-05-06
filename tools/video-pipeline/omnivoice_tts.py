"""
OmniVoice Vietnamese TTS (splendor1811/omnivoice-vietnamese) — dùng cho Step3 trong auto_vietsub_pro.

Cài: pip install omnivoice
Tham khảo: https://huggingface.co/splendor1811/omnivoice-vietnamese
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional, Tuple

# Cache theo (model_id, device_map, dtype_str)
_session_model: Optional[Any] = None
_session_model_key: Optional[Tuple[str, str, str]] = None
# Cache prompt theo (resolved ref_audio, ref_text)
_session_prompt: Optional[Any] = None
_session_prompt_key: Optional[Tuple[str, str]] = None


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
    _session_model = OmniVoice.from_pretrained(
        mid,
        device_map=dev,
        dtype=dtype,
    )
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
        import torch
        import torchaudio
    except ImportError as e:
        raise RuntimeError("OmniVoice: cần torch + torchaudio để lưu WAV.") from e

    out = Path(out_wav)
    out.parent.mkdir(parents=True, exist_ok=True)

    model = _get_model(model_id=model_id, device_map=device_map, dtype_str=dtype_str)
    voice_prompt = ensure_voice_clone_prompt(
        ref_audio=ref_audio,
        ref_text=ref_text,
        model_id=model_id,
        device_map=device_map,
        dtype_str=dtype_str,
    )

    t = str(text or "").strip()
    if not t:
        raise ValueError("OmniVoice: text rỗng.")

    gen_kw: dict = dict(
        text=t,
        language=str(language or "vietnamese").strip() or "vietnamese",
        voice_clone_prompt=voice_prompt,
    )
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

    audio = model.generate(**gen_kw)
    # Model card có ví dụ audio[0], nhưng kiểu trả về có thể khác giữa versions
    # (Tensor/ndarray/list; mono/stereo; [T] hoặc [B,T] hoặc [B,C,T]).
    if isinstance(audio, torch.Tensor):
        wave = audio
    elif isinstance(audio, (list, tuple)) and len(audio) > 0:
        wave = audio[0]
    else:
        wave = audio

    if not isinstance(wave, torch.Tensor):
        wave = torch.as_tensor(wave)

    # Chuẩn hoá về [channels, time] để torchaudio.save dùng được.
    if wave.ndim == 0:
        wave = wave.unsqueeze(0).unsqueeze(0)
    elif wave.ndim == 1:
        wave = wave.unsqueeze(0)  # [T] -> [1, T]
    elif wave.ndim == 2:
        # Có thể là [B, T] hoặc [C, T]. Nếu batch đầu > 1, lấy sample đầu.
        if wave.shape[0] > 8 and wave.shape[1] <= 8:
            wave = wave.transpose(0, 1)
    else:
        # [B, C, T] / [B, T, C] -> lấy batch đầu, rồi đưa về [C, T]
        wave = wave[0]
        if wave.ndim == 2 and wave.shape[-1] <= 8 and wave.shape[0] > 8:
            wave = wave.transpose(0, 1)

    if wave.ndim != 2:
        raise RuntimeError(f"OmniVoice: shape audio không hợp lệ để lưu WAV: {tuple(wave.shape)}")

    wave = wave.detach().to(dtype=torch.float32).cpu().contiguous()
    torchaudio.save(str(out), wave, 24000)
