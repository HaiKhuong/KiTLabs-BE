"""
VoxCPM2 TTS (openbmb/VoxCPM2) — voice clone ngang hàng OmniVoice trong video-pipeline.

Cài: pip install voxcpm
Tham khảo: https://huggingface.co/openbmb/VoxCPM2

⚠️ QUAN TRỌNG - VOICE CONSISTENCY:
- Module này sử dụng CACHING để đảm bảo tone giọng ổn định giữa các câu
- Voice clone prompt (build_prompt_cache) được tạo một lần và tái sử dụng cho tất cả các câu
- KHÔNG reset cache giữa các câu trong cùng một video để giữ tone giọng nhất quán
- Chỉ reset cache khi cần đổi giọng mẫu: reset_voxcpm2_session()

📝 CÁCH HOẠT ĐỘNG:
1. Lần đầu tiên gọi synthesize_to_wav() với ref_audio/ref_text:
   - Model được load và cache (theo model_id)
   - Prompt cache (VAE-encoded features) được tạo và cache (theo ref_audio path + ref_text)
2. Các lần gọi tiếp theo với cùng ref_audio/ref_text:
   - Tái sử dụng model + prompt_cache → _generate_with_prompt_cache
   - Đảm bảo tone giọng nhất quán (không encode lại ref mỗi câu)
3. Nếu đổi ref_audio hoặc ref_text:
   - Prompt cache tự động được tạo lại
   - Model vẫn được giữ nếu model_id không đổi

Clone mode mặc định: Ultimate Cloning
  prompt_wav_path + prompt_text + reference_wav_path (cùng file mẫu)
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Optional, Tuple

import pipeline_cache  # noqa: F401 — HF cache → tools/video-pipeline/cache

# Cache theo (model_id, load_denoiser, optimize)
_session_model: Optional[Any] = None
_session_model_key: Optional[Tuple[str, str, str]] = None
# Cache prompt theo (resolved ref_audio, ref_text)
_session_prompt: Optional[Any] = None
_session_prompt_key: Optional[Tuple[str, str]] = None

SUPPORTED_VOXCPM2_LANGUAGES = ("vietnamese", "english", "korean", "japanese")

_VOXCPM2_LANGUAGE_ALIASES: dict[str, str] = {
    "vietnamese": "vietnamese",
    "vi": "vietnamese",
    "vie": "vietnamese",
    "english": "english",
    "en": "english",
    "eng": "english",
    "korean": "korean",
    "ko": "korean",
    "kor": "korean",
    "japanese": "japanese",
    "ja": "japanese",
    "jpn": "japanese",
}


def resolve_voxcpm2_language(raw: str | None) -> str:
    """Chuẩn hóa language — bắt buộc truyền (pipeline giới hạn 4 ngôn ngữ)."""
    key = str(raw or "").strip().lower().replace("-", "_")
    if not key:
        supported = ", ".join(SUPPORTED_VOXCPM2_LANGUAGES)
        raise ValueError(f"voxcpm2: thiếu language (hỗ trợ: {supported})")
    resolved = _VOXCPM2_LANGUAGE_ALIASES.get(key)
    if not resolved:
        supported = ", ".join(SUPPORTED_VOXCPM2_LANGUAGES)
        raise ValueError(f"voxcpm2: language không hỗ trợ {raw!r} (hỗ trợ: {supported})")
    return resolved


def _resolve_hf_token() -> str:
    token = (
        os.getenv("HF_TOKEN")
        or os.getenv("HUGGINGFACE_HUB_TOKEN")
        or os.getenv("HUGGING_FACE_HUB_TOKEN")
        or ""
    )
    token = str(token).strip()
    if token:
        os.environ.setdefault("HF_TOKEN", token)
        os.environ.setdefault("HUGGINGFACE_HUB_TOKEN", token)
    return token


def reset_voxcpm2_session() -> None:
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


def prepare_voxcpm2_input_text(text: str, language: str | None = None) -> str:
    """Lexical (vi) → lowercase (vi) → chuẩn hóa dấu câu. VoxCPM2 tự nhận ngôn ngữ từ text."""
    lang = resolve_voxcpm2_language(language) if language else None
    if lang == "vietnamese":
        # Tái sử dụng rule lexical đã chốt với OmniVoice (vi).
        from omnivoice_tts import apply_omnivoice_lexical_replacements

        t = apply_omnivoice_lexical_replacements(text)
        t = t.lower()
    else:
        t = str(text or "").strip()
    return _normalize_tts_text_for_audio(t)


def _get_model(
    *,
    model_id: str,
    load_denoiser: bool = False,
    optimize: bool = False,
):
    global _session_model, _session_model_key
    try:
        from voxcpm import VoxCPM
    except ImportError as e:
        raise RuntimeError(
            "VoxCPM2: cần gói voxcpm (pip install voxcpm). "
            "Xem https://huggingface.co/openbmb/VoxCPM2"
        ) from e

    mid = str(model_id or "").strip() or "openbmb/VoxCPM2"
    den = "1" if load_denoiser else "0"
    opt = "1" if optimize else "0"
    key = (mid, den, opt)
    if _session_model is not None and _session_model_key == key:
        return _session_model

    global _session_prompt, _session_prompt_key
    _session_prompt = None
    _session_prompt_key = None

    _resolve_hf_token()
    # load_denoiser=False mặc định: giữ nguyên đặc trưng giọng mẫu, tránh ZipEnhancer 16k.
    # optimize=False mặc định: ổn định hơn trên Windows/WSL (torch.compile hay lỗi).
    _session_model = VoxCPM.from_pretrained(
        mid,
        load_denoiser=bool(load_denoiser),
        optimize=bool(optimize),
    )
    _session_model_key = key
    return _session_model


def ensure_voice_clone_prompt(
    *,
    ref_audio: str | Path,
    ref_text: str,
    model_id: str,
    load_denoiser: bool = False,
    optimize: bool = False,
) -> Any:
    """
    Tạo / cache prompt_cache từ file giọng mẫu + transcript (Ultimate Cloning).

    ⚠️ QUAN TRỌNG - VOICE CONSISTENCY:
    Đây là KEY để đảm bảo tone giọng nhất quán giữa các câu!

    build_prompt_cache encode VAE features một lần; mọi câu sau dùng
    _generate_with_prompt_cache với cùng cache → không encode lại ref mỗi lần
    (tránh drift / tone nhảy giữa các câu).

    Cache key: (resolved ref_audio path, ref_text)
    """
    global _session_prompt, _session_prompt_key
    ra = str(Path(ref_audio).resolve())
    if not Path(ra).is_file():
        raise FileNotFoundError(f"VoxCPM2: không tìm thấy ref_audio: {ra}")
    rt = str(ref_text or "").strip()
    if not rt:
        raise ValueError(
            "VoxCPM2: cần ref_text (transcript khớp giọng mẫu) cho Ultimate Cloning / prompt cache."
        )
    pk = (ra, rt)
    if _session_prompt is not None and _session_prompt_key == pk:
        return _session_prompt

    model = _get_model(
        model_id=model_id,
        load_denoiser=load_denoiser,
        optimize=optimize,
    )
    # Ultimate Cloning: cùng clip cho prompt + reference → similarity cao nhất.
    _session_prompt = model.tts_model.build_prompt_cache(
        prompt_text=rt,
        prompt_wav_path=ra,
        reference_wav_path=ra,
    )
    _session_prompt_key = pk
    return _session_prompt


def synthesize_to_wav(
    *,
    text: str,
    out_wav: str | Path,
    ref_audio: str | Path,
    ref_text: str,
    model_id: str = "openbmb/VoxCPM2",
    language: str | None = None,
    cfg_value: float = 2.0,
    inference_timesteps: int = 10,
    normalize: bool = False,
    load_denoiser: bool = False,
    optimize: bool = False,
    seed: Optional[int] = None,
    target_sample_rate: int = 24000,
) -> None:
    """
    Sinh một đoạn thoại, ghi WAV mono (mặc định resample về 24 kHz cho pipeline).

    Dùng cached model + build_prompt_cache khi ref_audio/ref_text/model không đổi.
    """
    try:
        import numpy as np
        import soundfile as sf
        import torch
    except ImportError as e:
        raise RuntimeError(
            "VoxCPM2: cần torch + soundfile để lưu WAV (pip install soundfile)."
        ) from e

    out = Path(out_wav)
    out.parent.mkdir(parents=True, exist_ok=True)

    model = _get_model(
        model_id=model_id,
        load_denoiser=load_denoiser,
        optimize=optimize,
    )
    ref_audio_path = str(Path(ref_audio).resolve())
    if not Path(ref_audio_path).is_file():
        raise FileNotFoundError(f"VoxCPM2: không tìm thấy ref_audio: {ref_audio_path}")

    resolved_language = resolve_voxcpm2_language(language)

    t = prepare_voxcpm2_input_text(text, resolved_language)
    if not t:
        raise ValueError("VoxCPM2: text rỗng.")

    rt = str(ref_text or "").strip()

    # 🔧 Cached prompt → tone nhất quán giữa các câu trong cùng video
    prompt_cache = ensure_voice_clone_prompt(
        ref_audio=ref_audio_path,
        ref_text=rt,
        model_id=model_id,
        load_denoiser=load_denoiser,
        optimize=optimize,
    )

    if seed is not None:
        torch.manual_seed(int(seed))
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(int(seed))

    target_text = t
    if normalize:
        # Chuẩn hóa số/ngày qua TextNormalizer của VoxCPM (lazy).
        if getattr(model, "text_normalizer", None) is None:
            try:
                from voxcpm.utils.text_normalize import TextNormalizer

                model.text_normalizer = TextNormalizer()
            except Exception:
                model.text_normalizer = None
        if model.text_normalizer is not None:
            target_text = model.text_normalizer.normalize(target_text)

    gen_kw: dict = dict(
        target_text=target_text,
        prompt_cache=prompt_cache,
        cfg_value=float(cfg_value),
        inference_timesteps=int(inference_timesteps),
        retry_badcase=True,
        streaming=False,
    )

    try:
        generate_result = model.tts_model._generate_with_prompt_cache(**gen_kw)
        waves = []
        for item in generate_result:
            if isinstance(item, (tuple, list)):
                wav = item[0]
            else:
                wav = item
            if hasattr(wav, "squeeze"):
                wav = wav.squeeze(0)
            if hasattr(wav, "detach"):
                wav = wav.detach().cpu().numpy()
            waves.append(np.asarray(wav, dtype=np.float32).reshape(-1))
        if not waves:
            raise RuntimeError("VoxCPM2: audio output rỗng.")
        wave_np = np.concatenate(waves) if len(waves) > 1 else waves[0]
    except TypeError:
        # Fallback: API public (rebuild cache mỗi lần — kém ổn định hơn)
        import warnings

        warnings.warn(
            "VoxCPM2: _generate_with_prompt_cache không khả dụng — fallback model.generate(). "
            "Tone giọng có thể kém ổn định hơn giữa các câu.",
            UserWarning,
        )
        wave_np = model.generate(
            text=target_text,
            prompt_wav_path=ref_audio_path,
            prompt_text=rt,
            reference_wav_path=ref_audio_path,
            cfg_value=float(cfg_value),
            inference_timesteps=int(inference_timesteps),
            normalize=False,
            denoise=False,
        )
        wave_np = np.asarray(wave_np, dtype=np.float32).reshape(-1)

    if wave_np.ndim == 0 or wave_np.size == 0:
        raise RuntimeError("VoxCPM2: audio output rỗng/không hợp lệ.")

    native_sr = int(getattr(model.tts_model, "sample_rate", 48000) or 48000)
    out_sr = int(target_sample_rate) if target_sample_rate and target_sample_rate > 0 else native_sr
    if out_sr != native_sr:
        try:
            import torchaudio

            tensor = torch.from_numpy(wave_np).unsqueeze(0)
            resampled = torchaudio.functional.resample(tensor, native_sr, out_sr)
            wave_np = resampled.squeeze(0).numpy().astype(np.float32)
        except Exception:
            # Giữ native SR nếu resample thất bại — ffmpeg Step3 vẫn ép 24k.
            out_sr = native_sr

    sf.write(str(out), wave_np, out_sr)
