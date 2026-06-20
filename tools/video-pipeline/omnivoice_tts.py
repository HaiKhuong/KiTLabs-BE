"""
OmniVoice Vietnamese TTS (splendor1811/omnivoice-vietnamese) — dùng cho Step3 trong auto_vietsub_pro.

Cài: pip install omnivoice
Tham khảo: https://huggingface.co/splendor1811/omnivoice-vietnamese

⚠️ QUAN TRỌNG - VOICE CONSISTENCY:
- Module này sử dụng CACHING để đảm bảo tone giọng ổn định giữa các câu
- Voice clone prompt được tạo một lần và tái sử dụng cho tất cả các câu
- KHÔNG reset cache giữa các câu trong cùng một video để giữ tone giọng nhất quán
- Chỉ reset cache khi cần đổi giọng mẫu: reset_omnivoice_session()

📝 CÁCH HOẠT ĐỘNG:
1. Lần đầu tiên gọi synthesize_to_wav() với ref_audio/ref_text:
   - Model được load và cache (theo model_id, device, dtype)
   - Voice clone prompt được tạo và cache (theo ref_audio path + ref_text)
2. Các lần gọi tiếp theo với cùng ref_audio/ref_text:
   - Tái sử dụng model và voice prompt đã cache
   - Đảm bảo tone giọng nhất quán 100%
3. Nếu đổi ref_audio hoặc ref_text:
   - Voice prompt tự động được tạo lại và cache mới
   - Model vẫn được giữ nếu model_id/device/dtype không đổi
"""

from __future__ import annotations

import os
import re
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


def ensure_tts_trailing_period(text: str) -> str:
    """Đảm bảo mọi câu TTS kết thúc bằng đúng một dấu chấm."""
    t = str(text or "").strip()
    if not t:
        return t
    t = re.sub(r"[,，、;；:：!?！？…\-–—]+$", "", t).rstrip()
    if not t:
        return t
    t = re.sub(r"\.+$", ".", t)
    if not t.endswith("."):
        t = f"{t}."
    return t


def _normalize_tts_text_for_audio(text: str) -> str:
    """
    Chuẩn hóa text trước khi TTS:
    - Bỏ dấu ngoặc kép (ASCII và typographic thường gặp).
    - Thay : ; ? ! trong câu bằng dấu chấm để model ngắt nhịp / ngắt câu ổn định hơn.
    - Gộp nhiều chấm liên tiếp; cuối đoạn gom các dấu câu lặp về một dấu chấm.
    - Luôn kết thúc bằng một dấu chấm.
    """
    t = str(text or "").strip()
    if not t:
        return t
    for q in ('"', "\u201c", "\u201d", "\u2018", "\u2019", "\u00ab", "\u00bb"):
        t = t.replace(q, "")
    for p in (":", ";", "?", "!"):
        t = t.replace(p, ".")
    t = re.sub(r"\.(?:\s*\.)+", ".", t)
    t = re.sub(r"[!?.,:;…\-–—]+$", ".", t)
    return ensure_tts_trailing_period(t)


def apply_omnivoice_lexical_replacements(text: str) -> str:
    """
    Thay token OmniVoice đọc kém — luôn gọi **trước** ``.lower()``.

    Rule đã chốt:
    1. ``%`` → phần trăm
    2. ``AI`` (uppercase, từ riêng) → ây ai
    2b. ``NPC`` / ``npc`` (từ riêng) → Nờ Bi Xi
    3. ``&`` → và
    4. ``$`` → đô
    6. ``km/h`` → ki lô mét trên giờ; ``km`` (còn lại) → ki lô mét
    9. ``OK`` / ``ok`` → ô kê
    10. Wi‑Fi / WiFi → wai fai; ``4G`` → 4 gờ; ``5G`` → 5 gờ
    14. ``AM`` / ``PM`` (chỉ chữ hoa) → sáng / chiều
    15. ``24/7`` → 24 trên 7
    """
    t = str(text or "")
    if not t.strip():
        return t

    # 15 — trước các pattern có dấu /
    t = re.sub(r"\b24\s*/\s*7\b", "24 trên 7", t)

    # 10 — Wi‑Fi (gạch thường / non-breaking hyphen)
    t = re.sub(r"\bWi\s*[-\u2011]?\s*Fi\b", "wai fai", t, flags=re.IGNORECASE)
    t = re.sub(r"\b4G\b", "4 gờ", t)
    t = re.sub(r"\b5G\b", "5 gờ", t)

    # 14 — AM/PM chỉ chữ HOA (9 AM, 9AM, 9 A.M.)
    t = re.sub(r"(?<=\d)\s*AM\b", " sáng", t)
    t = re.sub(r"(?<=\d)\s*PM\b", " chiều", t)
    t = re.sub(r"\bA\.?\s*M\.?\b", "sáng", t)
    t = re.sub(r"\bP\.?\s*M\.?\b", "chiều", t)

    # 9, 2 — từ viết tắt
    t = re.sub(r"\b[oO][kK]\b", "ô kê", t)
    t = re.sub(r"\bAI\b", "ây ai", t)
    t = re.sub(r"\bNPC\b", "Nờ Bi Xi", t, flags=re.IGNORECASE)

    # 6 — km/h trước km đơn
    t = re.sub(
        r"(?<=\d)\s*km\s*/\s*h\b",
        " ki lô mét trên giờ",
        t,
        flags=re.IGNORECASE,
    )
    t = re.sub(r"\bkm\s*/\s*h\b", "ki lô mét trên giờ", t, flags=re.IGNORECASE)
    t = re.sub(r"(?<=\d)\s*km\b", " ki lô mét", t, flags=re.IGNORECASE)
    t = re.sub(r"\bkm\b", "ki lô mét", t, flags=re.IGNORECASE)

    # 1, 3, 4
    t = t.replace("%", " phần trăm ")
    t = t.replace("&", " và ")
    t = t.replace("$", " đô ")

    t = re.sub(r"\s+", " ", t).strip()
    return t


def prepare_omnivoice_input_text(text: str) -> str:
    """Replace lexical → lowercase → chuẩn hóa dấu câu (pipeline chung Audio + auto_vietsub)."""
    t = apply_omnivoice_lexical_replacements(text)
    t = t.lower()
    return _normalize_tts_text_for_audio(t)


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
    """
    Tạo / cache voice_clone_prompt từ file giọng mẫu + transcript.
    
    ⚠️ QUAN TRỌNG - VOICE CONSISTENCY:
    Đây là KEY để đảm bảo tone giọng nhất quán giữa các câu!
    
    Voice clone prompt chứa embedding của đặc trưng giọng nói từ ref_audio.
    Bằng cách tạo và cache prompt này một lần duy nhất, tất cả các câu sau đó
    sẽ sử dụng cùng một embedding → tone giọng giữ nguyên 100%.
    
    Nếu mỗi lần generate đều encode lại từ raw audio thì:
    - Neural network có tính stochastic → embedding hơi khác mỗi lần
    - Dẫn đến tone giọng "nhảy" giữa các câu
    
    Cache key: (resolved ref_audio path, ref_text)
    - Chỉ tạo lại khi đổi file audio mẫu hoặc transcript
    - Cùng file audio + transcript → tái sử dụng prompt đã cache
    
    Args:
        ref_audio: Đường dẫn file audio mẫu (nên là transcript khớp với audio)
        ref_text: Transcript của audio mẫu (giúp model align tốt hơn)
        model_id: HuggingFace model ID
        device_map: Device để chạy model
        dtype_str: Data type của model
        
    Returns:
        Cached voice clone prompt object (dùng cho model.generate())
    """
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
    seed: Optional[int] = None,
) -> None:
    """
    Sinh một đoạn thoại, ghi WAV mono 24 kHz (theo model card).
    Dùng cached model + voice prompt khi ref_audio/ref_text/model không đổi.
    
    ✨ QUAN TRỌNG: Sử dụng cached voice_clone_prompt để đảm bảo tone giọng ổn định giữa các câu.
    
    Args:
        text: Nội dung cần tổng hợp giọng nói
        out_wav: Đường dẫn file WAV output
        ref_audio: File audio mẫu để clone giọng (sẽ được cache)
        ref_text: Transcript của audio mẫu (sẽ được cache cùng ref_audio)
        model_id: HuggingFace model ID
        device_map: Device để chạy model (cuda:0, cpu, etc.)
        dtype_str: Data type (float16, bfloat16, float32)
        language: Ngôn ngữ (vietnamese, english, etc.)
        num_step: Số bước generation (càng cao càng chất lượng nhưng chậm hơn)
        guidance_scale: Độ mạnh của guidance (càng cao càng sát prompt nhưng ít tự nhiên)
        seed: Random seed để tạo output deterministic (giúp tái tạo chính xác cùng output)
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

    t = prepare_omnivoice_input_text(text)
    if not t:
        raise ValueError("OmniVoice: text rỗng.")

    rt = str(ref_text or "").strip()
    
    # 🔧 FIX: Sử dụng cached voice clone prompt để đảm bảo tone giọng nhất quán
    # Thay vì truyền trực tiếp ref_audio/ref_text vào mỗi lần generate,
    # ta tạo và cache voice prompt một lần, sau đó tái sử dụng.
    voice_prompt = ensure_voice_clone_prompt(
        ref_audio=ref_audio_path,
        ref_text=rt,
        model_id=model_id,
        device_map=device_map,
        dtype_str=dtype_str,
    )

    # 🎲 Set seed cho deterministic output (nếu được chỉ định)
    if seed is not None:
        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)

    gen_kw: dict = dict(
        text=t,
        voice_clone_prompt=voice_prompt,
    )

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
            pass

    try:
        audio = model.generate(**gen_kw)
    except TypeError:
        # Fallback nếu version không hỗ trợ voice_clone_prompt parameter
        # hoặc không nhận language/generation_config
        try:
            # Thử với voice_clone_prompt đơn giản hơn
            slim_kw = {"text": t, "voice_clone_prompt": voice_prompt}
            audio = model.generate(**slim_kw)
        except TypeError:
            # Fallback cuối cùng: dùng ref_audio/ref_text trực tiếp (cách cũ, không ổn định)
            # ⚠️ WARNING: Cách này có thể gây tone giọng không nhất quán giữa các câu
            import warnings
            warnings.warn(
                "OmniVoice: Version này không hỗ trợ voice_clone_prompt. "
                "Đang sử dụng ref_audio trực tiếp - có thể gây tone giọng không ổn định. "
                "Nên update lên version mới hơn.",
                UserWarning,
            )
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
